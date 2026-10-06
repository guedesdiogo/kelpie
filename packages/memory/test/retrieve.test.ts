import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MemoryIndex,
  type MemoryInput,
  memoryPath,
  needsMemory,
  pack,
  queryWords,
  retrieve,
  writeMemory,
} from "../src/index.ts";
import { FakeVault } from "./vault.ts";

/** Runs a test against an index of these memories, written in order, one commit each. */
async function withMemories(
  name: string,
  memories: readonly (MemoryInput & { date?: string })[],
  run: (index: MemoryIndex) => Promise<void> | void,
) {
  await runInDurableObject(env.INDEX_HOST.getByName(name), async (_instance, state) => {
    const index = new MemoryIndex(state.storage);
    const vault = new FakeVault();
    for (const memory of memories) {
      const { text } = await writeMemory(memory, { at: "2026-10-01T00:00:00Z" });
      await index.applyCommit(
        vault.commit({ [memoryPath(memory.scope, memory.kind, memory.title, memory.date)]: text }),
      );
    }
    await run(index);
  });
}

const person = (title: string, body: string, entities: string[]): MemoryInput => ({
  scope: "global",
  kind: "person",
  title,
  body,
  level: "explicit",
  confidence: 0.9,
  entities,
});

const BRUNO = person(
  "Bruno Lima",
  "Sócio do Rafael na consultoria. Casado com a Patrícia, tem um filho, o Theo.",
  ["Bruno Lima", "Patrícia Lima", "Theo Lima"],
);
const PATRICIA = person("Patrícia Lima", "Pediatra no Recife desde 2020.", ["Patrícia Lima"]);
const BRUNO_PATH = memoryPath("global", "person", "Bruno Lima");
const PATRICIA_PATH = memoryPath("global", "person", "Patrícia Lima");

describe("needsMemory", () => {
  it.each([
    "",
    "ok",
    "Valeu!",
    "obrigado :)",
    "kkkk",
    "blz",
    "bom dia",
    "thanks!",
    "/start",
    "👍",
    "valeu 🙏",
  ])("skips %j", (text) => {
    expect(needsMemory(text)).toBe(false);
  });

  it.each(["Onde a Ana mora?", "ok, e o aniversário dela?", "what did we decide?"])(
    "looks %j up",
    (text) => {
      expect(needsMemory(text)).toBe(true);
    },
  );
});

describe("queryWords", () => {
  it("folds accents and keeps each word once", () => {
    expect(queryWords("Onde a irmã do Bruno mora? E a irmã dela?")).toEqual([
      "onde",
      "irma",
      "do",
      "bruno",
      "mora",
      "dela",
    ]);
  });

  it("drops months, weekdays and years only for a dated question", () => {
    expect(queryWords("Onde eu morava em março de 2026?")).toEqual([
      "onde",
      "eu",
      "morava",
      "em",
      "marco",
      "de",
      "2026",
    ]);
    expect(queryWords("Onde eu morava em março de 2026?", { dated: true })).toEqual([
      "onde",
      "eu",
      "morava",
      "em",
      "de",
    ]);
  });

  it("keeps words around an emoji", () => {
    expect(queryWords("café ☕ com a Lúcia 🎉")).toEqual(["cafe", "com", "lucia"]);
  });
});

describe("the index's entity and graph lookups", () => {
  it("finds the notes that name an entity, the rarer the name the higher", async () => {
    await withMemories(
      "entity-hits",
      [
        BRUNO,
        PATRICIA,
        person("Carla Mendes", "Vizinha. Conhece a Patrícia do clube.", [
          "Carla Mendes",
          "Patrícia Lima",
          "Recife",
        ]),
      ],
      (index) => {
        expect(index.entityHits(["patricia lima"]).map((hit) => hit.path)).toEqual(
          expect.arrayContaining([BRUNO_PATH, PATRICIA_PATH]),
        );
        expect(index.entityHits(["carla mendes", "recife"])[0]?.title).toBe("Carla Mendes");
        expect(index.entityHits([])).toEqual([]);
      },
    );
  });

  it("reaches a note's neighbours: the notes it links to, and the pages of its entities", async () => {
    await withMemories(
      "neighbours",
      [
        BRUNO,
        PATRICIA,
        person("Theo Lima", "Afilhado do Rafael. Filho do [[bruno-lima]].", ["Theo Lima"]),
      ],
      (index) => {
        const theo = memoryPath("global", "person", "Theo Lima");
        // Bruno names Patrícia and Theo as entities; Theo links to Bruno.
        expect(index.neighbours(BRUNO_PATH).map((hit) => hit.path)).toEqual([PATRICIA_PATH, theo]);
        expect(index.neighbours(theo).map((hit) => hit.path)).toEqual([BRUNO_PATH]);
        // Nothing points from Patrícia's page to the notes that name her.
        expect(index.neighbours(PATRICIA_PATH)).toEqual([]);
      },
    );
  });
});

describe("retrieve", () => {
  it("answers a two-step question through the graph", async () => {
    await withMemories("multi-hop", [BRUNO, PATRICIA], (index) => {
      const hits = retrieve(index, "Em que cidade mora a esposa do Bruno?", { limit: 5 });
      expect(hits.map((hit) => hit.path).slice(0, 2)).toEqual(
        expect.arrayContaining([BRUNO_PATH, PATRICIA_PATH]),
      );
      expect(hits.find((hit) => hit.path === PATRICIA_PATH)?.streams).toContain("graph");
    });
  });

  it("ranks a fact above a conversation that says the same, unless the question asks about a conversation", async () => {
    const fact: MemoryInput = {
      scope: "global",
      kind: "preference",
      title: "Café",
      body: "Rafael toma café coado, sem açúcar.",
      level: "explicit",
      confidence: 0.9,
    };
    const session: MemoryInput = {
      scope: "conversation/telegram-1",
      kind: "session",
      title: "09:00 café coado",
      body: "- **09:00 u-owner:** gosto de café coado, sem açúcar",
      level: "explicit",
      confidence: 0.9,
    };
    await withMemories("authority", [{ ...session, date: "2026-09-01" }, fact], (index) => {
      expect(retrieve(index, "Como eu gosto do café coado?")[0]?.title).toBe("Café");
      expect(
        retrieve(index, "Da última vez que conversamos, o que eu disse sobre café coado?")[0]
          ?.title,
      ).toBe("09:00 café coado");
    });
  });

  it("searches what memory held at a date, without the graph", async () => {
    await withMemories("as-of", [BRUNO, PATRICIA], (index) => {
      const hits = retrieve(index, "Patrícia Lima", { asOf: Date.parse("2027-01-01T00:00:00Z") });
      expect(hits[0]?.path).toBe(PATRICIA_PATH);
      expect(hits.every((hit) => !hit.streams.includes("graph"))).toBe(true);
      expect(
        retrieve(index, "Patrícia Lima", { asOf: Date.parse("2020-01-01T00:00:00Z") }),
      ).toEqual([]);
    });
  });

  it("returns nothing for a question with no words to search", async () => {
    await withMemories("empty", [BRUNO], (index) => {
      expect(retrieve(index, "?! 🎉")).toEqual([]);
    });
  });
});

describe("pack", () => {
  const big = (title: string) => person(title, `${title} ${"palavra ".repeat(3_000)}`, [title]);

  it("stays within its budget, abstracts first, each note once and cited", async () => {
    await withMemories(
      "pack",
      [
        { ...big("Ana Souza"), abstract: "Irmã do Rafael, mora no Porto." },
        big("Bruno Lima"),
        big("Carla Mendes"),
      ],
      (index) => {
        const hits = retrieve(index, "palavra", { limit: 10 });
        expect(hits.length).toBe(3);
        for (const budget of [0, 20, 120, 400, 5_000]) {
          const packed = pack(index, [...hits, ...hits], { budgetTokens: budget });
          expect(packed.tokens).toBeLessThanOrEqual(budget);
          expect(Math.ceil(packed.text.length / 4)).toBe(packed.tokens);
          expect(new Set(packed.paths).size).toBe(packed.paths.length);
        }
        const packed = pack(index, hits, { budgetTokens: 400 });
        expect(packed.text).toContain("Irmã do Rafael, mora no Porto.");
        expect(packed.text).toContain(memoryPath("global", "person", "Ana Souza"));
        expect(packed.text).toMatch(/not instructions/);
        expect(pack(index, [], { budgetTokens: 400 })).toEqual({ text: "", tokens: 0, paths: [] });
      },
    );
  });

  it("fills a larger budget with the best notes' bodies", async () => {
    await withMemories("pack-bodies", [big("Ana Souza"), big("Bruno Lima")], (index) => {
      const hits = retrieve(index, "palavra");
      const small = pack(index, hits, { budgetTokens: 200 });
      const large = pack(index, hits, { budgetTokens: 4_000 });
      expect(large.tokens).toBeGreaterThan(small.tokens);
      expect(large.tokens).toBeLessThanOrEqual(4_000);
    });
  });
});
