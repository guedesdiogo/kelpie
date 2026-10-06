// Writes docs/spikes/memory-eval-models.json from the last `eval:models` run: the gate, and each
// size's slices and per-question ranks for every configuration. Unlike the baseline, model answers
// can vary from run to run, so this file is a record, not a regression check.
import { readFileSync, writeFileSync } from "node:fs";

const report = JSON.parse(readFileSync(new URL("./last-run.json", import.meta.url), "utf8"));
const entries = report.testResults
  .flatMap((file) => file.assertionResults)
  .map((result) => result.meta?.memoryEvalModels)
  .filter((entry) => entry !== undefined);
const gate = entries.find((entry) => entry.gate)?.gate;
const runs = entries.filter((entry) => entry.size !== undefined).sort((a, b) => a.size - b.size);
if (!gate || runs.length === 0) {
  throw new Error("eval/last-run.json holds no `eval:models` run; run it first");
}
const withoutLatency = (slices) =>
  Object.fromEntries(
    Object.entries(slices).map(([name, { latencyMs: _latency, tokens: _tokens, ...metrics }]) => [
      name,
      metrics,
    ]),
  );
const out = {
  date: new Date().toISOString().slice(0, 10),
  labelsSha256: runs[0].labelsSha256,
  seed: runs[0].seed,
  limit: runs[0].limit,
  rerankCandidates: runs[0].rerankCandidates,
  gate,
  runs: runs.map((run) => ({
    size: run.size,
    timings: run.timings,
    rerankCalls: run.rerankCalls,
    configs: Object.fromEntries(
      Object.entries(run.configs).map(([name, config]) => [
        name,
        {
          slices: withoutLatency(config.slices),
          questions: config.questions.map(({ id, answerRank, staleFirst }) => ({
            id,
            answerRank,
            staleFirst,
          })),
        },
      ]),
    ),
  })),
};
writeFileSync(
  new URL("../../../docs/spikes/memory-eval-models.json", import.meta.url),
  `${JSON.stringify(out, null, 2)}\n`,
);
