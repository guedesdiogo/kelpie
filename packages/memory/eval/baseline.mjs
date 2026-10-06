// Writes docs/spikes/memory-eval-baseline.json from the last `eval` run, keeping what a re-run must
// reproduce exactly and dropping timings, which vary. After a change, run `eval` and this script,
// and `git diff` the file: a lower slice is a regression to fix, not a note to publish.
import { readFileSync, writeFileSync } from "node:fs";

const report = JSON.parse(readFileSync(new URL("./last-run.json", import.meta.url), "utf8"));
const runs = report.testResults
  .flatMap((file) => file.assertionResults)
  .map((result) => result.meta?.memoryEval)
  .filter((run) => run !== undefined)
  .sort((a, b) => a.size - b.size);
if (runs.length === 0) throw new Error("eval/last-run.json holds no evaluation; run `eval` first");

const [first] = runs;
const baseline = {
  labelsSha256: first.labelsSha256,
  seed: first.seed,
  limit: first.limit,
  packed: first.packed,
  asOfTime: first.asOfTime,
  validAtTime: first.validAtTime,
  runs: runs.map((run) => ({
    size: run.size,
    memories: run.memories,
    versions: run.versions,
    commits: run.commits,
    databaseBytes: run.databaseBytes,
    slices: Object.fromEntries(
      Object.entries(run.slices).map(([name, { latencyMs: _latency, ...metrics }]) => [
        name,
        metrics,
      ]),
    ),
    questions: run.questions.map(({ latencyMs: _latency, ...question }) => question),
  })),
};
writeFileSync(
  new URL("../../../docs/spikes/memory-eval-baseline.json", import.meta.url),
  `${JSON.stringify(baseline, null, 2)}\n`,
);

// Retrieval (#110), from the same run, beside the baseline.
const withoutLatency = (slices) =>
  Object.fromEntries(
    Object.entries(slices).map(([name, { latencyMs: _latency, ...metrics }]) => [name, metrics]),
  );
const retrieval = {
  labelsSha256: first.labelsSha256,
  seed: first.seed,
  limit: first.limit,
  budgetTokens: first.retrieval.budgetTokens,
  runs: runs.map((run) => ({
    size: run.size,
    slices: withoutLatency(run.retrieval.slices),
    questions: run.retrieval.questions.map(({ latencyMs: _latency, ...question }) => question),
    // The same retrieval with #111's expiry filter, at a fixed now.
    expiry: {
      now: run.retrieval.expiry.now,
      slices: withoutLatency(run.retrieval.expiry.slices),
      questions: run.retrieval.expiry.questions.map(
        ({ latencyMs: _latency, ...question }) => question,
      ),
    },
  })),
};
writeFileSync(
  new URL("../../../docs/spikes/memory-eval-retrieval.json", import.meta.url),
  `${JSON.stringify(retrieval, null, 2)}\n`,
);
