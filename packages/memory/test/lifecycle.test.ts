import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_REPORT_PATH,
  lifecycleFindings,
  lifecycleReport,
  MemoryIndex,
  type MemoryInput,
  memoryPath,
  placeOf,
  writeMemory,
} from "../src/index.ts";
import { FakeVault } from "./vault.ts";

/** Notes written as Kelpie writes them, one commit each, from 2026-10-01 on (FakeVault's clock). */
async function withNotes(
  name: string,
  notes: readonly (MemoryInput & { date?: string; path?: string })[],
  run: (index: MemoryIndex) => void,
) {
  await runInDurableObject(env.INDEX_HOST.getByName(name), async (_instance, state) => {
    const index = new MemoryIndex(state.storage);
    const vault = new FakeVault();
    for (const note of notes) {
      const { text } = await writeMemory(note, { at: "2026-10-01T00:00:00Z" });
      const path = note.path ?? memoryPath(note.scope, note.kind, note.title, note.date);
      await index.applyCommit(vault.commit({ [path]: text }));
    }
    run(index);
  });
}

const note = (title: string, extra: Partial<MemoryInput> & { date?: string; path?: string } = {}) =>
  ({
    scope: "global",
    kind: "note",
    title,
    body: `${title}.`,
    level: "explicit",
    confidence: 0.9,
    ...extra,
  }) as MemoryInput & { date?: string; path?: string };

/** About three months after the notes were written. */
const NOW = Date.parse("2027-01-01T12:00:00Z");
const DAY = 86_400_000;

describe("lifecycle findings", () => {
  it("finds sessions and events nobody recalls, and spares the rest", async () => {
    await withNotes(
      "lifecycle-cold",
      [
        note("Conversa sobre o jantar", { kind: "session", date: "2026-10-01" }),
        note("Show em outubro", { kind: "event", date: "2026-10-01" }),
        note("Conversa fixada", { kind: "session", date: "2026-10-01", pinned: true }),
        note("Aniversário de casamento", { kind: "event", date: "2026-10-01", evergreen: true }),
        note("Viagem em março", { kind: "event", date: "2027-03-01", validFrom: "2027-03-01" }),
        note("Festa em dezembro", { kind: "event", date: "2026-12-20", invalidAt: "2026-12-20" }),
        note("Conversa lembrada", { kind: "session", date: "2026-10-01" }),
        // Facts don't decay.
        note("Ana mora no Porto", { kind: "person" }),
      ],
      (index) => {
        const recalled = memoryPath("global", "session", "Conversa lembrada", "2026-10-01");
        const { cold } = lifecycleFindings(index, {
          now: NOW,
          uses: new Map([[recalled, { count: 5, lastAt: NOW - 10 * DAY }]]),
        });
        expect(cold.map((entry) => entry.title)).toEqual([
          "Show em outubro",
          "Conversa sobre o jantar",
        ]);
      },
    );
  });

  it("finds the same content at two paths, and the same title twice", async () => {
    await withNotes(
      "lifecycle-duplicates",
      [
        note("Receita de bolo"),
        note("Receita de bolo", { path: "knowledge/cozinha/receita-de-bolo.md" }),
        note("Ana Souza", { kind: "person", body: "Irmã do Rafael." }),
        note("Ana Souza", { kind: "place", body: "Rua com o nome dela." }),
        note("Nada igual"),
      ],
      (index) => {
        const { duplicates } = lifecycleFindings(index, { now: NOW, uses: new Map() });
        expect(duplicates).toEqual([
          {
            kind: "content",
            notes: [
              { path: "knowledge/cozinha/receita-de-bolo.md", title: "Receita de bolo" },
              { path: memoryPath("global", "note", "Receita de bolo"), title: "Receita de bolo" },
            ],
          },
          // The same pair under the same title too: listed once.
          {
            kind: "title",
            notes: [
              { path: memoryPath("global", "person", "Ana Souza"), title: "Ana Souza" },
              { path: memoryPath("global", "place", "Ana Souza"), title: "Ana Souza" },
            ],
          },
        ]);
      },
    );
  });

  it("flags close notes about one entity, inside the model's band only", async () => {
    await withNotes(
      "lifecycle-band",
      [
        note("Ana mora em Lisboa", { entities: ["Ana Souza"] }),
        note("Ana mora no Porto", { entities: ["Ana Souza"] }),
        note("Ana gosta de café", { entities: ["Ana Souza"] }),
        note("Bruno mora no Porto", { entities: ["Bruno Lima"] }),
      ],
      (index) => {
        const vectors: Record<string, number[]> = {
          "Ana mora em Lisboa": [1, 0, 0],
          // cos 0.6 with Lisbon: same topic, not the same note.
          "Ana mora no Porto": [0.6, 0.8, 0],
          // cos 0.95 with Porto: a near-duplicate, not a contradiction.
          "Ana gosta de café": [0.55, 0.83, 0.1],
          // Close to Porto, but about someone else.
          "Bruno mora no Porto": [0.6, 0.8, 0],
        };
        const texts = index.embeddingTexts("fake-model");
        index.putEmbeddings(
          "fake-model",
          texts.map((item) => ({
            blobSha: item.blobSha,
            vector:
              vectors[Object.keys(vectors).find((title) => item.text.includes(title)) ?? ""] ?? [],
          })),
        );
        const band = { "fake-model": [0.4, 0.75] as const };
        const flagged = lifecycleFindings(index, {
          now: NOW,
          uses: new Map(),
          model: "fake-model",
          bands: band,
        });
        expect(
          flagged.contradictions.map((pair) => [pair.notes.map((n) => n.title), pair.entity]),
        ).toEqual([
          [["Ana gosta de café", "Ana mora em Lisboa"], "Ana Souza"],
          [["Ana mora em Lisboa", "Ana mora no Porto"], "Ana Souza"],
        ]);
        // A model without a calibrated band flags nothing.
        expect(
          lifecycleFindings(index, { now: NOW, uses: new Map(), model: "other-model", bands: band })
            .contradictions,
        ).toEqual([]);
      },
    );
  });
});

describe("lifecycle report", () => {
  it("writes the findings as one page, the same page for the same findings", async () => {
    await withNotes(
      "lifecycle-report",
      [
        note("Conversa | com [colchetes]", { kind: "session", date: "2026-10-01" }),
        note("Receita de bolo"),
        note("Receita de bolo", { path: "knowledge/cozinha/receita-de-bolo.md" }),
      ],
      (index) => {
        const findings = lifecycleFindings(index, { now: NOW, uses: new Map() });
        const page = lifecycleReport(findings) ?? "";
        expect(page).toBe(
          lifecycleReport(lifecycleFindings(index, { now: NOW + DAY, uses: new Map() })),
        );
        expect(page).toContain("# Memory report");
        expect(page).toContain("## Cold notes");
        expect(page).toContain("## Duplicates");
        expect(page).not.toContain("## Possible contradictions");
        // A title can't break the link it sits in.
        expect(page).toContain("|Conversa com colchetes]]");
        expect(page).toContain("[[knowledge/cozinha/receita-de-bolo|Receita de bolo]]");
      },
    );
  });

  it("is nothing when memory is clean", () => {
    expect(lifecycleReport({ cold: [], duplicates: [], contradictions: [] })).toBeNull();
  });

  it("lives where memory never reads it", () => {
    expect(LIFECYCLE_REPORT_PATH).toBe("memory/_lint/report.md");
    expect(placeOf(LIFECYCLE_REPORT_PATH)).toBeNull();
    expect(placeOf("memory/_anything/note.md")).toBeNull();
    expect(placeOf("memory/notes/_draft.md")).not.toBeNull();
  });
});
