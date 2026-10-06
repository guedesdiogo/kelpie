import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type MemoryInput, memoryPath, writeMemory } from "@kelpie/memory";
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

const vault = (name: string) => env.VAULT.getByName(name);

const person = (title: string, body: string, scope: MemoryInput["scope"] = "global") =>
  ({
    scope,
    kind: "person",
    title,
    body,
    level: "explicit",
    confidence: 0.9,
    entities: [title],
  }) satisfies MemoryInput;

/** A vault holding these memories, written as Kelpie writes them. */
async function vaultOf(memories: readonly MemoryInput[]): Promise<FakeVaultBackend> {
  const files: Record<string, string> = { "README.md": "# Vault" };
  for (const memory of memories) {
    files[memoryPath(memory.scope, memory.kind, memory.title)] = (
      await writeMemory(memory, { at: "2026-10-01T00:00:00Z" })
    ).text;
  }
  const backend = new FakeVaultBackend(files);
  replaceBackendForTesting(backend);
  return backend;
}

/** A gateway whose vectors put "Porto" notes near questions about moving, and whose judge likes Ana. */
function fakeGateway(
  options: {
    failEmbed?: boolean;
    throwEmbed?: boolean;
    failQualify?: boolean;
    hangQualify?: boolean;
    model?: string;
  } = {},
) {
  const calls = {
    embed: 0,
    qualify: 0,
    backends: [] as (string | undefined)[],
    models: [] as string[],
    texts: [] as string[],
  };
  const vectorOf = (text: string) => [/porto|mudou|mudança/i.test(text) ? 1 : 0, 0.1];
  const gateway: MemoryGateway = {
    async generate() {
      throw new Error("recall never generates");
    },
    async embed(texts) {
      calls.embed += 1;
      calls.texts.push(...texts);
      if (options.throwEmbed) throw new Error("llm-gateway is down");
      if (options.failEmbed) return { ok: false, reason: "failed" };
      const model = options.model ?? "fake-model";
      calls.models.push(model);
      return { ok: true, model, vectors: texts.map(vectorOf) };
    },
    async qualify(state, questions, backend) {
      calls.qualify += 1;
      calls.backends.push(backend);
      if (options.hangQualify) return new Promise(() => {});
      if (options.failQualify) return { ok: false, reason: "failed" };
      const notes = (state as { notes: Record<string, string> }).notes;
      return {
        ok: true,
        result: {
          provider: "fake",
          calibrated: false,
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: "noul", noul: notes[id]?.includes("Ana") ? 0.95 : 0.05 },
            ]),
          ),
        },
      };
    },
  };
  replaceGatewayForTesting(gateway);
  return calls;
}

/** The head the index was last brought to, and the vault's head: equal when it is current. */
async function indexedHead(stub: ReturnType<typeof vault>) {
  return runInDurableObject(stub, (_instance, state) => {
    const value = (key: string) =>
      state.storage.sql
        .exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key)
        .toArray()[0]?.value;
    return { index: value("index_head"), head: value("head") };
  });
}

/** The vault's state rows that hold GitHub's backoff. */
async function backoffOf(stub: ReturnType<typeof vault>) {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ key: string; value: string }>(
        "SELECT key, value FROM state WHERE key IN ('failures', 'retry_at') ORDER BY key",
      )
      .toArray(),
  );
}

const ALL = { scopes: "all" as const, budgetTokens: 1_000 };

describe("recall", () => {
  it("answers an empty block while the vault is off", async () => {
    replaceBackendForTesting(null);
    fakeGateway();
    expect(await vault("recall-off").recall("kelpie", "Onde a Ana mora?", ALL)).toEqual({
      text: "",
      tokens: 0,
      paths: [],
    });
  });

  it("finds synced notes and Kelpie's own writes, and forgets removed ones", async () => {
    const backend = await vaultOf([person("Ana Souza", "Irmã do Rafael. Mora em Lisboa.")]);
    fakeGateway();
    const stub = vault("recall-sync");
    const first = await stub.recall("kelpie", "Onde a Ana Souza mora?", ALL);
    expect(first.paths).toEqual([memoryPath("global", "person", "Ana Souza")]);
    expect(first.text).toContain("Mora em Lisboa.");

    const bruno = person("Bruno Lima", "Sócio do Rafael na consultoria.");
    const brunoPath = memoryPath("global", "person", "Bruno Lima");
    await stub.write(
      "kelpie",
      [
        {
          path: brunoPath,
          content: (await writeMemory(bruno, { at: "2026-10-02T00:00:00Z" })).text,
        },
      ],
      "Remember Bruno",
    );
    await runDurableObjectAlarm(stub);
    // Kelpie's own commit moved the index along, before any recall.
    let at = await indexedHead(stub);
    expect(at.index).toBe(at.head);
    expect((await stub.recall("kelpie", "Quem é o sócio do Rafael?", ALL)).paths).toContain(
      brunoPath,
    );

    backend.push({ [brunoPath]: null });
    await stub.requestSync("refs/heads/main");
    await runDurableObjectAlarm(stub);
    at = await indexedHead(stub);
    expect(at.index).toBe(at.head);
    expect((await stub.recall("kelpie", "Quem é o sócio do Rafael?", ALL)).paths).not.toContain(
      brunoPath,
    );
  });

  it("moves the index along with each sync and commit, without a catch-up", async () => {
    // Without llm-gateway the alarm never catches the index up, so only the moves themselves can.
    const backend = await vaultOf([person("Ana Souza", "Irmã do Rafael.")]);
    replaceGatewayForTesting(null);
    const stub = vault("recall-moves");
    await stub.recall("kelpie", "Ana Souza", ALL);
    const bruno = person("Bruno Lima", "Sócio do Rafael.");
    await stub.write(
      "kelpie",
      [
        {
          path: memoryPath("global", "person", "Bruno Lima"),
          content: (await writeMemory(bruno, { at: "2026-10-02T00:00:00Z" })).text,
        },
      ],
      "Remember Bruno",
    );
    await runDurableObjectAlarm(stub);
    let at = await indexedHead(stub);
    expect(at.index).toBe(at.head);
    backend.push({ [memoryPath("global", "person", "Ana Souza")]: null });
    await stub.requestSync("refs/heads/main");
    await runDurableObjectAlarm(stub);
    at = await indexedHead(stub);
    expect(at.index).toBe(at.head);
  });

  it("catches the index up after it starts over", async () => {
    await vaultOf([person("Ana Souza", "Irmã do Rafael. Mora em Lisboa.")]);
    fakeGateway();
    const stub = vault("recall-catch-up");
    expect((await stub.recall("kelpie", "Ana Souza", ALL)).paths).toHaveLength(1);
    // As after a new schema version: the index starts over when the object starts again, and the
    // next recall reindexes from the files.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'schema_version'");
    });
    await evictDurableObject(stub);
    expect((await stub.recall("kelpie", "Ana Souza", ALL)).paths).toHaveLength(1);
  });

  it("embeds notes in the alarm, and a gateway failure leaves GitHub's backoff alone", async () => {
    await vaultOf([
      person("Ana Souza", "Irmã do Rafael. Fez a mudança para o Porto."),
      person("Bruno Lima", "Sócio do Rafael."),
    ]);
    for (const [name, failure] of [
      ["recall-embed-fails", { failEmbed: true }],
      ["recall-embed-throws", { throwEmbed: true }],
    ] as const) {
      const calls = fakeGateway(failure);
      const stub = vault(name);
      await stub.recall("kelpie", "oi", ALL);
      await runDurableObjectAlarm(stub);
      expect(calls.embed).toBeGreaterThan(0);
      expect(await backoffOf(stub)).toEqual([
        { key: "failures", value: "0" },
        { key: "retry_at", value: "0" },
      ]);
    }
  });

  it("finds a note by meaning once it is embedded", async () => {
    await vaultOf([
      person("Ana Souza", "Irmã do Rafael. Fez a mudança para o Porto."),
      person("Bruno Lima", "Sócio do Rafael."),
    ]);
    // The judge stays out, and the question shares no word with the note: only its vector finds it.
    fakeGateway({ failQualify: true });
    const stub = vault("recall-vectors");
    await stub.recall("kelpie", "oi", ALL);
    await runDurableObjectAlarm(stub);
    const result = await stub.recall("kelpie", "Ela se mudou?", ALL);
    expect(result.paths[0]).toBe(memoryPath("global", "person", "Ana Souza"));
  });

  it("reranks by the qualifier, and keeps the fused order when it fails", async () => {
    await vaultOf([
      person("Bruno Lima", "Rafael e o sócio. Rafael Rafael."),
      person("Ana Souza", "Irmã do Rafael."),
    ]);
    const calls = fakeGateway();
    const stub = vault("recall-rerank");
    const reranked = await stub.recall("kelpie", "Rafael", ALL);
    expect(calls.qualify).toBe(1);
    expect(reranked.paths[0]).toBe(memoryPath("global", "person", "Ana Souza"));

    fakeGateway({ failQualify: true });
    const fused = await stub.recall("kelpie", "Rafael", ALL);
    expect(fused.paths[0]).toBe(memoryPath("global", "person", "Bruno Lima"));
  });

  it("searches only the scopes it is given, and counts what it packed", async () => {
    await vaultOf([
      person("Ana Souza", "Irmã do Rafael."),
      person("Carla Dias", "Amiga do Rafael no grupo.", "conversation/family"),
    ]);
    fakeGateway();
    const stub = vault("recall-scopes");
    const global = await stub.recall("kelpie", "Rafael", {
      scopes: ["global"],
      budgetTokens: 1_000,
    });
    expect(global.paths).toEqual([memoryPath("global", "person", "Ana Souza")]);
    await stub.recall("kelpie", "Rafael", ALL);
    const counts = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ path: string; count: number }>(
          "SELECT path, count FROM recall_counts ORDER BY path",
        )
        .toArray(),
    );
    expect(counts).toEqual([
      { path: memoryPath("conversation/family", "person", "Carla Dias"), count: 1 },
      { path: memoryPath("global", "person", "Ana Souza"), count: 2 },
    ]);
  });

  it("follows a move of the head even when the index had started over", async () => {
    const backend = await vaultOf([
      person("Ana Souza", "Irmã do Rafael."),
      person("Bruno Lima", "Sócio do Rafael."),
    ]);
    fakeGateway({ failQualify: true });
    const stub = vault("recall-stale");
    expect((await stub.recall("kelpie", "Ana Souza", ALL)).paths).toHaveLength(1);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = '0' WHERE key = 'schema_version'");
    });
    await evictDurableObject(stub);
    const carla = person("Carla Dias", "Amiga do Rafael.");
    backend.push({
      [memoryPath("global", "person", "Carla Dias")]: (
        await writeMemory(carla, { at: "2026-10-03T00:00:00Z" })
      ).text,
    });
    await stub.requestSync("refs/heads/main");
    await runDurableObjectAlarm(stub);
    // The sync alone brought the index to the new head, before any recall.
    const head = await backend.branchHead("main");
    const indexed = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM state WHERE key = 'index_head'")
          .one().value,
    );
    expect(indexed).toBe(head);
    expect((await stub.recall("kelpie", "Rafael", ALL)).paths).toHaveLength(3);
  });

  it("forgets a note when the owner rewinds the branch past it", async () => {
    const backend = await vaultOf([person("Ana Souza", "Irmã do Rafael.")]);
    fakeGateway({ failQualify: true });
    const stub = vault("recall-rewind");
    await stub.recall("kelpie", "Rafael", ALL);
    const before = (await backend.branchHead("main")) ?? "";
    const carlaPath = memoryPath("global", "person", "Carla Dias");
    backend.push({
      [carlaPath]: (
        await writeMemory(person("Carla Dias", "Amiga do Rafael."), { at: "2026-10-03T00:00:00Z" })
      ).text,
    });
    await stub.requestSync("refs/heads/main");
    await runDurableObjectAlarm(stub);
    expect((await stub.recall("kelpie", "Rafael", ALL)).paths).toContain(carlaPath);
    await backend.deleteBranch("main");
    await backend.createBranch("main", before);
    await stub.requestSync("refs/heads/main");
    await runDurableObjectAlarm(stub);
    expect((await stub.recall("kelpie", "Rafael", ALL)).paths).not.toContain(carlaPath);
  });

  it("embeds the notes again when llm-gateway's model changes", async () => {
    await vaultOf([person("Ana Souza", "Irmã do Rafael. Fez a mudança para o Porto.")]);
    fakeGateway({ model: "model-a", failQualify: true });
    const stub = vault("recall-model");
    await stub.recall("kelpie", "oi", ALL);
    await runDurableObjectAlarm(stub);
    const calls = fakeGateway({ model: "model-b", failQualify: true });
    await stub.recall("kelpie", "oi", ALL);
    await runDurableObjectAlarm(stub);
    expect(calls.embed).toBeGreaterThan(1);
    expect((await stub.recall("kelpie", "Ela se mudou?", ALL)).paths).toHaveLength(1);
  });

  it("asks the agent's qualifier, and keeps the fused order when it doesn't answer", async () => {
    await vaultOf([
      person("Bruno Lima", "Rafael e o sócio. Rafael Rafael."),
      person("Ana Souza", "Irmã do Rafael."),
    ]);
    const calls = fakeGateway();
    const stub = vault("recall-qualifier");
    await stub.recall("kelpie", "Rafael", { ...ALL, qualifier: "jev" });
    await stub.recall("kelpie", "Rafael", ALL);
    expect(calls.backends).toEqual(["jev", "clef"]);
    fakeGateway({ hangQualify: true });
    const started = Date.now();
    const fused = await stub.recall("kelpie", "Rafael", ALL);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fused.paths[0]).toBe(memoryPath("global", "person", "Bruno Lima"));
  });

  it("holds the budget's ceiling, and reads only the question's start", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      person(`Pessoa ${i}`, `Rafael ${"conhecida de longa data ".repeat(300)}`),
    );
    await vaultOf(many);
    fakeGateway({ failQualify: true });
    const stub = vault("recall-ceiling");
    const huge = await stub.recall("kelpie", "Rafael", { scopes: "all", budgetTokens: 1e9 });
    expect(huge.tokens).toBeLessThanOrEqual(8_000);
    expect(huge.tokens).toBeGreaterThan(7_000);
    const calls = fakeGateway({ failQualify: true });
    expect((await stub.recall("kelpie", `${"x".repeat(2_001)} Rafael`, ALL)).paths).toEqual([]);
    expect(calls.texts.every((text) => text.length <= 2_000)).toBe(true);
    expect(
      await stub.recall("kelpie", "Rafael", { scopes: ["not a scope"], budgetTokens: 1_000 }),
    ).toEqual({ text: "", tokens: 0, paths: [] });
  });

  it("refuses an unknown agent, and bounds the question and the budget", async () => {
    await vaultOf([person("Ana Souza", "Irmã do Rafael.")]);
    fakeGateway();
    const stub = vault("recall-bounds");
    expect(await stub.recall("Not An Agent", "Ana", ALL)).toEqual({
      text: "",
      tokens: 0,
      paths: [],
    });
    const huge = await stub.recall("kelpie", "Ana Souza", { scopes: "all", budgetTokens: 1e9 });
    expect(huge.tokens).toBeLessThanOrEqual(8_000);
    const long = await stub.recall("kelpie", `Ana Souza ${"x".repeat(100_000)}`, ALL);
    expect(long.paths).toHaveLength(1);
  });
});
