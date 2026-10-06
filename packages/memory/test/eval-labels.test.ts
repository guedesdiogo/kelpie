import { describe, expect, it } from "vitest";
import { GOLD_MEMORIES } from "../eval/gold-vault.ts";
import { LABELS_SHA256, labelsHash, WRITE_SET_SHA256, writeSetHash } from "../eval/labels.ts";
import { CATEGORIES, QUESTIONS } from "../eval/questions.ts";
import { WRITE_PAIRS } from "../eval/write-decision-set.ts";
import { isDate, memoryPath, writeMemory } from "../src/index.ts";

const byKey = new Map(GOLD_MEMORIES.map((memory) => [memory.key, memory]));

/** The version a label names, with the date the next one replaced it. */
function version(label: string) {
  const [key, n] = label.split("@") as [string, string | undefined];
  const memory = byKey.get(key);
  if (!memory) return null;
  const index = n === undefined ? memory.versions.length - 1 : Number(n) - 1;
  const found = memory.versions[index];
  return found ? { ...found, replacedOn: memory.versions[index + 1]?.at ?? null } : null;
}

describe("the evaluation's labels", () => {
  it("are frozen: a change needs a new hash and a new baseline", async () => {
    expect(await labelsHash()).toBe(LABELS_SHA256);
  });

  it("describe gold memories Kelpie could have written", async () => {
    expect(new Set(GOLD_MEMORIES.map((memory) => memory.key)).size).toBe(GOLD_MEMORIES.length);
    const paths = GOLD_MEMORIES.map((memory) =>
      memoryPath(memory.scope ?? "global", memory.kind, memory.title, memory.date),
    );
    expect(new Set(paths).size).toBe(paths.length);
    for (const memory of GOLD_MEMORIES) {
      const dates = memory.versions.map((v) => v.at);
      expect(dates.every(isDate), memory.key).toBe(true);
      expect([...dates].sort(), memory.key).toEqual(dates);
      for (const v of memory.versions) {
        await writeMemory(
          {
            scope: memory.scope ?? "global",
            kind: memory.kind,
            title: memory.title,
            body: v.body,
            level: "explicit",
            confidence: 0.9,
            ...(v.entities ? { entities: v.entities } : {}),
            ...(v.validFrom ? { validFrom: v.validFrom } : {}),
            ...(v.invalidAt ? { invalidAt: v.invalidAt } : {}),
          },
          { at: `${v.at}T12:00:00Z` },
        );
      }
    }
  });

  it("are 150 questions, each pointing at versions that exist", () => {
    expect(QUESTIONS).toHaveLength(150);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(150);
    for (const category of CATEGORIES) {
      expect(
        QUESTIONS.some((q) => q.category === category),
        category,
      ).toBe(true);
    }
    for (const question of QUESTIONS) {
      for (const label of [...question.gold, ...(question.stale ?? [])]) {
        expect(version(label), `${question.id}: ${label}`).not.toBeNull();
      }
      if (question.category === "multi-hop") expect(question.gold.length).toBeGreaterThan(1);
      if (question.asOf) expect(isDate(question.asOf), question.id).toBe(true);
      if (question.validAt) expect(isDate(question.validAt), question.id).toBe(true);
    }
  });

  it("ask 'as of' a date the labelled version covers", () => {
    for (const question of QUESTIONS.filter((q) => q.asOf)) {
      for (const label of question.gold) {
        const v = version(label);
        // The gold is written at noon and asked about at the end of `asOf`.
        expect(v && v.at <= (question.asOf ?? ""), `${question.id}: ${label}`).toBe(true);
        expect(v?.replacedOn === null || (v?.replacedOn ?? "") > (question.asOf ?? "")).toBe(true);
      }
    }
  });

  it("ask 'valid at' a date the labelled commitment holds", () => {
    for (const question of QUESTIONS.filter((q) => q.validAt)) {
      const at = question.validAt ?? "";
      for (const label of question.gold) {
        const v = version(label);
        expect(v?.validFrom === undefined || (v.validFrom ?? "") <= at, question.id).toBe(true);
        expect(v?.invalidAt === undefined || (v.invalidAt ?? "") > at, question.id).toBe(true);
      }
    }
  });
});

describe("the write decision's labeled set (#149)", () => {
  it("is frozen: a change needs a new hash and a new measurement", async () => {
    expect(await writeSetHash()).toBe(WRITE_SET_SHA256);
  });

  it("holds 20 pairs of each relation, each a memory and a note Kelpie could write", async () => {
    expect(new Set(WRITE_PAIRS.map((pair) => pair.id)).size).toBe(WRITE_PAIRS.length);
    for (const label of ["duplicate", "refines", "replaces", "unrelated"]) {
      expect(
        WRITE_PAIRS.filter((pair) => pair.label === label),
        label,
      ).toHaveLength(20);
    }
    for (const pair of WRITE_PAIRS) {
      for (const side of [pair.memory, pair.note]) {
        await writeMemory(
          { scope: "global", kind: "note", ...side, level: "explicit", confidence: 0.9 },
          { at: "2026-10-01T00:00:00Z" },
        );
      }
    }
  });
});
