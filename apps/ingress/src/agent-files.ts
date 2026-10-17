import {
  ACCESS_SOURCE,
  type Admission,
  type ChannelIdentity,
  type Verification,
} from "@kelpie/access";
import { isAgentId } from "@kelpie/config";
import type {
  AgentFilesContract,
  FetchSkillResult,
  FilesActor,
  SkillSourceInput,
} from "@kelpie/context-store/contract";

/**
 * The editor's routes into one agent's own files (ADR-0058 §2): `GET` and `PUT
 * /webchat/agents/<id>/files`, and `POST /webchat/agents/<id>/skills/fetch`.
 */
const FILES_PATH = /^\/webchat\/agents\/([^/]+)\/(files|skills\/fetch)$/;
export const isAgentFilesPath = (pathname: string) => FILES_PATH.test(pathname);

/** A Save's JSON: two files of 1 MiB each, escaped, fit. */
const MAX_SAVE_BODY = 4_500_000;
/** A GitHub address, an update's name, or a pasted SKILL.md of up to 1 MiB, escaped. */
const MAX_FETCH_JSON = 2_200_000;
/** A `.zip` or `.skill` file, as context-store takes it. */
const MAX_UPLOAD = 5_000_000;
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export interface AgentFilesDeps {
  authenticate(request: Request): Promise<Verification>;
  admit(identity: ChannelIdentity, agentId: string): Promise<Admission>;
  /** The agent's role as the Registry lists it, "" for one from before roles, null for none. */
  agentRole(agentId: string): Promise<string | null>;
  /** context-store's AgentFiles: one agent's own files, and nothing else of the vault. */
  files: AgentFilesContract;
}

const STATUS: Record<string, number> = {
  forbidden: 403,
  invalid_input: 400,
  vault_off: 503,
  unavailable: 503,
};

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const empty = (status: number) => new Response(null, { status, headers: HEADERS });

/**
 * The editor's reads and writes of an agent's own files, under #379's checks: the owner's Access
 * login, a request this page made (`Sec-Fetch-Site: same-origin`, and its `Origin` on a write, since
 * browsers send the Access cookie with any site's request), an agent the Registry lists that isn't
 * a subagent and that the Directory admits this login to as the owner. The body is read only then,
 * never past its limit, and context-store checks every change again.
 */
export async function handleAgentFiles(request: Request, deps: AgentFilesDeps): Promise<Response> {
  const verification = await deps.authenticate(request);
  if (!verification.ok) return empty(verification.reason === "not_configured" ? 404 : 403);
  const url = new URL(request.url);
  const write = request.method !== "GET";
  if (
    request.headers.get("sec-fetch-site") !== "same-origin" ||
    (write && request.headers.get("origin") !== url.origin)
  ) {
    return empty(403);
  }
  const matched = FILES_PATH.exec(url.pathname);
  const agentId = matched?.[1] ?? null;
  const route = matched?.[2];
  const allowed =
    (route === "files" && (request.method === "GET" || request.method === "PUT")) ||
    (route === "skills/fetch" && request.method === "POST");
  if (!matched || !allowed || !isAgentId(agentId)) return empty(404);
  const role = await deps.agentRole(agentId);
  // Subagents keep their soul and skills on their AgentHost, not in the vault (ADR-0036).
  if (role === null || role === "subagent") return empty(404);
  const type = request.headers.get("content-type")?.toLowerCase() ?? "";
  const json = type.startsWith("application/json");
  const archive = type.startsWith("application/zip") || type.startsWith("application/octet-stream");
  if (write && !json && !(route === "skills/fetch" && archive)) return empty(415);
  const admission = await deps.admit(
    { channel: ACCESS_SOURCE, channelUserId: verification.sub },
    agentId,
  );
  if (!admission.admitted || admission.role !== "owner") return empty(403);
  const actor: FilesActor = { userId: admission.userId, role: admission.role, via: "webchat" };
  try {
    if (request.method === "GET") return answer(await deps.files.files(actor, agentId));
    if (route === "files") {
      const body = await jsonBody(request, MAX_SAVE_BODY);
      if (body instanceof Response) return body;
      const changes = (body as { changes?: unknown } | null)?.changes;
      if (!Array.isArray(changes)) return empty(400);
      return answer(await deps.files.save(actor, agentId, changes));
    }
    const source = archive ? await archiveSource(request, url) : await jsonSource(request);
    if (source instanceof Response) return source;
    return fetched(await deps.files.fetchSkill(actor, agentId, source));
  } catch (error) {
    console.warn(
      "webchat: an agent's files weren't reached",
      error instanceof Error ? error.name : "",
    );
    return reply({ reason: "unavailable" }, 503);
  }
}

function answer(result: { ok: true } | { ok: false; reason: string }): Response {
  if (result.ok) return reply(result);
  return reply({ reason: result.reason }, STATUS[result.reason] ?? 503);
}

/** A skill that couldn't be staged says why, for the review card; a refusal of the request isn't one. */
function fetched(result: FetchSkillResult): Response {
  if (result.ok || !(result.reason in STATUS)) return reply(result, result.ok ? 200 : 422);
  return reply({ reason: result.reason }, STATUS[result.reason]);
}

async function jsonSource(request: Request): Promise<SkillSourceInput | Response> {
  const body = await jsonBody(request, MAX_FETCH_JSON);
  if (body instanceof Response) return body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return empty(400);
  const { github, text, update, ...rest } = body as Record<string, unknown>;
  const given = [github, text, update].filter((value) => value !== undefined);
  if (Object.keys(rest).length > 0 || given.length !== 1 || typeof given[0] !== "string") {
    return empty(400);
  }
  if (typeof github === "string") return { kind: "github", url: github };
  if (typeof text === "string") return { kind: "text", content: text };
  return { kind: "update", name: update as string };
}

/** An uploaded `.zip` or `.skill`: its bytes, and its name from `?name=`. */
async function archiveSource(request: Request, url: URL): Promise<SkillSourceInput | Response> {
  const filename = url.searchParams.get("name") ?? "";
  if (filename.length === 0 || filename.length > 200) return empty(400);
  const bytes = await bounded(request, MAX_UPLOAD);
  if (bytes === null) return empty(413);
  return { kind: "archive", filename, bytes };
}

async function jsonBody(request: Request, most: number): Promise<unknown | Response> {
  const bytes = await bounded(request, most);
  if (bytes === null) return empty(413);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return empty(400);
  }
}

/**
 * The body's bytes, or null past `most`: it stops reading there, whatever the request says its
 * length is, or when it says none.
 */
export async function bounded(request: Request, most: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") ?? 0) > most) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > most) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
