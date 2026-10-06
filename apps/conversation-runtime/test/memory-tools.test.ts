import { env } from "cloudflare:workers";
import type {
  MemorySearchOptions,
  ReadNoteOptions,
  ReadNoteResult,
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

/** A Context Store that answers from `read`, and logs what it was asked. */
function fakeStore(read: (path: string, offset: number) => ReadNoteResult = () => notFound) {
  const calls: { method: string; agentId: string; arg: string; options: unknown }[] = [];
  const store: MemoryStore = {
    async search(agentId: string, query: string, options: MemorySearchOptions) {
      calls.push({ method: "search", agentId, arg: query, options });
      return query.includes("nada") ? { text: "", notes: [] } : { text: HITS, notes: [] };
    },
    async readNote(agentId: string, path: string, options: ReadNoteOptions) {
      calls.push({ method: "readNote", agentId, arg: path, options });
      return read(path, options.offset ?? 0);
    },
  };
  return { store, calls };
}

const notFound: ReadNoteResult = { ok: false, reason: "not_found" };

const context = (): ToolContext => ({
  actor: { userId: "u-owner", role: "owner", via: "agent:assistant" },
  agentId: "assistant",
  scopes: ["global", "conversation/familia"],
  qualifier: "jev",
  signal: new AbortController().signal,
});

async function toolsOf(store: MemoryStore): Promise<Map<string, Tool>> {
  const tools = await memoryTools(store).tools("assistant");
  return new Map(tools.map((tool) => [tool.spec.name, tool]));
}

describe("memory tools", () => {
  it("offers search and read, with stable specs and plain labels", async () => {
    const tools = await toolsOf(fakeStore().store);
    expect([...tools.keys()]).toEqual(["memory_search", "memory_read"]);
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

afterEach(() => {
  replacePortsForTesting(undefined);
});

describe("memory tools in a turn", () => {
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
