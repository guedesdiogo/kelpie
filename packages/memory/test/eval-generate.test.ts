import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildVault } from "../eval/generate.ts";
import { GOLD_MEMORIES } from "../eval/gold-vault.ts";
import { QUESTIONS } from "../eval/questions.ts";
import { foldKey, MemoryIndex, readNote } from "../src/index.ts";

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

  it("labels each version with the commit that wrote it, and 'as of' finds that version", async () => {
    const vault = await buildVault(300);
    for (const memory of GOLD_MEMORIES) {
      memory.versions.forEach((version, index) => {
        const label = vault.labels.get(`${memory.key}@${index + 1}`);
        const change = vault.commits
          .find((commit) => commit.sha === label?.commit)
          ?.changes.find((c) => c.path === label?.path);
        expect(readNote(label?.path ?? "", change?.content ?? "")?.body, memory.key).toContain(
          version.body,
        );
      });
    }
    await runInDurableObject(env.INDEX_HOST.getByName("eval-labels"), async (_instance, state) => {
      const index = new MemoryIndex(state.storage);
      for (const commit of vault.commits) await index.applyCommit(commit);
      for (const question of QUESTIONS.filter((q) => q.asOf)) {
        for (const key of question.gold) {
          const label = vault.labels.get(key);
          const at = Date.parse(`${question.asOf}T23:59:59Z`);
          expect(index.versionAt(label?.path ?? "", at)?.commit, question.id).toBe(label?.commit);
        }
      }
    });
  });

  it("never gives a distractor the name of a gold person or place", async () => {
    const vault = await buildVault(3_000);
    const gold = new Set(GOLD_MEMORIES.map((memory) => memory.key));
    const goldPaths = new Set([...vault.labels.values()].map((label) => label.path));
    const names = GOLD_MEMORIES.filter((m) => m.kind === "person" || m.kind === "place").map((m) =>
      foldKey(m.title),
    );
    expect(gold.size).toBe(GOLD_MEMORIES.length);
    for (const commit of vault.commits) {
      for (const change of commit.changes) {
        if (goldPaths.has(change.path)) continue;
        const title = foldKey(readNote(change.path, change.content ?? "")?.title ?? "");
        expect(
          names.find((name) => title.startsWith(name)),
          change.path,
        ).toBeUndefined();
      }
    }
  });
});
