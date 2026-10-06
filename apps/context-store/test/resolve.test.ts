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
import { resolveConflict } from "../src/resolve.ts";

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

/**
 * A gateway whose model answers each resolution with the next of `answers`, or fails. `meanwhile`
 * runs while it answers, as an owner's push could.
 */
function fakeModel(answers: (string | Error)[], meanwhile?: () => void) {
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
      meanwhile?.();
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

/** Lets the next try at a held file come, as if its wait had passed. */
async function later(stub: ReturnType<typeof vault>) {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE state SET value = '0' WHERE key = 'resolve_after'");
  });
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
    const resolved = "# Ana\n\nMora no Porto.\nMora em Braga.\n\nGosta de café.\n";
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

  it("keeps a note held when the model fails, writes its own lines or breaks the frontmatter", async () => {
    const backend = vaultWith({ "memory/people/ana.md": `---\nkind: person\n---\n${base}` });
    const stub = vault("resolve-fails");
    await stub.compile("kelpie");
    const pushed = [
      "---",
      "<<<<<<< HEAD",
      "kind: person",
      "=======",
      "kind: note",
      ">>>>>>> main",
      "---",
      base,
    ].join("\n");
    const requests = fakeModel([
      new Error("the model is down"),
      // A line of its own: it could pin the note, or say anything.
      `---\nkind: person\npinned: true\n---\n${base}`,
      // Both sides' lines: the key twice.
      `---\nkind: person\nkind: note\n---\n${base}`,
    ]);
    backend.push({ "memory/people/ana.md": pushed });

    await runDurableObjectAlarm(stub);
    // Tries are spaced: another wake-up right away doesn't try again.
    await runDurableObjectAlarm(stub);
    expect(requests).toHaveLength(1);
    for (let run = 0; run < 4; run += 1) {
      await later(stub);
      await runDurableObjectAlarm(stub);
    }
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
    const resolved = `${persona}a\n`;
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

  it("shows a held note as it was before, and never commits the markers", async () => {
    const backend = vaultWith({ "memory/people/ana.md": base });
    const stub = vault("resolve-visible");
    await stub.compile("kelpie");
    const pushed = marked("Mora no Porto.", "Mora em Braga.");
    // The model keeps the side the vault already had.
    const requests = fakeModel(["# Ana\n\nMora em Lisboa.\n\nGosta de café.\n"]);
    replaceGatewayForTesting(null);
    backend.push({ "memory/people/ana.md": pushed });
    await runDurableObjectAlarm(stub);

    // Reads and recall see the version before the conflict.
    expect(await stub.read("memory/people/ana.md")).toBe(base);
    const recalled = await stub.recall("kelpie", "Onde a Ana mora?", {
      scopes: "all",
      budgetTokens: 1_000,
    });
    expect(recalled.text).not.toContain("<<<<<<<");
    // An agent's write, made on what it read.
    const added = `${base}\nTem um gato.\n`;
    await stub.write("kelpie", [{ path: "memory/people/ana.md", content: added }], "x");

    fakeModel(["# Ana\n\nMora no Porto.\n\nGosta de café.\n"]);
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    const committed = backend.files()["memory/people/ana.md"] ?? "";
    expect(committed).toBe("# Ana\n\nMora no Porto.\n\nGosta de café.\n\nTem um gato.\n");
    expect(requests).toHaveLength(0);
  });

  it("keeps the version from before the first conflict when another one is pushed", async () => {
    const backend = vaultWith({ "memory/people/ana.md": base });
    const stub = vault("resolve-again");
    await stub.compile("kelpie");
    fakeModel(["# Ana\n\nMora no Porto.\n\nGosta de café.\n"]);
    backend.push({ "memory/people/ana.md": marked("Mora no Porto.", "Mora em Braga.") });
    // The resolution is queued in this run, and commits in the next.
    await runDurableObjectAlarm(stub);
    backend.push({ "memory/people/ana.md": marked("Mora em Faro.", "Mora em Braga.") });
    await runDurableObjectAlarm(stub);
    expect(await rows(stub, "SELECT previous, state FROM held")).toEqual([
      { previous: base, state: "held" },
    ]);
  });

  it("merges a write queued before a hold against the version from before it", async () => {
    const backend = vaultWith({ "memory/people/ana.md": base });
    const stub = vault("resolve-base");
    await stub.compile("kelpie");
    replaceGatewayForTesting(null);
    const kelpie = base.replace("Mora em Lisboa.", "Mora em Lisboa, perto do rio.");
    await stub.write("kelpie", [{ path: "memory/people/ana.md", content: kelpie }], "x");
    backend.push({ "memory/people/ana.md": marked("Mora em Lisboa.", "Mora em Braga.") });
    await runDurableObjectAlarm(stub);
    // The owner keeps the line as it was, and changes another.
    backend.push({ "memory/people/ana.md": base.replace("café", "chá") });
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/people/ana.md"]).toBe(kelpie.replace("café", "chá"));
  });

  it("wakes for a file it can try, and doesn't spin for one it can't", async () => {
    const backend = vaultWith({ "notes/x.md": "# X\n", "memory/people/ana.md": base });
    const stub = vault("resolve-wake");
    await stub.compile("kelpie");
    const requests = fakeModel([new Error("the model is down")]);
    // `notes/` is no agent's to write, so the model never gets it.
    backend.push({ "notes/x.md": "# X\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n" });
    await runDurableObjectAlarm(stub);
    const alarm = () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(requests).toHaveLength(0);
    expect(await alarm()).toBeGreaterThan(Date.now() + 60_000);

    backend.push({ "memory/people/ana.md": marked("Mora no Porto.", "Mora em Braga.") });
    await runDurableObjectAlarm(stub);
    expect(requests).toHaveLength(1);
    // The next try is a few minutes away, and the alarm wakes for it.
    const next = (await alarm()) ?? 0;
    expect(next).toBeGreaterThan(Date.now() + 60_000);
    expect(next).toBeLessThan(Date.now() + 6 * 60_000);
  });

  it("shows a held skill as it was before, and takes no marked file as the version before", async () => {
    const skill = "---\nname: recipes\ndescription: Finds recipes.\n---\n# Recipes\n";
    const backend = vaultWith({ "agents/kelpie/skills/recipes/SKILL.md": skill });
    const stub = vault("resolve-skill");
    replaceGatewayForTesting(null);
    await stub.compile("kelpie");
    backend.push({
      "agents/kelpie/skills/recipes/SKILL.md":
        "---\nname: recipes\n<<<<<<< HEAD\ndescription: Finds recipes fast.\n=======\ndescription: Cooks.\n>>>>>>> main\n---\n# Recipes\n",
    });
    await runDurableObjectAlarm(stub);
    expect((await stub.compile("kelpie")).skills).toEqual([
      {
        name: "recipes",
        description: "Finds recipes.",
        path: "agents/kelpie/skills/recipes/SKILL.md",
      },
    ]);

    // A file Kelpie itself left marked, then pushed marked again: no version before is known.
    await stub.write("kelpie", [{ path: "memory/people/bia.md", content: marked("a", "b") }], "x");
    await runDurableObjectAlarm(stub);
    backend.push({ "memory/people/bia.md": marked("c", "d") });
    await runDurableObjectAlarm(stub);
    expect(
      await rows(stub, "SELECT previous FROM held WHERE path = 'memory/people/bia.md'"),
    ).toEqual([{ previous: null }]);
  });

  it("gives the model the vault's rules up to their limit, and a previous version that fits", async () => {
    const huge = `# Ana\n\n${"Mora em Lisboa. ".repeat(4_000)}\n`;
    const backend = vaultWith({
      "AGENTS.md": `# Regras\n\nComeço das regras.\n${"x".repeat(9_000)}\nFim das regras.\n`,
      "memory/people/ana.md": huge,
    });
    const stub = vault("resolve-limits");
    await stub.compile("kelpie");
    const requests = fakeModel([new Error("the model is down")]);
    backend.push({ "memory/people/ana.md": marked("Mora no Porto.", "Mora em Braga.") });
    await runDurableObjectAlarm(stub);
    const asked = JSON.stringify(requests[0]?.request.messages);
    expect(asked).toContain("Começo das regras.");
    expect(asked).not.toContain("Fim das regras.");
    // The version before is too large to send; the conflict's own sides remain.
    expect(asked).not.toContain("Mora em Lisboa. Mora em Lisboa.");
  });

  it("never commits a write that would put markers back", async () => {
    const backend = vaultWith({ "memory/people/ana.md": base });
    const stub = vault("resolve-no-markers");
    await stub.compile("kelpie");
    // A write that holds a conflict block of its own.
    const block = "<<<<<<< HEAD\nMora no Porto.\n=======\nMora em Braga.\n>>>>>>> main\n";
    await stub.write(
      "kelpie",
      [{ path: "memory/people/ana.md", content: `${base}\n${block}` }],
      "x",
    );
    // The owner's edit is far from it, so the two would merge cleanly.
    backend.push({ "memory/people/ana.md": base.replace("Lisboa", "Porto") });
    replaceGatewayForTesting(null);
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/people/ana.md"]).toBe(base.replace("Lisboa", "Porto"));
    expect(await rows(stub, "SELECT path, reason FROM conflicts")).toEqual([
      { path: "memory/people/ana.md", reason: "owner_won" },
    ]);
  });

  it("applies nothing when the owner fixed the file while the model answered", async () => {
    const persona = "# Kelpie\n\nFala português.\n";
    const backend = vaultWith({
      "agents/kelpie/SOUL.md": persona,
      "memory/people/ana.md": base,
    });
    const stub = vault("resolve-stale");
    await stub.compile("kelpie");
    const conflict = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n";
    backend.push({
      "agents/kelpie/SOUL.md": `${persona}${conflict}`,
      "memory/people/ana.md": marked("Mora no Porto.", "Mora em Braga."),
    });
    // Each answer arrives after the owner pushed a clean version of every file, other than it.
    const fixed = { "agents/kelpie/SOUL.md": `${persona}b\n`, "memory/people/ana.md": base };
    fakeModel([`${persona}a\n`, "# Ana\n\nMora no Porto.\n\nGosta de café.\n"], () => {
      backend.push(fixed);
    });
    await runDurableObjectAlarm(stub);
    await later(stub);
    await runDurableObjectAlarm(stub);

    expect(backend.pullRequests).toEqual([]);
    expect(backend.files()).toMatchObject(fixed);
    expect(await stub.held()).toEqual([]);
  });

  it("writes a held note in an agent's own folder as that agent, and proposes its rules", async () => {
    const backend = vaultWith({
      "agents/kelpie/memory/diario.md": "# Diário\n",
      "agents/kelpie/AGENTS.md": "# Regras\n",
      "AGENTS.md": "# Regras do vault\n\nEscreva em português.\n",
    });
    const stub = vault("resolve-routes");
    await stub.compile("kelpie");
    const conflict = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n";
    // The rules file sorts first, so it is tried first.
    const requests = fakeModel(["# Regras\nb\n", "# Diário\na\n"]);
    backend.push({
      "agents/kelpie/memory/diario.md": `# Diário\n${conflict}`,
      "agents/kelpie/AGENTS.md": `# Regras\n${conflict}`,
    });
    await runDurableObjectAlarm(stub);
    await later(stub);
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);

    expect(backend.files()["agents/kelpie/memory/diario.md"]).toBe("# Diário\na\n");
    const commit = backend.commitRequests.find((request) =>
      request.writes.some((write) => write.path === "agents/kelpie/memory/diario.md"),
    );
    expect(commit?.body).toContain("Kelpie-Agent: kelpie");
    const [pull] = backend.pullRequests;
    expect(pull?.title).toBe("Propose rules for kelpie");
    expect(backend.files(pull?.branch)["agents/kelpie/AGENTS.md"]).toBe("# Regras\nb\n");
    // The vault's own rules go to the model with the conflict.
    expect(JSON.stringify(requests[0]?.request.messages)).toContain("Escreva em português.");
  });
});

describe("resolveConflict", () => {
  const conflicted =
    "# Ana\n\n<<<<<<< HEAD\nMora no Porto.\n=======\nMora em Braga.\n>>>>>>> main\n";
  const file = { path: "memory/people/ana.md", marked: conflicted, previous: null, rules: "" };

  /** A gateway answering once, with `answer` and the finish reason given. */
  function answering(answer: string, reason: "stop" | "length" = "stop") {
    let cancelled = 0;
    const gateway: Pick<MemoryGateway, "generate"> = {
      async generate() {
        async function* events(): AsyncIterable<LlmEvent> {
          yield {
            type: "finish",
            reason,
            message: { role: "assistant", parts: [{ type: "text", text: answer }] },
            usage: [],
          };
        }
        return {
          events: async () => toNdjsonStream(events(), () => {}),
          cancel: async () => {
            cancelled += 1;
          },
        };
      },
    };
    return { gateway, cancelled: () => cancelled };
  }

  it("takes a resolution, even inside a code fence", async () => {
    const resolved = "# Ana\n\nMora no Porto.\n";
    expect(await resolveConflict(answering(resolved).gateway, file, 1_000)).toBe(resolved);
    expect(
      await resolveConflict(
        answering(`\`\`\`markdown\n# Ana\n\nMora no Porto.\n\`\`\``).gateway,
        file,
        1_000,
      ),
    ).toBe(resolved);
  });

  it.each([
    ["an empty answer", " \n"],
    ["a marker line left", "# Ana\n\n>>>>>>> main\nMora no Porto.\n"],
    ["dropped frontmatter", "# Ana\n\nMora no Porto.\n", "---\nkind: person\n---\n"],
  ])("refuses %s", async (_name, answer, frontmatter = "") => {
    const withFrontmatter = { ...file, marked: `${frontmatter}${conflicted}` };
    expect(await resolveConflict(answering(answer).gateway, withFrontmatter, 1_000)).toBeNull();
  });

  it("ends a resolution as the file ends, whatever the model ended with", async () => {
    expect(await resolveConflict(answering("# Ana\n\nMora no Porto.").gateway, file, 1_000)).toBe(
      "# Ana\n\nMora no Porto.\n",
    );
    const open = { ...file, marked: conflicted.trimEnd() };
    expect(
      await resolveConflict(answering("# Ana\n\nMora no Porto.\n\n").gateway, open, 1_000),
    ).toBe("# Ana\n\nMora no Porto.");
  });

  it("refuses an answer cut short by its token limit", async () => {
    const cut = answering("# Ana\n\nMora no Porto.\n", "length");
    await expect(resolveConflict(cut.gateway, file, 1_000)).rejects.toThrow("no complete answer");
  });

  it("stops a model that doesn't answer in time", async () => {
    let cancelled = 0;
    const gateway: Pick<MemoryGateway, "generate"> = {
      async generate() {
        return {
          events: async () => new ReadableStream<Uint8Array>(),
          cancel: async () => {
            cancelled += 1;
          },
        };
      },
    };
    await expect(resolveConflict(gateway, file, 20)).rejects.toThrow("no answer after 20 ms");
    expect(cancelled).toBe(1);
  });
});
