import { env } from "cloudflare:workers";
import type {
  MemorySearchOptions,
  MemoryWriteInput,
  ReadNoteOptions,
  ReadNoteResult,
  WriteNoteOptions,
  WriteNoteResult,
} from "@kelpie/context-store/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MemoryStore, memoryTools } from "../src/memory-tools.ts";
import { replacePortsForTesting } from "../src/ports.ts";
import type { Tool, ToolContext } from "../src/tools.ts";
import { fakeWorld, reply, toolCalls } from "./fakes.ts";

// The agent's memory tools (#126): search and read the vault through the Context Store, within the
// turn's scopes, never the model's.

const PAGE =
  '<memory-1 note="A note from the owner\'s vault.">\n## Ana (memory/people/ana.md) [1]\nMora no Porto.\n</memory-1>';
const HITS =
  '<memory-2 note="Notes that match.">\n## Ana (memory/people/ana.md) [2]\nperson · global\n</memory-2>';

/** A Context Store that answers from `read` and `write`, and logs what it was asked. */
function fakeStore(
  read: (path: string, offset: number) => ReadNoteResult = () => notFound,
  write: (input: MemoryWriteInput) => WriteNoteResult | Promise<never> = () => ({
    ok: true,
    action: "written",
    path: "memory/notes/x.md",
  }),
) {
  const calls: { method: string; agentId: string; arg: string; options: unknown }[] = [];
  const store: MemoryStore = {
    async search(agentId: string, query: string, options: MemorySearchOptions) {
      calls.push({ method: "search", agentId, arg: query, options });
      if (query.includes("desligada")) return { ok: false, reason: "vault_off" };
      if (query.includes("falha")) return { ok: false, reason: "unavailable" };
      return query.includes("nada")
        ? { ok: true, text: "", notes: [] }
        : { ok: true, text: HITS, notes: [] };
    },
    async readNote(agentId: string, path: string, options: ReadNoteOptions) {
      calls.push({ method: "readNote", agentId, arg: path, options });
      return read(path, options.offset ?? 0);
    },
    async writeNote(agentId: string, input: MemoryWriteInput, options: WriteNoteOptions) {
      calls.push({ method: "writeNote", agentId, arg: input.title, options });
      return write(input);
    },
  };
  return { store, calls };
}

const notFound: ReadNoteResult = { ok: false, reason: "not_found" };

let turns = 0;
/** A fresh turn's context, unless `turn` names one. */
const context = (turn = `turn-${turns++}`): ToolContext => ({
  actor: { userId: "u-owner", role: "owner", via: "agent:assistant" },
  agentId: "assistant",
  turn,
  scopes: ["global", "conversation/familia"],
  qualifier: "jev",
  source: "telegram:chat-1, 2026-10-06",
  signal: new AbortController().signal,
});

async function toolsOf(store: MemoryStore): Promise<Map<string, Tool>> {
  const tools = await memoryTools(store).tools("assistant");
  return new Map(tools.map((tool) => [tool.spec.name, tool]));
}

describe("memory tools", () => {
  it("offers search and read, with stable specs and plain labels", async () => {
    const tools = await toolsOf(fakeStore().store);
    expect([...tools.keys()]).toEqual(["memory_search", "memory_read", "memory_write"]);
    expect(tools.get("memory_write")?.label).toBe("Saving to memory");
    expect(tools.get("memory_search")?.label).toBe("Searching memory");
    expect(tools.get("memory_read")?.label).toBe("Reading a note");
    // The same specs every time: a turn keys its tools by them.
    expect(
      JSON.stringify([...(await toolsOf(fakeStore().store)).values()].map((t) => t.spec)),
    ).toBe(JSON.stringify([...tools.values()].map((tool) => tool.spec)));
  });

  it("searches within the turn's scopes and qualifier, whatever the model passes", async () => {
    const { store, calls } = fakeStore();
    const search = (await toolsOf(store)).get("memory_search");
    expect(
      await search?.run({ query: "Ana", k: 5, scopes: "all", qualifier: "clef" }, context()),
    ).toEqual({ output: HITS });
    expect(calls).toEqual([
      {
        method: "search",
        agentId: "assistant",
        arg: "Ana",
        options: { scopes: ["global", "conversation/familia"], k: 5, qualifier: "jev" },
      },
    ]);
    expect(await search?.run({ query: "nada" }, context())).toEqual({
      output: "No notes match.",
    });
    // Memory that is off, or failing, isn't empty memory.
    expect(await search?.run({ query: "desligada" }, context())).toEqual({
      output: "Memory is off: the vault isn't connected.",
      isError: true,
    });
    await expect(search?.run({ query: "falha" }, context())).rejects.toThrow();
  });

  it("reads a note's pages, and says so when there is none", async () => {
    const { store, calls } = fakeStore((path, offset) =>
      path === "memory/people/ana.md"
        ? { ok: true, path, text: `${PAGE} ${offset}`, nextOffset: null }
        : notFound,
    );
    const read = (await toolsOf(store)).get("memory_read");
    expect(await read?.run({ path: "memory/people/ana.md", offset: 9_000 }, context())).toEqual({
      output: `${PAGE} 9000`,
    });
    expect(calls[0]).toMatchObject({
      method: "readNote",
      options: { scopes: ["global", "conversation/familia"], offset: 9_000 },
    });
    expect(await read?.run({ path: "agents/assistant/SOUL.md" }, context())).toEqual({
      output: "There is no note at that path in the memory this conversation can see.",
      isError: true,
    });
  });

  it("answers bad input with an error the model can fix, and a store failure by throwing", async () => {
    const { store, calls } = fakeStore(() => ({ ok: false, reason: "unavailable" }));
    const tools = await toolsOf(store);
    for (const [name, input] of [
      ["memory_search", {}],
      ["memory_search", { query: "  " }],
      ["memory_search", { query: "Ana", k: 0 }],
      ["memory_search", { query: "Ana", k: 11 }],
      ["memory_search", { query: "Ana", k: 2.5 }],
      ["memory_read", { path: 3 }],
      ["memory_read", { path: "memory/people/ana.md", offset: -1 }],
      ["memory_read", null],
    ] as const) {
      const outcome = await tools.get(name)?.run(input, context());
      expect(outcome?.isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(0);
    await expect(
      tools.get("memory_read")?.run({ path: "memory/a.md" }, context()),
    ).rejects.toThrow();
    const off = fakeStore(() => ({ ok: false, reason: "vault_off" }));
    expect(
      await (await toolsOf(off.store)).get("memory_read")?.run({ path: "memory/a.md" }, context()),
    ).toEqual({ output: "Memory is off: the vault isn't connected.", isError: true });
  });
});

describe("memory_write", () => {
  const note = { title: "Café da Ana", body: "Sem açúcar.", kind: "preference", level: "explicit" };

  it("saves with the turn's scopes and source, never the model's", async () => {
    let given: MemoryWriteInput | undefined;
    const { store, calls } = fakeStore(undefined, (input) => {
      given = input;
      return { ok: true, action: "written", path: "memory/notes/x.md" };
    });
    const write = (await toolsOf(store)).get("memory_write");
    expect(
      await write?.run({ ...note, scope: "conversation/familia", sources: ["fake"] }, context()),
    ).toEqual({ output: "Saved to memory/notes/x.md. This is done; don't save it again." });
    expect(calls).toEqual([
      {
        method: "writeNote",
        agentId: "assistant",
        arg: "Café da Ana",
        options: {
          scopes: ["global", "conversation/familia"],
          sources: ["telegram:chat-1, 2026-10-06"],
        },
      },
    ]);
    // What the model sent beyond the memory's fields doesn't reach the store.
    expect(given).toEqual({ ...note, scope: "conversation/familia" });
    // Nor do the fields it sent as null, meaning left out.
    await write?.run({ ...note, entities: null, validFrom: null, path: null }, context());
    expect(given).toEqual(note);
  });

  it("counts a turn's writes across its loop's providers, and apart from other conversations", async () => {
    const shared = fakeStore();
    const first = (await toolsOf(shared.store)).get("memory_write");
    const second = (await toolsOf(shared.store)).get("memory_write");
    for (let i = 0; i < 3; i += 1) await first?.run(note, context("resumed"));
    for (let i = 0; i < 2; i += 1) await second?.run(note, context("resumed"));
    expect((await second?.run(note, context("resumed")))?.isError).toBe(true);
    // The same turn id in another conversation is another turn.
    expect(
      (await second?.run(note, { ...context("resumed"), source: "telegram:chat-2, 2026-10-06" }))
        ?.isError,
    ).toBeUndefined();
  });

  it("tells the model what happened, in words it can act on", async () => {
    const cases: [WriteNoteResult, { output: string; isError?: boolean }][] = [
      [
        { ok: true, action: "unchanged", path: "memory/notes/cafe.md" },
        { output: "Already in memory, at memory/notes/cafe.md. Nothing was saved." },
      ],
      [
        { ok: false, reason: "invalid", problems: ["`kind` is invalid", "`body` is empty"] },
        { output: "Not saved: `kind` is invalid; `body` is empty.", isError: true },
      ],
      [
        { ok: false, reason: "scope_not_allowed" },
        {
          output:
            "Not saved: this conversation can't save to that scope. Choose one it sees, or leave scope out for the owner's global memory.",
          isError: true,
        },
      ],
      [
        { ok: false, reason: "not_found" },
        {
          output:
            "Not saved: there is no note at that path in the memory this conversation can see.",
          isError: true,
        },
      ],
    ];
    for (const [result, outcome] of cases) {
      const write = (await toolsOf(fakeStore(undefined, () => result).store)).get("memory_write");
      expect(await write?.run(note, context())).toEqual(outcome);
    }
    const failing = fakeStore(undefined, () => ({ ok: false, reason: "unavailable" }));
    await expect(
      (await toolsOf(failing.store)).get("memory_write")?.run(note, context()),
    ).rejects.toThrow();
  });

  it("saves 5 memories a turn, and stops a model that keeps failing", async () => {
    const { store, calls } = fakeStore();
    const write = (await toolsOf(store)).get("memory_write");
    // Each call gets a signal of its own, as the host gives it; the turn is what counts.
    const turn = () => context("one-turn");
    for (let i = 0; i < 5; i += 1) {
      expect((await write?.run({ ...note, title: `Nota ${i}` }, turn()))?.isError).toBeUndefined();
    }
    expect(await write?.run({ ...note, title: "Nota 5" }, turn())).toEqual({
      output: "Not saved: this turn already saved 5 memories. Finish with what you have.",
      isError: true,
    });
    expect(calls).toHaveLength(5);
    // Another turn starts over.
    expect((await write?.run(note, context()))?.isError).toBeUndefined();

    const refusing = fakeStore(undefined, () => ({
      ok: false,
      reason: "invalid",
      problems: ["`kind` is invalid"],
    }));
    const stubborn = (await toolsOf(refusing.store)).get("memory_write");
    for (let i = 0; i < 3; i += 1) await stubborn?.run(note, context("another"));
    expect(await stubborn?.run(note, context("another"))).toEqual({
      output: "Not saved: memory writes failed 3 times in this turn. Stop retrying them.",
      isError: true,
    });
    expect(refusing.calls).toHaveLength(3);

    // A store that fails counts as a failure too.
    const down = fakeStore(undefined, () => Promise.reject(new Error("timeout")));
    const failing = (await toolsOf(down.store)).get("memory_write");
    for (let i = 0; i < 3; i += 1) {
      await expect(failing?.run(note, context("down"))).rejects.toThrow();
    }
    expect((await failing?.run(note, context("down")))?.isError).toBe(true);
    expect(down.calls).toHaveLength(3);
  });

  it("checks its input before asking the store", async () => {
    const { store, calls } = fakeStore();
    const write = (await toolsOf(store)).get("memory_write");
    for (const input of [{}, { ...note, title: 3 }, { ...note, body: "" }, null]) {
      expect((await write?.run(input, context()))?.isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
});

afterEach(() => {
  replacePortsForTesting(undefined);
});

describe("memory tools in a turn", () => {
  it("saves 5 memories at most in a turn, across its rounds", async () => {
    const writes = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: "memory_write",
        input: { title: `Nota ${from + i}`, body: "Algo.", kind: "note", level: "explicit" },
      }));
    const world = fakeWorld([
      toolCalls(...writes(3, 0)),
      toolCalls(...writes(4, 3)),
      reply("Feito."),
    ]);
    const { store, calls } = fakeStore();
    world.tools = [memoryTools(store)];
    replacePortsForTesting(world.ports);
    const stub = env.CONVERSATION_AGENT.getByName("memory-tools-bounds");
    await stub.ingest({
      agentId: "assistant",
      providerMessageId: "m1",
      userId: "u-owner",
      text: "anota tudo",
      destination: { channel: "telegram", threadId: "chat-1" },
      sentAt: Date.UTC(2026, 9, 4, 2, 30),
      timeZone: null,
    });
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["Feito."]));
    expect(calls.filter((call) => call.method === "writeNote")).toHaveLength(5);
    expect(JSON.stringify(world.requests[2]?.messages)).toContain("already saved 5 memories");
  });

  it("finds a note the turn wasn't given, reads it, then answers", async () => {
    const world = fakeWorld([
      toolCalls({ name: "memory_search", input: { query: "onde a Ana mora" } }),
      toolCalls({ name: "memory_read", input: { path: "memory/people/ana.md" } }),
      reply("A Ana mora no Porto."),
    ]);
    const { store, calls } = fakeStore((path) => ({
      ok: true,
      path,
      text: PAGE,
      nextOffset: null,
    }));
    world.tools = [memoryTools(store)];
    replacePortsForTesting(world.ports);
    const stub = env.CONVERSATION_AGENT.getByName("memory-tools-turn");
    await stub.ingest({
      agentId: "assistant",
      providerMessageId: "m1",
      userId: "u-owner",
      text: "onde a Ana mora?",
      destination: { channel: "telegram", threadId: "chat-1" },
      sentAt: Date.UTC(2026, 9, 4, 2, 30),
      timeZone: null,
    });
    await stub.flush();
    await vi.waitFor(() => expect(world.sent).toEqual(["A Ana mora no Porto."]));
    expect(calls.map((call) => [call.method, call.arg])).toEqual([
      ["search", "onde a Ana mora"],
      ["readNote", "memory/people/ana.md"],
    ]);
    const asked = JSON.stringify(world.requests[2]?.messages);
    expect(asked).toContain("Mora no Porto.");
    expect(asked).toContain("person · global");
  });
});
