import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type LlmEvent, type RoutedRequest, toNdjsonStream } from "@kelpie/llm";
import { FakeVaultBackend } from "@kelpie/vault/fake";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MemoryGateway,
  replaceBackendForTesting,
  replaceGatewayForTesting,
} from "../src/index.ts";

afterEach(() => {
  replaceBackendForTesting(undefined);
  replaceGatewayForTesting(undefined);
});

function vaultWith(files: Record<string, string>): FakeVaultBackend {
  const backend = new FakeVaultBackend({ "README.md": "# Vault", ...files });
  replaceBackendForTesting(backend);
  return backend;
}

const vault = (name: string) => env.VAULT.getByName(name);

/** A file as a device committed it, with a conflict left in. */
function marked(mine: string, theirs: string, frontmatter = ""): string {
  return [
    `${frontmatter}# Ana`,
    "",
    "<<<<<<< HEAD",
    mine,
    "=======",
    theirs,
    ">>>>>>> origin/main",
    "",
    "Gosta de café.",
    "",
  ].join("\n");
}

/** A gateway whose model answers each resolution with the next of `answers`, or fails. */
function fakeModel(answers: (string | Error)[]) {
  const requests: { tier: string; request: RoutedRequest }[] = [];
  const gateway: MemoryGateway = {
    async embed() {
      return { ok: false, reason: "failed" };
    },
    async qualify() {
      return { ok: false, reason: "failed" };
    },
    async generate(tier, request) {
      requests.push({ tier, request });
      const answer = answers.shift() ?? new Error("no answer left");
      async function* events(): AsyncIterable<LlmEvent> {
        if (answer instanceof Error) throw answer;
        yield { type: "text", delta: answer };
        yield {
          type: "finish",
          reason: "stop",
          message: { role: "assistant", parts: [{ type: "text", text: answer }] },
          usage: [],
        };
      }
      return {
        events: async () => toNdjsonStream(events(), () => {}),
        cancel: async () => {},
      };
    },
  };
  replaceGatewayForTesting(gateway);
  return requests;
}

async function rows(stub: ReturnType<typeof vault>, sql: string) {
  return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec(sql).toArray());
}

describe("Vault conflict resolution", () => {
  const base = "# Ana\n\nMora em Lisboa.\n\nGosta de café.\n";

  it("resolves a held note with the model, under Kelpie's queued write, and keeps the push", async () => {
    const backend = vaultWith({ "memory/people/ana.md": base });
    const stub = vault("resolve-note");
    await stub.compile("kelpie");
    await stub.write(
      "kelpie",
      [{ path: "memory/people/ana.md", content: base.replace("café", "chá") }],
      "x",
    );
    const resolved = "# Ana\n\nMora no Porto, antes em Braga.\n\nGosta de café.\n";
    const requests = fakeModel([resolved]);
    const pushed = marked("Mora no Porto.", "Mora em Braga.");
    backend.push({ "memory/people/ana.md": pushed });

    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    // The resolution, with Kelpie's own change on a line the conflict didn't touch.
    expect(backend.files()["memory/people/ana.md"]).toBe(resolved.replace("café", "chá"));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tier).toBe("medium");
    const asked = JSON.stringify(requests[0]?.request.messages);
    expect(asked).toContain("Mora em Lisboa.");
    expect(asked).toContain("<<<<<<< HEAD");
    expect(await rows(stub, "SELECT path, content, state FROM held")).toEqual([
      { path: "memory/people/ana.md", content: pushed, state: "resolved" },
    ]);
  });

  it("keeps a note held when the model fails, leaves markers or breaks the frontmatter", async () => {
    const frontmatter = "---\nkind: person\n---\n";
    const backend = vaultWith({ "memory/people/ana.md": `${frontmatter}${base}` });
    const stub = vault("resolve-fails");
    await stub.compile("kelpie");
    const pushed = marked("Mora no Porto.", "Mora em Braga.", frontmatter);
    const requests = fakeModel([
      new Error("the model is down"),
      pushed,
      "---\nkind: [person\n---\n# Ana\n",
    ]);
    backend.push({ "memory/people/ana.md": pushed });

    for (let run = 0; run < 5; run += 1) await runDurableObjectAlarm(stub);
    // Three tries, then it waits for the owner, who sees it in the list.
    expect(requests).toHaveLength(3);
    expect(backend.files()["memory/people/ana.md"]).toBe(pushed);
    expect(await stub.held()).toEqual([
      { path: "memory/people/ana.md", state: "held", attempts: 3, at: expect.any(Number) },
    ]);
  });

  it("proposes a resolved persona as a pull request, and leaves other files held", async () => {
    const persona = "# Kelpie\n\nFala português.\n";
    const big = `# Diário\n\n${"Um dia comum. ".repeat(4_000)}\n`;
    const backend = vaultWith({
      "agents/kelpie/SOUL.md": persona,
      "skills/recipes/SKILL.md": "# Recipes\n",
      "memory/notes/diario.md": big,
    });
    const stub = vault("resolve-persona");
    await stub.compile("kelpie");
    const resolved = "# Kelpie\n\nFala português e inglês.\n";
    const requests = fakeModel([resolved]);
    const conflict = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n";
    backend.push({
      "agents/kelpie/SOUL.md": `${persona}${conflict}`,
      "skills/recipes/SKILL.md": `# Recipes\n${conflict}`,
      // Too large for the model to write back whole.
      "memory/notes/diario.md": `${big}${conflict}`,
    });

    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    // Persona changes wait for the owner's review until per-item approval exists (#113).
    expect(requests).toHaveLength(1);
    const [pull] = backend.pullRequests;
    expect(backend.files(pull?.branch)["agents/kelpie/SOUL.md"]).toBe(resolved);
    expect(backend.files()["agents/kelpie/SOUL.md"]).toBe(`${persona}${conflict}`);
    expect(await rows(stub, "SELECT path, state, attempts FROM held ORDER BY path")).toEqual([
      { path: "agents/kelpie/SOUL.md", state: "proposed", attempts: 1 },
      { path: "memory/notes/diario.md", state: "held", attempts: 0 },
      { path: "skills/recipes/SKILL.md", state: "held", attempts: 0 },
    ]);
  });
});
