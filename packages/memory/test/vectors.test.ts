import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type Judge,
  MemoryIndex,
  type MemoryInput,
  memoryPath,
  rerank,
  retrieve,
  writeMemory,
} from "../src/index.ts";
import { FakeVault } from "./vault.ts";

const MODEL = "test-model";

/** Runs a test against an index of these memories, one commit each. */
async function withMemories(
  name: string,
  memories: readonly MemoryInput[],
  run: (index: MemoryIndex) => Promise<void> | void,
) {
  await runInDurableObject(env.INDEX_HOST.getByName(name), async (_instance, state) => {
    const index = new MemoryIndex(state.storage);
    const vault = new FakeVault();
    for (const memory of memories) {
      const { text } = await writeMemory(memory, { at: "2026-10-01T00:00:00Z" });
      await index.applyCommit(
        vault.commit({ [memoryPath(memory.scope, memory.kind, memory.title)]: text }),
      );
    }
    await run(index);
  });
}

const note = (
  title: string,
  body: string,
  scope: MemoryInput["scope"] = "global",
): MemoryInput => ({
  scope,
  kind: "note",
  title,
  body,
  level: "explicit",
  confidence: 0.9,
});

/** A toy embedding: one dimension per topic word, so similarity is easy to predict. */
const TOPICS = ["mudança", "café", "trabalho", "viagem"];
const embed = (text: string) =>
  TOPICS.map((topic) => (text.toLowerCase().includes(topic) ? 1 : 0.01));

async function embedAll(index: MemoryIndex) {
  const missing = index.embeddingTexts(MODEL);
  index.putEmbeddings(
    MODEL,
    missing.map(({ blobSha, text }) => ({ blobSha, vector: embed(text) })),
  );
  return missing.length;
}

describe("embeddings in the index", () => {
  it("lists the current notes without a vector, once each, and keeps what it is given", async () => {
    await withMemories(
      "embedding-texts",
      [note("Porto", "A mudança para o Porto."), note("Café", "Café coado, sem açúcar.")],
      async (index) => {
        const missing = index.embeddingTexts(MODEL);
        expect(missing).toHaveLength(2);
        expect(missing.map((item) => item.text).join(" ")).toContain("A mudança para o Porto.");
        expect(await embedAll(index)).toBe(2);
        expect(index.embeddingTexts(MODEL)).toEqual([]);
        expect(index.embeddingTexts("another-model")).toHaveLength(2);
      },
    );
  });

  it("finds notes by meaning, best first, within scopes", async () => {
    await withMemories(
      "vector-hits",
      [
        note("Porto", "Ana fez a mudança para o Porto."),
        note("Café", "Café coado, sem açúcar."),
        note("Viagem", "A viagem de dezembro.", "conversation/telegram-1"),
      ],
      async (index) => {
        await embedAll(index);
        const query = embed("como foi a mudança?");
        expect(index.vectorHits(MODEL, query, { limit: 2 }).map((hit) => hit.title)).toEqual([
          "Porto",
          expect.any(String),
        ]);
        expect(
          index.vectorHits(MODEL, embed("viagem"), { scopes: ["global"] }).map((hit) => hit.title),
        ).not.toContain("Viagem");
        expect(index.vectorHits("another-model", query)).toEqual([]);
        expect(index.vectorHits(MODEL, [1, 2])).toEqual([]);
      },
    );
  });
});

describe("retrieve with vectors", () => {
  it("finds a note that shares no word with the question", async () => {
    await withMemories(
      "vector-stream",
      [note("Porto", "Ana fez a mudança para o Porto."), note("Café", "Café coado, sem açúcar.")],
      async (index) => {
        await embedAll(index);
        const plain = retrieve(index, "Onde ela foi morar?");
        expect(plain.map((hit) => hit.title)).not.toContain("Porto");
        const hits = retrieve(index, "Onde ela foi morar?", {
          vector: { model: MODEL, query: embed("mudança") },
        });
        expect(hits[0]?.title).toBe("Porto");
        expect(hits[0]?.streams).toContain("vector");
        const past = retrieve(index, "Onde ela foi morar?", {
          vector: { model: MODEL, query: embed("mudança") },
          asOf: Date.parse("2030-01-01T00:00:00Z"),
        });
        expect(past.every((hit) => !hit.streams.includes("vector"))).toBe(true);
      },
    );
  });
});

describe("rerank", () => {
  const notes = Array.from({ length: 12 }, (_, i) => note(`Nota ${i}`, `trabalho número ${i}`));

  it("reorders the best hits by the judge's scores, and leaves the rest", async () => {
    await withMemories("rerank", notes, async (index) => {
      const hits = retrieve(index, "trabalho", { limit: 12 });
      const fused = hits.map((hit) => hit.title);
      const judge: Judge = async (_question, candidates) =>
        Object.fromEntries(
          candidates.map((candidate) => [
            candidate.id,
            candidate.text.includes("número 7") ? 0.99 : 0.1,
          ]),
        );
      const reranked = await rerank(index, "trabalho", hits, judge, { candidates: 4 });
      const top4 = fused.slice(0, 4);
      if (top4.includes("Nota 7")) expect(reranked[0]?.title).toBe("Nota 7");
      expect(new Set(reranked.slice(0, 4).map((hit) => hit.title))).toEqual(new Set(top4));
      expect(reranked.slice(4).map((hit) => hit.title)).toEqual(fused.slice(4));
    });
  });

  it("keeps the fused order when the judge fails or answers in part", async () => {
    await withMemories("rerank-fails", notes, async (index) => {
      const hits = retrieve(index, "trabalho", { limit: 12 });
      const failing: Judge = async () => {
        throw new Error("timeout");
      };
      const partial: Judge = async (_question, candidates) => ({
        [candidates[0]?.id ?? "x"]: 0.9,
      });
      const none: Judge = async () => null;
      for (const judge of [failing, partial, none]) {
        expect((await rerank(index, "trabalho", hits, judge)).map((hit) => hit.title)).toEqual(
          hits.map((hit) => hit.title),
        );
      }
    });
  });

  it("gives the judge each note's title and start, and no more than 30", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      note(`Nota ${i}`, `trabalho ${"palavra ".repeat(400)}`),
    );
    await withMemories("rerank-input", many, async (index) => {
      const hits = retrieve(index, "trabalho", { limit: 40 });
      let seen: { id: string; text: string }[] = [];
      await rerank(index, "trabalho", hits, async (_question, candidates) => {
        seen = candidates;
        return null;
      });
      expect(seen).toHaveLength(30);
      expect(seen.every((candidate) => candidate.text.length <= 600)).toBe(true);
      expect(seen[0]?.text.startsWith("Nota")).toBe(true);
    });
  });
});
