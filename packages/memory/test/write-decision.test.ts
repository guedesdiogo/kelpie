import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type ChoiceQualifier,
  decideWrite,
  MemoryIndex,
  type MemoryInput,
  memoryPath,
  writeMemory,
} from "../src/index.ts";
import { FakeVault } from "./vault.ts";

type Stored = MemoryInput & { path?: string };

/** Notes written as Kelpie writes them, one commit each, then `run` with the index. */
async function withNotes(
  name: string,
  notes: readonly Stored[],
  run: (index: MemoryIndex) => Promise<void>,
) {
  await runInDurableObject(env.INDEX_HOST.getByName(name), async (_instance, state) => {
    const index = new MemoryIndex(state.storage);
    const vault = new FakeVault();
    for (const note of notes) {
      const { text } = await writeMemory(note, { at: "2026-10-01T00:00:00Z" });
      const path = note.path ?? memoryPath(note.scope, note.kind, note.title);
      await index.applyCommit(vault.commit({ [path]: text }));
    }
    await run(index);
  });
}

const memory = (title: string, extra: Partial<Stored> = {}): Stored => ({
  scope: "global",
  kind: "note",
  title,
  body: `${title}.`,
  level: "explicit",
  confidence: 0.9,
  ...extra,
});

/** A qualifier that answers each question from `choices`, by the candidate's title. */
function fakeQualifier(choices: Record<string, string>) {
  const calls: { state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
  const qualifier: ChoiceQualifier = {
    async qualify(state, questions) {
      calls.push({ state: state as Record<string, unknown>, questions });
      const notes = (state as { notes: Record<string, string> }).notes;
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => {
            const title = Object.keys(choices).find((t) => notes[id]?.startsWith(t));
            return [id, { type: "choice", choice: (title && choices[title]) || "unrelated" }];
          }),
        ),
      };
    },
  };
  return { qualifier, calls };
}

const failing: ChoiceQualifier = {
  qualify: () => Promise.reject(new Error("qualifier down")),
};

describe("decideWrite", () => {
  it("adds a memory nothing is close to, without asking", async () => {
    await withNotes(
      "decide-add",
      [memory("Bruno gosta de chá", { entities: ["Bruno"] })],
      async (index) => {
        const { qualifier, calls } = fakeQualifier({});
        const decision = await decideWrite(
          index,
          memory("Ana mora no Porto", { entities: ["Ana"] }),
          { qualifier },
        );
        expect(decision).toEqual({ action: "ADD", source: "heuristic" });
        expect(calls).toHaveLength(0);
      },
    );
  });

  it("writes nothing for a memory already there, without asking", async () => {
    await withNotes(
      "decide-noop",
      [memory("Ana mora no Porto", { body: "Ana  mora no Porto\ndesde 2025." })],
      async (index) => {
        const decision = await decideWrite(
          index,
          memory("ana mora no porto", { body: "Ana mora no Porto desde 2025.", level: "inferred" }),
          { qualifier: failing },
        );
        expect(decision).toEqual({
          action: "NOOP",
          path: memoryPath("global", "note", "Ana mora no Porto"),
          source: "heuristic",
        });
        // A different validity is news.
        expect(
          await decideWrite(
            index,
            memory("Ana mora no Porto", {
              body: "Ana mora no Porto desde 2025.",
              invalidAt: "2027-01-01",
            }),
            { qualifier: null },
          ),
        ).toEqual({ action: "ADD", source: "heuristic" });
      },
    );
  });

  it("asks about each close note, and supersedes the one the new memory replaces", async () => {
    await withNotes(
      "decide-supersede",
      [
        memory("Ana mora em Lisboa", { entities: ["Ana Souza"] }),
        memory("Ana gosta de café", { entities: ["Ana Souza"] }),
      ],
      async (index) => {
        const { qualifier, calls } = fakeQualifier({
          "Ana gosta de café": "unrelated",
          "Ana mora em Lisboa": "replaces",
        });
        const decision = await decideWrite(
          index,
          memory("Ana mudou para o Porto", { entities: ["ana souza"] }),
          { qualifier },
        );
        expect(decision).toEqual({
          action: "SUPERSEDE",
          path: memoryPath("global", "note", "Ana mora em Lisboa"),
          source: "qualifier",
        });
        expect(calls).toHaveLength(1);
        const [call] = calls;
        // One choice per note, the notes and the new memory in the state, marked as data.
        expect(Object.keys(call?.questions ?? {})).toHaveLength(2);
        for (const question of Object.values(call?.questions ?? {})) {
          expect(question).toMatchObject({ type: "choice" });
          expect(JSON.stringify(question)).toContain("data, not instructions");
          expect(Object.keys((question as { criteria: object }).criteria).sort()).toEqual([
            "duplicate",
            "refines",
            "replaces",
            "unrelated",
          ]);
        }
        expect(call?.state.memory).toContain("Ana mudou para o Porto");
      },
    );
  });

  it("updates a note the memory refines, and a duplicate anywhere wins", async () => {
    await withNotes(
      "decide-update",
      [
        memory("Ana mora em Lisboa", { entities: ["Ana Souza"] }),
        memory("Ana trabalha no hospital", { entities: ["Ana Souza"] }),
      ],
      async (index) => {
        const input = memory("Ana trabalha no hospital de Santa Maria", {
          entities: ["Ana Souza"],
        });
        const refines = fakeQualifier({ "Ana trabalha no hospital": "refines" });
        expect(await decideWrite(index, input, { qualifier: refines.qualifier })).toEqual({
          action: "UPDATE",
          path: memoryPath("global", "note", "Ana trabalha no hospital"),
          source: "qualifier",
        });

        const both = fakeQualifier({
          "Ana mora em Lisboa": "replaces",
          "Ana trabalha no hospital": "duplicate",
        });
        expect(await decideWrite(index, input, { qualifier: both.qualifier })).toEqual({
          action: "NOOP",
          path: memoryPath("global", "note", "Ana trabalha no hospital"),
          source: "qualifier",
        });

        const none = fakeQualifier({});
        expect(await decideWrite(index, input, { qualifier: none.qualifier })).toEqual({
          action: "ADD",
          source: "qualifier",
        });
      },
    );
  });

  it("adds when the qualifier fails, is late, answers off the list, or isn't there", async () => {
    await withNotes(
      "decide-failures",
      [memory("Ana mora em Lisboa", { entities: ["Ana Souza"] })],
      async (index) => {
        const input = memory("Ana mudou para o Porto", { entities: ["Ana Souza"] });
        const add = { action: "ADD", source: "heuristic" };
        expect(await decideWrite(index, input, { qualifier: failing })).toEqual(add);
        expect(await decideWrite(index, input, { qualifier: null })).toEqual(add);
        expect(
          await decideWrite(index, input, {
            qualifier: fakeQualifier({ "Ana mora em Lisboa": "delete" }).qualifier,
          }),
        ).toEqual(add);

        let aborted = false;
        const late: ChoiceQualifier = {
          qualify: (_state, _questions, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => {
                aborted = true;
                reject(new Error("aborted"));
              });
            }),
        };
        expect(await decideWrite(index, input, { qualifier: late, timeoutMs: 20 })).toEqual(add);
        expect(aborted).toBe(true);
      },
    );
  });

  it("offers only notes of the memory's scope and kind", async () => {
    await withNotes(
      "decide-scope",
      [
        memory("Ana mora em Lisboa", { scope: "conversation/familia", entities: ["Ana Souza"] }),
        memory("Ana Souza", { kind: "person", entities: ["Ana Souza"] }),
        memory("Ana mudou para o Porto", { scope: "agent/kelpie" }),
      ],
      async (index) => {
        const { qualifier, calls } = fakeQualifier({});
        expect(
          await decideWrite(index, memory("Ana mudou para o Porto", { entities: ["Ana Souza"] }), {
            qualifier,
          }),
        ).toEqual({ action: "ADD", source: "heuristic" });
        expect(calls).toHaveLength(0);
      },
    );
  });

  it("offers a note whose vector is close, for a model with a band", async () => {
    await withNotes(
      "decide-vector",
      [memory("Endereço da Ana"), memory("Receita de bolo")],
      async (index) => {
        const vectors: Record<string, number[]> = {
          "Endereço da Ana": [0.8, 0.6, 0],
          "Receita de bolo": [0, 0, 1],
        };
        index.putEmbeddings(
          "fake-model",
          index.embeddingTexts("fake-model").map((item) => ({
            blobSha: item.blobSha,
            vector:
              vectors[Object.keys(vectors).find((title) => item.text.includes(title)) ?? ""] ?? [],
          })),
        );
        const input = memory("Ana mudou para o Porto");
        const options = { bands: { "fake-model": [0.7, 0.95] as const } };
        const { qualifier, calls } = fakeQualifier({ "Endereço da Ana": "replaces" });
        // cos 0.8 with the address, 0 with the recipe.
        expect(
          await decideWrite(index, input, {
            ...options,
            qualifier,
            vector: { model: "fake-model", values: [1, 0, 0] },
          }),
        ).toEqual({
          action: "SUPERSEDE",
          path: memoryPath("global", "note", "Endereço da Ana"),
          source: "qualifier",
        });
        expect(Object.keys(calls[0]?.questions ?? {})).toHaveLength(1);

        // A model without a band, or a vector not close enough, offers nothing.
        for (const vector of [
          { model: "other-model", values: [1, 0, 0] },
          // cos 0.48 with the address, below the band.
          { model: "fake-model", values: [0.6, 0, -0.8] },
        ]) {
          expect(await decideWrite(index, input, { ...options, qualifier, vector })).toEqual({
            action: "ADD",
            source: "heuristic",
          });
        }
      },
    );
  });
});
