import type { ContextStoreContract, MemoryWriteInput } from "@kelpie/context-store/contract";
import { KINDS, LEVELS } from "@kelpie/memory";
import type { Tool, ToolContext, ToolOutcome, ToolProvider } from "./tools.ts";

// The agent's memory tools (#126): search the owner's vault beyond the turn's block, read a note a
// page at a time, and save a memory, through the Context Store. Scopes, the qualifier and a
// memory's sources come from the turn, never from the model, and the store answers fenced text the
// model reads as reference.

/** What the memory tools need of the Context Store. */
export type MemoryStore = Pick<ContextStoreContract, "search" | "readNote" | "writeNote">;

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

/** A turn saves at most this many memories, and stops trying after this many failures (hermes). */
const MAX_WRITES = 5;
const MAX_WRITE_FAILURES = 3;
/** The turns whose counts are kept, per isolate: far more than run at once. */
const KEPT_TURNS = 256;

/**
 * Each turn's writes and failures, by agent, conversation and turn. The host gives every call a
 * signal of its own, and a fresh provider each loop, so the counts live with the isolate: a turn
 * resumed elsewhere after an eviction starts them again.
 */
const turns = new Map<string, { writes: number; failures: number }>();

const WRITE: Tool["spec"] = {
  name: "memory_write",
  description:
    "Save something worth keeping to the owner's memory, as one note: a fact, a preference, a commitment, a person, a decision. Write it in the owner's language. To change a note found with memory_search or memory_read, pass its path: what you write becomes its new version, so keep what still holds. Saving the same memory again changes nothing.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "One line that names the note." },
      body: { type: "string", description: "The note, in Markdown, without the title." },
      kind: { type: "string", enum: KINDS.filter((kind) => kind !== "session") },
      level: {
        type: "string",
        enum: [...LEVELS],
        description:
          "explicit: the person said it. deduced: it follows from what they said. inferred: a guess.",
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      entities: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "The people, places and things it is about, by name.",
      },
      validFrom: { type: "string", description: "YYYY-MM-DD: when it starts being true." },
      invalidAt: { type: "string", description: "YYYY-MM-DD: when it stops being true." },
      abstract: { type: "string", description: "One line that sums it up." },
      scope: {
        type: "string",
        description: "Where to save it; the owner's global memory when left out.",
      },
      path: { type: "string", description: "A found note's path, to write its new version." },
    },
    required: ["title", "body", "kind", "level"],
    additionalProperties: false,
  },
};

/** The fields `memory_write` passes on; anything else the model sends is dropped. */
const WRITE_FIELDS = [
  "title",
  "body",
  "kind",
  "level",
  "confidence",
  "entities",
  "validFrom",
  "invalidAt",
  "abstract",
  "scope",
  "path",
] as const;

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
      if (found.ok) return { output: found.text === "" ? "No notes match." : found.text };
      if (found.reason === "vault_off") return invalid("Memory is off: the vault isn't connected.");
      // The host answers "The tool failed." without passing the store's reason on.
      throw new Error(`search: ${found.reason}`);
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
  const write: Tool = {
    spec: WRITE,
    label: "Saving to memory",
    async run(input: unknown, context: ToolContext): Promise<ToolOutcome> {
      const key = `${context.agentId}\n${context.source}\n${context.turn}`;
      const turn = turns.get(key) ?? { writes: 0, failures: 0 };
      if (!turns.has(key)) {
        turns.set(key, turn);
        // The oldest turn's counts go first; a Map keeps insertion order.
        if (turns.size > KEPT_TURNS) turns.delete(turns.keys().next().value as string);
      }
      if (turn.failures >= MAX_WRITE_FAILURES) {
        return invalid(
          `Not saved: memory writes failed ${MAX_WRITE_FAILURES} times in this turn. Stop retrying them.`,
        );
      }
      if (turn.writes >= MAX_WRITES) {
        return invalid(
          `Not saved: this turn already saved ${MAX_WRITES} memories. Finish with what you have.`,
        );
      }
      let outcome: ToolOutcome;
      try {
        outcome = await saved(input, context);
      } catch (error) {
        // A store that fails or doesn't answer is a failure too.
        turn.failures += 1;
        throw error;
      }
      if (outcome.isError) turn.failures += 1;
      else turn.writes += 1;
      return outcome;
    },
  };
  async function saved(input: unknown, context: ToolContext): Promise<ToolOutcome> {
    const given = fields(input);
    const { title, body, kind, level } = given;
    if (
      [title, body, kind, level].some((field) => typeof field !== "string" || field.trim() === "")
    ) {
      return invalid("Not saved: title, body, kind and level are required, as text.");
    }
    const memory = Object.fromEntries(
      // A field sent as null is one left out.
      WRITE_FIELDS.filter((key) => given[key] !== undefined && given[key] !== null).map((key) => [
        key,
        given[key],
      ]),
    ) as unknown as MemoryWriteInput;
    const result = await store.writeNote(context.agentId, memory, {
      scopes: context.scopes,
      sources: [context.source],
    });
    if (result.ok) {
      return {
        output:
          result.action === "written"
            ? `Saved to ${result.path}. This is done; don't save it again.`
            : `Already in memory, at ${result.path}. Nothing was saved.`,
      };
    }
    switch (result.reason) {
      case "invalid":
        return invalid(`Not saved: ${result.problems.join("; ")}.`);
      case "not_found":
        return invalid(
          "Not saved: there is no note at that path in the memory this conversation can see.",
        );
      case "scope_not_allowed":
        return invalid(
          "Not saved: this conversation can't save to that scope. Choose one it sees, or leave scope out for the owner's global memory.",
        );
      case "too_large":
        return invalid("Not saved: the note is too large. Save less, or split it.");
      case "vault_off":
        return invalid("Memory is off: the vault isn't connected.");
      default:
        // The host answers "The tool failed." without passing the store's reason on.
        throw new Error(`writeNote: ${result.reason}`);
    }
  }
  return {
    async tools() {
      return [search, read, write];
    },
  };
}
