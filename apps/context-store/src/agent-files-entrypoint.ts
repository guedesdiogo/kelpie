import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AgentFileChange,
  AgentFilesContract,
  AgentFilesResult,
  FetchSkillResult,
  FilesActor,
  SaveAgentFilesResult,
  SkillOrigin,
  SkillSourceInput,
} from "./contract.ts";
import {
  fetchArchive,
  GitHubFetchError,
  type GitHubSource,
  parseGitHubAddress,
  resolveAddress,
  resolveRef,
} from "./github-skill.ts";
import { isAgentId } from "./paths.ts";
import {
  isSpecSkillName,
  type ParsedSkill,
  type SkillProblem,
  skillFromEntries,
  skillFromText,
} from "./skills.ts";
import { VAULT_NAME, type VaultEnv } from "./vault.ts";
import { readZip, ZipError } from "./zip.ts";

/** A `.zip` or `.skill` file the owner uploads, at most. */
export const MAX_UPLOAD_BYTES = 5_000_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
let fetchForTesting: Fetch | undefined;

/** Tests answer GitHub's hosts with this. Production never calls it. */
export function replaceFetchForTesting(fetcher: Fetch | undefined): void {
  fetchForTesting = fetcher;
}

/** The owner, as ingress passes the Directory's admission; anything else is refused. */
const isOwner = (actor: unknown): actor is FilesActor =>
  typeof actor === "object" &&
  actor !== null &&
  typeof (actor as FilesActor).userId === "string" &&
  (actor as FilesActor).role === "owner" &&
  typeof (actor as FilesActor).via === "string";

const forbidden = { ok: false, reason: "forbidden" } as const;
const invalid = { ok: false, reason: "invalid_input" } as const;

/**
 * The owner's edits of one agent's own files from the webchat (ADR-0058 §2), for ingress alone. The
 * shape is the control: these files of one agent are all it reaches. The actor is ingress's word,
 * so the owner check catches a mistake in ingress, not a compromised one. A skill is fetched and
 * checked here, outside the Vault object, and only its files reach it, staged for the review.
 */
export class AgentFiles extends WorkerEntrypoint<VaultEnv> implements AgentFilesContract {
  #vault() {
    return this.env.VAULT.getByName(VAULT_NAME);
  }

  async files(actor: FilesActor, agentId: string): Promise<AgentFilesResult> {
    if (!isOwner(actor)) return forbidden;
    return this.#vault().agentFiles(agentId);
  }

  async save(
    actor: FilesActor,
    agentId: string,
    changes: AgentFileChange[],
  ): Promise<SaveAgentFilesResult> {
    if (!isOwner(actor)) return forbidden;
    return this.#vault().saveAgentFiles(agentId, changes);
  }

  async fetchSkill(
    actor: FilesActor,
    agentId: string,
    source: SkillSourceInput,
  ): Promise<FetchSkillResult> {
    if (!isOwner(actor)) return forbidden;
    if (!isAgentId(agentId) || typeof source !== "object" || source === null) return invalid;
    const vault = this.#vault();
    if (!(await vault.isOn())) return { ok: false, reason: "vault_off" };
    const fetcher: Fetch = fetchForTesting ?? ((input, init) => fetch(input, init));
    let found: { skill: ParsedSkill; origin: SkillOrigin } | { problem: FetchSkillResult };
    try {
      found = await this.#find(vault, agentId, source, fetcher);
    } catch (error) {
      if (error instanceof GitHubFetchError) return { ok: false, reason: error.reason };
      if (error instanceof ZipError) {
        return { ok: false, reason: error.reason === "unsupported" ? "too_large" : "not_zip" };
      }
      console.error(
        "AgentFiles: a skill couldn't be fetched",
        error instanceof Error ? error.name : "",
      );
      return { ok: false, reason: "unavailable" };
    }
    if ("problem" in found) return found.problem;
    return vault.stageSkill(agentId, found.skill, found.origin);
  }

  async #find(
    vault: ReturnType<AgentFiles["env"]["VAULT"]["getByName"]>,
    agentId: string,
    source: SkillSourceInput,
    fetcher: Fetch,
  ): Promise<{ skill: ParsedSkill; origin: SkillOrigin } | { problem: FetchSkillResult }> {
    switch (source.kind) {
      case "github": {
        const address = typeof source.url === "string" ? parseGitHubAddress(source.url) : null;
        if (!address) return { problem: { ok: false, reason: "invalid_address" } };
        return fromGitHub(await resolveAddress(address, fetcher), fetcher);
      }
      case "update": {
        if (!isSpecSkillName(source.name)) return { problem: invalid };
        const origin = await vault.skillOrigin(agentId, source.name);
        if (origin?.kind !== "github") return { problem: { ok: false, reason: "no_source" } };
        const commit = await resolveRef(origin, fetcher);
        if (commit === origin.commit) return { problem: { ok: false, reason: "up_to_date" } };
        return fromGitHub({ ...origin, commit }, fetcher);
      }
      case "archive": {
        const { filename, bytes } = source;
        if (
          typeof filename !== "string" ||
          !/^[^/\\\p{Cc}\p{Cf}]{1,200}\.(?:zip|skill)$/iu.test(filename) ||
          !(bytes instanceof Uint8Array)
        ) {
          return { problem: invalid };
        }
        if (bytes.byteLength > MAX_UPLOAD_BYTES)
          return { problem: { ok: false, reason: "too_large" } };
        const parsed = await skillFromEntries(readZip(bytes), "");
        return parsed.ok
          ? { skill: parsed.skill, origin: { kind: "archive", filename } }
          : { problem: refusal(parsed.problem) };
      }
      case "text": {
        if (typeof source.content !== "string") return { problem: invalid };
        const parsed = skillFromText(source.content);
        return parsed.ok
          ? { skill: parsed.skill, origin: { kind: "text" } }
          : { problem: refusal(parsed.problem) };
      }
      default:
        return { problem: invalid };
    }
  }
}

/** The skill in a repository's folder at a commit, from its archive. */
async function fromGitHub(
  source: GitHubSource,
  fetcher: Fetch,
): Promise<{ skill: ParsedSkill; origin: SkillOrigin } | { problem: FetchSkillResult }> {
  const entries = readZip(await fetchArchive(source, fetcher));
  // codeload names its one top folder `<repo>-<commit>/`.
  const top = entries[0]?.path.split("/")[0];
  if (!top) return { problem: { ok: false, reason: "no_skill" } };
  const base = `${top}/${source.path === "" ? "" : `${source.path}/`}`;
  const folder = source.path === "" ? null : (source.path.split("/").at(-1) ?? null);
  const parsed = await skillFromEntries(entries, base, folder);
  if (!parsed.ok) return { problem: refusal(parsed.problem) };
  const { owner, repo, ref, path, commit } = source;
  return { skill: parsed.skill, origin: { kind: "github", owner, repo, ref, path, commit } };
}

function refusal(problem: SkillProblem): FetchSkillResult {
  switch (problem.reason) {
    case "many_skills":
      return { ok: false, reason: "many_skills", names: problem.names };
    case "unsafe_path":
    case "link":
      return { ok: false, reason: problem.reason, detail: problem.path };
    case "too_large":
      return { ok: false, reason: "too_large", ...(problem.path ? { detail: problem.path } : {}) };
    case "invalid_skill":
      return { ok: false, reason: "invalid_skill", detail: problem.problem };
    default:
      return { ok: false, reason: problem.reason };
  }
}
