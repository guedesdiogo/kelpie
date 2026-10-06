// Runs the labeled set through the deployed spike Worker, Clef and Clef-flash, and through the
// heuristic (issue #117). The set and the metrics are the Jev spike's (#27).
//
//   export SPIKE_URL=https://kelpie-spike-clef.<subdomain>.workers.dev
//   read -s "SPIKE_TOKEN?Spike token: " && export SPIKE_TOKEN
//   bun spikes/clef-end-of-turn/scripts/run.ts --probe                 # one item per model, raw
//   bun spikes/clef-end-of-turn/scripts/run.ts --model clef-flash [--passes 2]
//
// Calls go one at a time, so latency isn't measured under concurrency. The first call is kept
// apart as the cold one. Results go to spikes/clef-end-of-turn/results/.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  type Bands,
  endOfTurn,
  HEURISTIC_BANDS,
  heuristicFinished,
  JEV_BANDS,
} from "@kelpie/qualifier";
import type { Model } from "../src/index.ts";
import {
  bands,
  brier,
  classification,
  distribution,
  ece,
  hybrid,
  latency,
  type Scored,
  zeroErrorBands,
} from "../src/metrics.ts";

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code: number): never;
};

interface Item {
  id: string;
  kind: string;
  fragments: string[];
  finished: boolean;
}

interface Reply {
  ok: boolean;
  ms: number;
  colo: string | null;
  raw?: { answers?: Record<string, Record<string, unknown>>; usage?: Record<string, number> };
  policy?: { finished: number } | null;
  error?: string;
}

/** Workers AI prices per input token, from each model's page (2026-10-06). */
const USD_PER_INPUT_TOKEN: Record<Model, number> = {
  clef: 0.24 / 1_000_000,
  "clef-flash": 0.09 / 1_000_000,
};
const here = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const passes = Number(option("--passes") ?? 1) || 1;

const url = process.env.SPIKE_URL ?? fail("set SPIKE_URL");
const token = process.env.SPIKE_TOKEN ?? fail("set SPIKE_TOKEN");
const { items } = JSON.parse(await readFile(`${here}data/sequences.json`, "utf8")) as {
  items: Item[];
};

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function qualify(fragments: string[], model: Model) {
  const response = await fetch(`${url}/qualify`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-spike-token": token },
    body: JSON.stringify({ fragments, model }),
  });
  if (!response.ok) fail(`the Worker answered ${response.status}`);
  return (await response.json()) as Reply;
}

const stamp = new Date().toISOString().replaceAll(":", "-");
await mkdir(`${here}results`, { recursive: true });

if (flag("--probe")) {
  const fragments = items[0]?.fragments ?? fail("empty set");
  const probes = [];
  for (const model of ["clef", "clef-flash"] as const) {
    const reply = await qualify(fragments, model);
    probes.push({ model, reply });
    console.log(JSON.stringify({ model, reply }, null, 2));
  }
  await writeFile(`${here}results/probe-${stamp}.json`, `${JSON.stringify(probes, null, 2)}\n`);
  process.exit(0);
}

const model = option("--model");
if (model !== "clef" && model !== "clef-flash") fail("set --model clef or --model clef-flash");

const cold = await qualify(items[0]?.fragments ?? fail("empty set"), model);
const calls: Array<{ id: string; pass: number } & Reply & { finished: number | null }> = [];
for (let pass = 1; pass <= passes; pass++) {
  for (const item of items) {
    const reply = await qualify(item.fragments, model);
    calls.push({ id: item.id, pass, ...reply, finished: reply.policy?.finished ?? null });
  }
}

const byId = new Map(items.map((item) => [item.id, item]));
const heuristicOf = new Map(
  items.map((item) => [item.id, heuristicFinished({ fragments: item.fragments })]),
);
const answered = (pass: number) =>
  calls.filter((call) => call.pass === pass && call.finished !== null);
const scored = (pass: number): Scored[] =>
  answered(pass).map((call) => ({
    label: byId.get(call.id)?.finished ?? false,
    finished: call.finished as number,
  }));
const heuristic: Scored[] = items.map((item) => ({
  label: item.finished,
  finished: heuristicOf.get(item.id) ?? 0.5,
}));
const quality = (set: Scored[]) => ({
  n: set.length,
  ...classification(set),
  bands: bands(set),
  brier: brier(set),
  ece: ece(set),
});
const allPasses = Array.from({ length: passes }, (_, index) => scored(index + 1));
const ownBands = zeroErrorBands(allPasses);
const hybridItems = (pass: number) =>
  answered(pass).map((call) => ({
    label: byId.get(call.id)?.finished ?? false,
    heuristic: heuristicOf.get(call.id) ?? 0.5,
    qualifier: call.finished as number,
  }));

/** Confident decisions per kind and label in pass 1, with the wrong ones, for the result doc. */
interface Cell {
  n: number;
  decided: number;
  wrong: number;
}
const cell = (): Cell => ({ n: 0, decided: 0, wrong: 0 });
const tally = (target: Cell, label: boolean, value: number, b: Bands) => {
  target.n += 1;
  if (value >= b.high || value <= b.low) {
    target.decided += 1;
    if (value >= b.high !== label) target.wrong += 1;
  }
};
const byKind: Record<string, { heuristic: Cell; clef: Cell; hybrid: Cell }> = {};
for (const call of answered(1)) {
  const item = byId.get(call.id);
  if (!item || call.finished === null) continue;
  const key = `${item.kind} (${item.finished ? "finished" : "unfinished"})`;
  const row = byKind[key] ?? { heuristic: cell(), clef: cell(), hybrid: cell() };
  byKind[key] = row;
  const h = heuristicOf.get(item.id) ?? 0.5;
  tally(row.heuristic, item.finished, h, HEURISTIC_BANDS);
  tally(row.clef, item.finished, call.finished, ownBands);
  const one = hybrid([{ label: item.finished, heuristic: h, qualifier: call.finished }], ownBands);
  row.hybrid.n += 1;
  row.hybrid.decided += one.decided;
  row.hybrid.wrong += one.wrong;
}

const warm = calls.filter((call) => call.ok).map((call) => call.ms);
const inputTokens = calls.map((call) => call.raw?.usage?.input_tokens ?? 0);
const outputTokens = calls.map((call) => call.raw?.usage?.output_tokens ?? 0);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const colos: Record<string, number> = {};
for (const call of calls) colos[call.colo ?? "?"] = (colos[call.colo ?? "?"] ?? 0) + 1;
const stability =
  passes > 1
    ? Math.max(
        ...items.map((item) => {
          const values = calls
            .filter((call) => call.id === item.id && call.finished !== null)
            .map((call) => call.finished as number);
          return values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
        }),
      )
    : null;

const summary = {
  model,
  decision: { id: endOfTurn.id, version: endOfTurn.version, timeoutMs: endOfTurn.timeoutMs },
  calls: calls.length,
  failed: calls.filter((call) => !call.ok).length,
  policyDeclined: calls.filter((call) => call.ok && call.policy === null).length,
  coldMs: cold.ms,
  warm: latency(warm, endOfTurn.timeoutMs),
  colos,
  inputTokensPerCall: inputTokens.length ? sum(inputTokens) / inputTokens.length : 0,
  outputTokensPerCall: outputTokens.length ? sum(outputTokens) / outputTokens.length : 0,
  costUsd: sum(inputTokens) * USD_PER_INPUT_TOKEN[model],
  clef: {
    ...quality(scored(1)),
    distribution: distribution(scored(1)),
    zeroErrorBands: ownBands,
    atOwnBands: allPasses.map((set) => bands(set, ownBands.high, ownBands.low)),
    atJevBands: allPasses.map((set) => bands(set, JEV_BANDS.high, JEV_BANDS.low)),
  },
  hybrid: {
    atOwnBands: allPasses.map((_, index) => hybrid(hybridItems(index + 1), ownBands)),
    atJevBands: allPasses.map((_, index) => hybrid(hybridItems(index + 1), JEV_BANDS)),
  },
  heuristic: quality(heuristic),
  maxSpreadAcrossPasses: stability,
  byKind,
};
console.log(JSON.stringify(summary, null, 2));
await writeFile(
  `${here}results/run-${model}-${stamp}.json`,
  `${JSON.stringify({ summary, cold, calls }, null, 2)}\n`,
);
