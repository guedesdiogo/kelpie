import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type LlmEvent, toNdjsonStream } from "@kelpie/llm";
import { FakeVaultBackend } from "@kelpie/vault/fake";
import { afterEach, describe, expect, it } from "vitest";
import {
  type MemoryGateway,
  replaceBackendForTesting,
  replaceGatewayForTesting,
} from "../src/index.ts";

afterEach(async () => {
  replaceBackendForTesting(undefined);
  replaceGatewayForTesting(undefined);
  // A test's vaults go, alarms and all (#223): one left with an alarm wakes in a later test, where
  // it syncs with that test's backend and asks that test's model.
  await reset();
});

const vault = (name: string) => env.VAULT.getByName(name);

function vaultWith(files: Record<string, string>): FakeVaultBackend {
  const backend = new FakeVaultBackend({ "README.md": "# Vault", ...files });
  replaceBackendForTesting(backend);
  return backend;
}

/** Each recalled note's provenance, by path. */
async function provenance(stub: ReturnType<typeof vault>, question: string) {
  const recalled = await stub.recall("kelpie", question, { scopes: "all", budgetTokens: 4_000 });
  return Object.fromEntries(recalled.notes.map((note) => [note.path, note.byKelpie]));
}

/** A gateway whose model answers a held file's resolution with `answer`. */
function fakeModel(answer: string) {
  const gateway: MemoryGateway = {
    async embed() {
      return { ok: false, reason: "failed" };
    },
    async qualify() {
      return { ok: false, reason: "failed" };
    },
    async generate() {
      async function* events(): AsyncIterable<LlmEvent> {
        yield { type: "text", delta: answer };
        yield {
          type: "finish",
          reason: "stop",
          message: { role: "assistant", parts: [{ type: "text", text: answer }] },
          usage: [],
        };
      }
      return { events: async () => toNdjsonStream(events(), () => {}), cancel: async () => {} };
    },
  };
  replaceGatewayForTesting(gateway);
}

describe("Vault provenance", () => {
  const ana = "memory/people/ana.md";
  const base = "# Ana\n\nMora em Lisboa.\n\nGosta de café.\n";

  it("tells Kelpie's notes from the owner's, until the owner edits one", async () => {
    const backend = vaultWith({ [ana]: base });
    replaceGatewayForTesting(null);
    const stub = vault("provenance-writes");
    await stub.compile("kelpie");
    await stub.write(
      "kelpie",
      [
        { path: "memory/notes/bolo-da-ana.md", content: "# Bolo da Ana\n\nTrês ovos.\n" },
        {
          path: "memory/sessions/2026/2026-10-06-conversa-com-ana.md",
          content: "# Conversa com Ana\n\nFalamos do bolo.\n",
        },
      ],
      "x",
    );
    await runDurableObjectAlarm(stub);
    expect(await provenance(stub, "Ana")).toEqual({
      [ana]: false,
      "memory/notes/bolo-da-ana.md": true,
      "memory/sessions/2026/2026-10-06-conversa-com-ana.md": true,
    });

    // The owner edits Kelpie's note in Obsidian: it is the owner's now.
    backend.push({ "memory/notes/bolo-da-ana.md": "# Bolo da Ana\n\nQuatro ovos.\n" });
    await runDurableObjectAlarm(stub);
    expect(await provenance(stub, "Ana")).toMatchObject({ "memory/notes/bolo-da-ana.md": false });

    // Forgetting a path forgets that Kelpie wrote it.
    expect(await stub.forget(["memory/sessions/"])).toMatchObject({ ok: true });
    expect(
      await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT path FROM authored ORDER BY path").toArray(),
      ),
    ).toEqual([{ path: "memory/notes/bolo-da-ana.md" }]);
  });

  it("counts a write merged into the owner's edit as Kelpie's", async () => {
    const backend = vaultWith({ [ana]: base });
    replaceGatewayForTesting(null);
    const stub = vault("provenance-merge");
    await stub.compile("kelpie");
    await stub.write("kelpie", [{ path: ana, content: base.replace("café", "chá") }], "x");
    backend.push({ [ana]: base.replace("Lisboa", "Braga") });
    await runDurableObjectAlarm(stub);
    expect(backend.files()[ana]).toBe(base.replace("Lisboa", "Braga").replace("café", "chá"));
    expect(await provenance(stub, "Ana")).toEqual({ [ana]: true });
  });

  it("leaves a conflict the model resolved as the owner's", async () => {
    const backend = vaultWith({ [ana]: base });
    const stub = vault("provenance-resolved");
    await stub.compile("kelpie");
    const resolved = "# Ana\n\nMora no Porto.\n\nGosta de café.\n";
    fakeModel(resolved);
    backend.push({
      [ana]: [
        "# Ana",
        "",
        "<<<<<<< HEAD",
        "Mora no Porto.",
        "=======",
        "Mora em Braga.",
        ">>>>>>> origin/main",
        "",
        "Gosta de café.",
        "",
      ].join("\n"),
    });
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(backend.files()[ana]).toBe(resolved);
    expect(await provenance(stub, "Ana")).toEqual({ [ana]: false });
    // Kelpie's resolution of a held conflict isn't listed among the owner's notes it changed (#160).
    expect(
      await runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql.exec("SELECT count(*) AS n FROM owner_changes").one().n,
      ),
    ).toBe(0);
  });

  it("knows its own commit when GitHub's answer was lost, and forgets a file the owner removed", async () => {
    const backend = vaultWith({});
    replaceGatewayForTesting(null);
    const stub = vault("provenance-lost");
    await stub.compile("kelpie");
    const commit = backend.commit.bind(backend);
    let lose = true;
    backend.commit = async (request) => {
      const outcome = await commit(request);
      if (lose) {
        lose = false;
        throw new Error("GitHub commit answered 502");
      }
      return outcome;
    };
    const bolo = "memory/notes/bolo-da-ana.md";
    await stub.write("kelpie", [{ path: bolo, content: "# Bolo da Ana\n\nTrês ovos.\n" }], "x");
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(await provenance(stub, "Ana")).toEqual({ [bolo]: true });

    backend.push({ [bolo]: null });
    await runDurableObjectAlarm(stub);
    expect(
      await runInDurableObject(
        stub,
        (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM authored").one().n,
      ),
    ).toBe(0);
  });

  it("forgets what Kelpie wrote when a force-push takes the file away", async () => {
    const backend = vaultWith({});
    replaceGatewayForTesting(null);
    const stub = vault("provenance-force-push");
    await stub.compile("kelpie");
    await stub.write("kelpie", [{ path: "memory/notes/a.md", content: "# A\n\nUm.\n" }], "x");
    await runDurableObjectAlarm(stub);
    backend.forcePush({ "README.md": "# Vault" });
    await runDurableObjectAlarm(stub);
    expect(
      await runInDurableObject(
        stub,
        (_instance, state) => state.storage.sql.exec("SELECT count(*) AS n FROM authored").one().n,
      ),
    ).toBe(0);
  });
});
