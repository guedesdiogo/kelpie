// Runs the labeled set through the deployed spike Worker and through the heuristic (issue #27).
//
//   export SPIKE_URL=https://kelpie-spike-jev.<subdomain>.workers.dev
//   read -s "SPIKE_TOKEN?Spike token: " && export SPIKE_TOKEN
//   bun spikes/jev-end-of-turn/scripts/run.ts --probe          # one item, every request variant, raw
//   bun spikes/jev-end-of-turn/scripts/run.ts [--criteria] [--no-prefix] [--passes 2]
//
// Calls go one at a time, so latency isn't measured under concurrency. The first call is kept
// apart as the cold one. Results go to spikes/jev-end-of-turn/results/.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { endOfTurn, heuristicFinished } from "@kelpie/qualifier";
import { bands, brier, classification, ece, latency, type Scored } from "../src/metrics.ts";

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
  raw?: { answers?: Record<string, Record<string, unknown>>; usage?: { input_tokens?: number } };
  policy?: { finished: number } | null;
  error?: string;
}

const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
const here = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const passes = Number(args[args.indexOf("--passes") + 1] ?? 1) || 1;

const url = process.env.SPIKE_URL ?? fail("set SPIKE_URL");
const token = process.env.SPIKE_TOKEN ?? fail("set SPIKE_TOKEN");
const { items } = JSON.parse(await readFile(`${here}data/sequences.json`, "utf8")) as {
  items: Item[];
};

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function qualify(fragments: string[], variant: { prefix: boolean; criteria: boolean }) {
  const response = await fetch(`${url}/qualify`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-spike-token": token },
    body: JSON.stringify({ fragments, ...variant }),
  });
  if (!response.ok) fail(`the Worker answered ${response.status}`);
  return (await response.json()) as Reply;
}

/** The probability Jev gave, read from whichever field the answer carries. */
function jevFinished(reply: Reply): number | null {
  if (reply.policy) return reply.policy.finished;
  const answer = Object.values(reply.raw?.answers ?? {})[0];
  if (!answer) return null;
  for (const value of [
    answer.noul,
    answer.probability,
    (answer.probabilities as Record<string, unknown> | undefined)?.true,
  ]) {
    if (typeof value === "number") return value;
  }
  return null;
}

const stamp = new Date().toISOString().replaceAll(":", "-");
await mkdir(`${here}results`, { recursive: true });

if (flag("--probe")) {
  const fragments = items[0]?.fragments ?? fail("empty set");
  const probes = [];
  for (const prefix of [true, false]) {
    for (const criteria of [false, true]) {
      const reply = await qualify(fragments, { prefix, criteria });
      probes.push({ prefix, criteria, reply });
      console.log(JSON.stringify({ prefix, criteria, reply }, null, 2));
    }
  }
  await writeFile(`${here}results/probe-${stamp}.json`, `${JSON.stringify(probes, null, 2)}\n`);
  process.exit(0);
}

const variant = { prefix: !flag("--no-prefix"), criteria: flag("--criteria") };
const cold = await qualify(items[0]?.fragments ?? fail("empty set"), variant);
const calls: Array<{ id: string; pass: number } & Reply & { finished: number | null }> = [];
for (let pass = 1; pass <= passes; pass++) {
  for (const item of items) {
    const reply = await qualify(item.fragments, variant);
    calls.push({ id: item.id, pass, ...reply, finished: jevFinished(reply) });
  }
}

const byId = new Map(items.map((item) => [item.id, item]));
const scored = (pass: number): Scored[] =>
  calls
    .filter((call) => call.pass === pass && call.finished !== null)
    .map((call) => ({
      label: byId.get(call.id)?.finished ?? false,
      finished: call.finished as number,
    }));
const heuristic: Scored[] = items.map((item) => ({
  label: item.finished,
  finished: heuristicFinished({ fragments: item.fragments }),
}));
const quality = (set: Scored[]) => ({
  n: set.length,
  ...classification(set),
  bands: bands(set),
  brier: brier(set),
  ece: ece(set),
});

const warm = calls.filter((call) => call.ok).map((call) => call.ms);
const tokens = calls.map((call) => call.raw?.usage?.input_tokens ?? 0);
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
  variant,
  decision: { id: endOfTurn.id, version: endOfTurn.version, timeoutMs: endOfTurn.timeoutMs },
  calls: calls.length,
  failed: calls.filter((call) => !call.ok).length,
  policyDeclined: calls.filter((call) => call.ok && call.policy === null).length,
  coldMs: cold.ms,
  warm: latency(warm, endOfTurn.timeoutMs),
  colos,
  inputTokensPerCall: tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0,
  costUsd: tokens.reduce((a, b) => a + b, 0) * JEV_USD_PER_INPUT_TOKEN,
  jev: quality(scored(1)),
  heuristic: quality(heuristic),
  maxSpreadAcrossPasses: stability,
};
console.log(JSON.stringify(summary, null, 2));
await writeFile(
  `${here}results/run-${stamp}.json`,
  `${JSON.stringify({ summary, cold, calls }, null, 2)}\n`,
);
