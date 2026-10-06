import { describe, expect, it } from "vitest";
import { buildVault } from "../eval/generate.ts";
import { GOLD_MEMORIES } from "../eval/gold-vault.ts";
import { readNote } from "../src/index.ts";

describe("the synthetic vault", () => {
  it("is the same for the same size and seed", async () => {
    const [a, b] = await Promise.all([buildVault(300), buildVault(300)]);
    expect(a.commits).toEqual(b.commits);
    expect([...a.labels]).toEqual([...b.labels]);
    expect((await buildVault(300, 1)).commits).not.toEqual(a.commits);
  });

  it("holds the requested number of memories, the gold among them", async () => {
    const vault = await buildVault(300);
    expect(vault.memories).toBe(300);
    for (const memory of GOLD_MEMORIES) {
      expect(vault.labels.get(memory.key), memory.key).toEqual(
        vault.labels.get(`${memory.key}@${memory.versions.length}`),
      );
    }
    await expect(buildVault(10)).rejects.toThrow(RangeError);
  });

  it("commits in time order, with files Kelpie's reader takes without a warning", async () => {
    const vault = await buildVault(300);
    const times = vault.commits.map((commit) => commit.committedAt);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    for (const commit of vault.commits) {
      for (const change of commit.changes) {
        expect(readNote(change.path, change.content ?? "")?.warnings, change.path).toEqual([]);
      }
    }
  });
});
