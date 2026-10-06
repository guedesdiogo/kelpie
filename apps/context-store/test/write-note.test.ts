import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { MemoryWriteInput } from "@kelpie/context-store/contract";
import { writeMemory } from "@kelpie/memory";
import { FakeVaultBackend } from "@kelpie/vault/fake";
import { afterEach, describe, expect, it } from "vitest";
import { replaceBackendForTesting, replaceGatewayForTesting } from "../src/index.ts";

afterEach(() => {
  replaceBackendForTesting(undefined);
  replaceGatewayForTesting(undefined);
});

const vault = (name: string) => env.VAULT.getByName(name);

function vaultWith(files: Record<string, string> = {}): FakeVaultBackend {
  const backend = new FakeVaultBackend({ "README.md": "# Vault", ...files });
  replaceBackendForTesting(backend);
  replaceGatewayForTesting(null);
  return backend;
}

const SOURCES = ["telegram/chat-1, 2026-10-06"];
const ALL = { scopes: "all" as const, sources: SOURCES };

const memory = (title: string, body: string, extra: Partial<MemoryWriteInput> = {}) =>
  ({ title, body, kind: "note", level: "explicit", ...extra }) as MemoryWriteInput;

describe("writeNote", () => {
  it("writes a new memory where its title puts it, sanitized, with the turn's sources", async () => {
    const backend = vaultWith();
    const stub = vault("write-new");
    const written = await stub.writeNote(
      "kelpie",
      memory("Café da Ana", `A Ana toma café sem açúcar. Bearer ${"a".repeat(24)}`, {
        entities: ["Ana Souza"],
      }),
      ALL,
    );
    expect(written).toEqual({ ok: true, action: "written", path: "memory/notes/cafe-da-ana.md" });
    await runDurableObjectAlarm(stub);
    const file = backend.files()["memory/notes/cafe-da-ana.md"] ?? "";
    expect(file).toContain("# Café da Ana");
    expect(file).toContain("[REDACTED:bearer_token]");
    expect(file).not.toContain("a".repeat(24));
    expect(file).toContain("telegram/chat-1, 2026-10-06");
    expect(file).toContain("level: explicit");
    // The index sees it after the commit.
    expect(
      await stub.readNote("kelpie", "memory/notes/cafe-da-ana.md", { scopes: "all" }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("writes nothing for the same memory again, even before the commit", async () => {
    const backend = vaultWith();
    const stub = vault("write-twice");
    const input = memory("Café da Ana", "Sem açúcar.");
    expect(await stub.writeNote("kelpie", input, ALL)).toMatchObject({ action: "written" });
    expect(await stub.writeNote("kelpie", input, ALL)).toEqual({
      ok: true,
      action: "unchanged",
      path: "memory/notes/cafe-da-ana.md",
    });
    await runDurableObjectAlarm(stub);
    expect(await stub.writeNote("kelpie", input, ALL)).toMatchObject({ action: "unchanged" });
    expect(Object.keys(backend.files()).filter((path) => path.startsWith("memory/"))).toEqual([
      "memory/notes/cafe-da-ana.md",
    ]);
  });

  it("numbers a new memory whose path another note holds", async () => {
    const backend = vaultWith({ "memory/notes/cafe-da-ana.md": "# Café da Ana\n\nCom leite.\n" });
    const stub = vault("write-numbered");
    expect(await stub.writeNote("kelpie", memory("Café da Ana", "Sem açúcar."), ALL)).toEqual({
      ok: true,
      action: "written",
      path: "memory/notes/cafe-da-ana-2.md",
    });
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/notes/cafe-da-ana.md"]).toBe("# Café da Ana\n\nCom leite.\n");
  });

  it("writes only to the turn's scopes, the global one and the agent's own", async () => {
    vaultWith();
    const stub = vault("write-scopes");
    const input = (scope: string) => memory(`Nota em ${scope}`, "Algo.", { scope });
    expect(await stub.writeNote("kelpie", input("agent/kelpie"), ALL)).toMatchObject({
      ok: true,
      path: "agents/kelpie/memory/notes/nota-em-agent-kelpie.md",
    });
    for (const scope of ["conversation/familia", "agent/outro", "area/work"]) {
      expect(await stub.writeNote("kelpie", input(scope), ALL), scope).toEqual({
        ok: false,
        reason: "scope_not_allowed",
      });
    }
    expect(
      await stub.writeNote("kelpie", input("conversation/familia"), {
        scopes: ["global", "conversation/familia"],
        sources: SOURCES,
      }),
    ).toMatchObject({
      ok: true,
      path: "conversations/familia/notes/nota-em-conversation-familia.md",
    });
  });

  it("writes a found note's new version, keeping its id, the owner's keys and its pin", async () => {
    const ana = "memory/people/ana-souza.md";
    const backend = vaultWith({
      [ana]:
        "---\nid: 0123456789abcdef\npinned: true\naliases: [Aninha]\n---\n\n# Ana Souza\n\nMora em Lisboa.\n",
      "conversations/familia/people/caio.md": "# Caio\n\nPrimo.\n",
      "agents/kelpie/SOUL.md": "# Kelpie\n",
    });
    const stub = vault("write-path");
    expect(
      await stub.writeNote(
        "kelpie",
        memory("Ana Souza", "Mora no Porto.", { kind: "person", path: ana }),
        { scopes: ["global"], sources: SOURCES },
      ),
    ).toEqual({ ok: true, action: "written", path: ana });
    await runDurableObjectAlarm(stub);
    const file = backend.files()[ana] ?? "";
    expect(file).toContain("id: 0123456789abcdef");
    expect(file).toContain("aliases: [Aninha]");
    expect(file).toContain("pinned: true");
    expect(file).toContain("Mora no Porto.");

    // The kind and the scope stay the note's; other paths aren't the agent's to name.
    expect(
      await stub.writeNote("kelpie", memory("Ana Souza", "X.", { kind: "note", path: ana }), ALL),
    ).toMatchObject({ ok: false, reason: "invalid" });
    for (const path of [
      "conversations/familia/people/caio.md",
      "agents/kelpie/SOUL.md",
      "memory/people/zeca.md",
    ]) {
      expect(
        await stub.writeNote("kelpie", memory("Caio", "X.", { kind: "person", path }), {
          scopes: ["global"],
          sources: SOURCES,
        }),
        path,
      ).toEqual({ ok: false, reason: "not_found" });
    }
  });

  it("explains what's wrong with a memory, and refuses a stranger", async () => {
    vaultWith();
    const stub = vault("write-invalid");
    const refused = await stub.writeNote(
      "kelpie",
      memory("Linha\nquebrada", "Algo.", { kind: "thing", level: "sure" as never }),
      ALL,
    );
    expect(refused).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      refused.ok === false && refused.reason === "invalid" && refused.problems.length,
    ).toBeGreaterThanOrEqual(2);
    expect(await stub.writeNote("Not An Agent", memory("A", "B."), ALL)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    replaceBackendForTesting(null);
    expect(await vault("write-off").writeNote("kelpie", memory("A", "B."), ALL)).toEqual({
      ok: false,
      reason: "vault_off",
    });
  });

  it("keeps concurrent and retried writes apart, and never repeats one at a numbered path", async () => {
    const backend = vaultWith({ "memory/notes/cafe.md": "# Café\n\nCom leite.\n" });
    const stub = vault("write-concurrent");
    const results = await Promise.all(
      ["Sem açúcar.", "Com canela.", "Coado."].map((body) =>
        stub.writeNote("kelpie", memory("Café", body), ALL),
      ),
    );
    const paths = results.map((result) => (result.ok ? result.path : result.reason));
    expect(new Set(paths).size).toBe(3);
    // A retry before the commit, of the write that went to a numbered path.
    const first = results.findIndex(
      (result) => result.ok && result.path === "memory/notes/cafe-2.md",
    );
    const retried = await stub.writeNote(
      "kelpie",
      memory("Café", ["Sem açúcar.", "Com canela.", "Coado."][first] ?? ""),
      ALL,
    );
    expect(retried).toEqual({ ok: true, action: "unchanged", path: "memory/notes/cafe-2.md" });
    await runDurableObjectAlarm(stub);
    expect(
      Object.keys(backend.files())
        .filter((path) => path.startsWith("memory/"))
        .sort(),
    ).toEqual([
      "memory/notes/cafe-2.md",
      "memory/notes/cafe-3.md",
      "memory/notes/cafe-4.md",
      "memory/notes/cafe.md",
    ]);
  });

  it("keeps what a found note holds and the model left out, and adds the turn's source", async () => {
    const ana = "memory/notes/casa-da-ana.md";
    const backend = vaultWith({
      [ana]: [
        "---",
        "tier: procedural",
        "level: explicit",
        "confidence: 0.95",
        "sources:",
        '  - "[[2026-01-02-conversa]]"',
        "entities: [Ana Souza]",
        "valid_from: 2025-01-01",
        "abstract: Onde a Ana mora.",
        "relations:",
        '  contradicts: ["[[casa-antiga]]"]',
        "---",
        "",
        "# Casa da Ana",
        "",
        "Lisboa.",
        "",
      ].join("\n"),
    });
    const stub = vault("write-carry");
    expect(
      await stub.writeNote(
        "kelpie",
        memory("Casa da Ana", "Porto.", { path: ana, level: "explicit" }),
        ALL,
      ),
    ).toMatchObject({ ok: true, action: "written" });
    await runDurableObjectAlarm(stub);
    const file = backend.files()[ana] ?? "";
    for (const kept of [
      "tier: procedural",
      "confidence: 0.95",
      "[[2026-01-02-conversa]]",
      "telegram/chat-1, 2026-10-06",
      "Ana Souza",
      "valid_from: 2025-01-01",
      "abstract: Onde a Ana mora.",
      "[[casa-antiga]]",
      "Porto.",
    ]) {
      expect(file, kept).toContain(kept);
    }
    // Only a change is a change; the same version again isn't.
    const again = memory("Casa da Ana", "Porto.", { path: ana, level: "explicit" });
    expect(await stub.writeNote("kelpie", again, ALL)).toMatchObject({ action: "unchanged" });
    expect(await stub.writeNote("kelpie", { ...again, confidence: 0.5 }, ALL)).toMatchObject({
      action: "written",
    });
  });

  it("updates any note the turn sees, and writes new ones only where the turn may", async () => {
    vaultWith({ "conversations/familia/people/caio.md": "# Caio\n\nPrimo.\n" });
    const stub = vault("write-seen");
    expect(
      await stub.writeNote(
        "kelpie",
        memory("Caio", "Primo, mora em Faro.", {
          kind: "person",
          path: "conversations/familia/people/caio.md",
        }),
        ALL,
      ),
    ).toMatchObject({ ok: true, action: "written" });
    // A turn that sees one conversation writes nowhere else, global included.
    const narrow = { scopes: ["conversation/familia"], sources: SOURCES };
    expect(await stub.writeNote("kelpie", memory("Nota", "Algo."), narrow)).toEqual({
      ok: false,
      reason: "scope_not_allowed",
    });
    expect(
      await stub.writeNote(
        "kelpie",
        memory("Nota", "Algo.", { scope: "conversation/familia" }),
        narrow,
      ),
    ).toMatchObject({ ok: true });
  });

  it("refuses session pages, conflict markers and secrets in names", async () => {
    const backend = vaultWith({
      "memory/sessions/2026/2026-10-06-conversa.md": "# Conversa\n\nOi.\n",
    });
    const stub = vault("write-refusals");
    for (const input of [
      memory("Conversa", "Falamos.", { kind: "session" }),
      memory("Conversa", "Falamos.", {
        kind: "session",
        path: "memory/sessions/2026/2026-10-06-conversa.md",
      }),
      memory("Nota", "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main"),
    ]) {
      expect(await stub.writeNote("kelpie", input, ALL), JSON.stringify(input)).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    }
    const secret = `Bearer ${"b".repeat(24)}`;
    expect(
      await stub.writeNote("kelpie", memory("Chave", "Guardada.", { entities: [secret] }), ALL),
    ).toMatchObject({ ok: true });
    await runDurableObjectAlarm(stub);
    expect(backend.files()["memory/notes/chave.md"]).not.toContain("b".repeat(24));
    // A commit's headline never names the memory: titles would outlive a forget in git.
    expect(backend.commitRequests.map((request) => request.headline).join("\n")).not.toContain(
      "Chave",
    );
  });

  it("answers what the model can act on: another agent's note, odd fields, a removed note", async () => {
    const other = "agents/outro/memory/notes/segredo.md";
    vaultWith({ [other]: "# Segredo\n\nDo outro.\n", "memory/notes/velha.md": "# Velha\n\nX.\n" });
    const stub = vault("write-act-on");
    expect(await stub.writeNote("kelpie", memory("Segredo", "Meu.", { path: other }), ALL)).toEqual(
      { ok: false, reason: "scope_not_allowed" },
    );
    expect(
      await stub.writeNote(
        "kelpie",
        memory("Com nomes", "Algo.", { entities: "Ana" as never }),
        ALL,
      ),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await stub.writeNote(
        "kelpie",
        memory("Sem nomes", "Algo.", { entities: null as never }),
        ALL,
      ),
    ).toMatchObject({ ok: true, action: "written" });
    // A removal still waiting in the queue: the note is gone, not to be written back.
    await stub.write("kelpie", [{ path: "memory/notes/velha.md", content: null }], "x");
    expect(
      await stub.writeNote("kelpie", memory("Velha", "Y.", { path: "memory/notes/velha.md" }), ALL),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("carries only what it can write back, and the owner's link names as written", async () => {
    const casa = "memory/notes/casa.md";
    const backend = vaultWith({
      [casa]: [
        "---",
        "sources:",
        '  - "uma\tfonte"',
        '  - "[[boa-fonte]]"',
        'abstract: "com\ttab"',
        "relations:",
        '  contradicts: ["[[Casa Antiga#Seção|a casa]]"]',
        "---",
        "",
        "# Casa",
        "",
        "Lisboa.",
        "",
      ].join("\n"),
    });
    const stub = vault("write-carry-clean");
    expect(
      await stub.writeNote("kelpie", memory("Casa", "Porto.", { path: casa }), ALL),
    ).toMatchObject({ ok: true, action: "written" });
    await runDurableObjectAlarm(stub);
    const file = backend.files()[casa] ?? "";
    expect(file).toContain("[[boa-fonte]]");
    expect(file).not.toContain("uma\tfonte");
    expect(file).not.toContain("abstract");
    expect(file).toContain("[[Casa Antiga]]");
  });

  it("knows the same memory saved again before the commit, whatever its confidence", async () => {
    const backend = vaultWith();
    const stub = vault("write-same-before-commit");
    expect(await stub.writeNote("kelpie", memory("Chá", "Verde."), ALL)).toMatchObject({
      action: "written",
    });
    expect(
      await stub.writeNote("kelpie", memory("Chá", "Verde.", { confidence: 0.5 }), ALL),
    ).toEqual({ ok: true, action: "unchanged", path: "memory/notes/cha.md" });
    await runDurableObjectAlarm(stub);
    expect(Object.keys(backend.files()).filter((path) => path.startsWith("memory/"))).toEqual([
      "memory/notes/cha.md",
    ]);
  });

  it("compares versions by their frontmatter's stamp only", async () => {
    const { text } = await writeMemory(
      {
        scope: "global",
        kind: "note",
        title: "Diário",
        body: "Texto.",
        level: "explicit",
        confidence: 0.8,
      },
      { at: "2026-10-01T00:00:00Z" },
    );
    const owner = `${text.replace(/^updated: .*\n/m, "")}updated: ontem\n`;
    vaultWith({ "memory/notes/diario.md": owner });
    const stub = vault("write-stamp");
    // The model drops the body's own "updated:" line: that is a change.
    expect(
      await stub.writeNote(
        "kelpie",
        memory("Diário", "Texto.", { path: "memory/notes/diario.md", confidence: 0.8 }),
        { scopes: "all", sources: [] },
      ),
    ).toMatchObject({ action: "written" });
  });

  it("keeps the owner's word: only what the person said changes what the person said", async () => {
    const stated = "memory/notes/cafe.md";
    const owners = "memory/notes/cha.md";
    const concluded = "memory/notes/agua.md";
    const { text: explicitNote } = await writeMemory(
      {
        scope: "global",
        kind: "note",
        title: "Café",
        body: "Sem açúcar.",
        level: "explicit",
        confidence: 0.9,
      },
      { at: "2026-10-01T00:00:00Z" },
    );
    const { text: deducedNote } = await writeMemory(
      {
        scope: "global",
        kind: "note",
        title: "Água",
        body: "Dois litros.",
        level: "deduced",
        confidence: 0.7,
      },
      { at: "2026-10-01T00:00:00Z" },
    );
    vaultWith({ [stated]: explicitNote, [owners]: "# Chá\n\nVerde.\n", [concluded]: deducedNote });
    const stub = vault("write-owners-word");
    for (const [path, title] of [
      [stated, "Café"],
      [owners, "Chá"],
    ] as const) {
      for (const level of ["deduced", "inferred"]) {
        expect(
          await stub.writeNote("kelpie", memory(title, "Outro.", { path, level }), ALL),
          `${path} ${level}`,
        ).toEqual({ ok: false, reason: "owners_word" });
      }
      // What the person says now does change it.
      expect(
        await stub.writeNote("kelpie", memory(title, "Outro.", { path, level: "explicit" }), ALL),
      ).toMatchObject({ ok: true, action: "written" });
    }
    // A conclusion can revise a conclusion.
    expect(
      await stub.writeNote(
        "kelpie",
        memory("Água", "Três litros.", { path: concluded, level: "inferred" }),
        ALL,
      ),
    ).toMatchObject({ ok: true, action: "written" });
  });
});
