import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { MemoryWriteInput } from "@kelpie/context-store/contract";
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
});
