import type { ContextStoreContract } from "@kelpie/context-store/contract";
import type { Tool, ToolContext, ToolOutcome, ToolProvider } from "./tools.ts";

// The agent's memory tools (#126): search the owner's vault beyond the turn's block, and read a
// note a page at a time, through the Context Store. Scopes and the qualifier come from the turn,
// never from the model, and the store answers fenced text the model reads as reference.

/** What the memory tools need of the Context Store. */
export type MemoryStore = Pick<ContextStoreContract, "search" | "readNote">;

const MAX_QUERY_CHARS = 2_000;
const MAX_K = 10;
const MAX_PATH_CHARS = 300;

const SEARCH: Tool["spec"] = {
  name: "memory_search",
  description:
    "Search the owner's memory: the notes in their vault, beyond the ones this turn was given. Use it when the answer may be in a note you weren't shown. It returns up to k notes, best first, each with its path; read one with memory_read.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, in the words a note would use." },
      k: {
        type: "integer",
        minimum: 1,
        maximum: MAX_K,
        description: "How many notes; 3 by default.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const READ: Tool["spec"] = {
  name: "memory_read",
  description:
    "Read a note of the owner's memory by its path, as memory_search or a note's links give it. A long note comes a page at a time: each page says where the next one starts, to pass as offset.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The note's path in the vault." },
      offset: { type: "integer", minimum: 0, description: "Where the page starts; 0 by default." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const invalid = (output: string): ToolOutcome => ({ output, isError: true });
const fields = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
const isCount = (value: unknown, min: number, max: number) =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** The memory tools, for every agent. */
export function memoryTools(store: MemoryStore): ToolProvider {
  const search: Tool = {
    spec: SEARCH,
    label: "Searching memory",
    async run(input: unknown, context: ToolContext): Promise<ToolOutcome> {
      const { query, k } = fields(input);
      if (typeof query !== "string" || query.trim() === "" || query.length > MAX_QUERY_CHARS) {
        return invalid(`query must be text of 1 to ${MAX_QUERY_CHARS} characters.`);
      }
      if (k !== undefined && !isCount(k, 1, MAX_K)) {
        return invalid(`k must be a whole number from 1 to ${MAX_K}.`);
      }
      const found = await store.search(context.agentId, query, {
        scopes: context.scopes,
        ...(k === undefined ? {} : { k: k as number }),
        qualifier: context.qualifier,
      });
      return { output: found.text === "" ? "No notes match." : found.text };
    },
  };
  const read: Tool = {
    spec: READ,
    label: "Reading a note",
    async run(input: unknown, context: ToolContext): Promise<ToolOutcome> {
      const { path, offset } = fields(input);
      if (typeof path !== "string" || path === "" || path.length > MAX_PATH_CHARS) {
        return invalid(`path must be a note's path, up to ${MAX_PATH_CHARS} characters.`);
      }
      if (offset !== undefined && !isCount(offset, 0, Number.MAX_SAFE_INTEGER)) {
        return invalid("offset must be a whole number, 0 or more.");
      }
      const page = await store.readNote(context.agentId, path, {
        scopes: context.scopes,
        ...(offset === undefined ? {} : { offset: offset as number }),
      });
      if (page.ok) return { output: page.text };
      if (page.reason === "not_found") {
        return invalid("There is no note at that path in the memory this conversation can see.");
      }
      if (page.reason === "vault_off") return invalid("Memory is off: the vault isn't connected.");
      // The host answers "The tool failed." without passing the store's reason on.
      throw new Error(`readNote: ${page.reason}`);
    },
  };
  return {
    async tools() {
      return [search, read];
    },
  };
}
