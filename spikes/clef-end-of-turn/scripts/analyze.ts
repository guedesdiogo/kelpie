// Reads a run file and derives what production's hybrid sees (issue #117): the heuristic decides
// confident cases first, so the qualifier's bands are measured only on the items it leaves over.
//
//   bun spikes/clef-end-of-turn/scripts/analyze.ts spikes/clef-end-of-turn/results/run-<model>-<stamp>.json

import { readFile } from "node:fs/promises";
import { HEURISTIC_BANDS, heuristicFinished } from "@kelpie/qualifier";
import { hybrid, type Scored, zeroErrorBands } from "../src/metrics.ts";

declare const process: { argv: string[] };

interface Item {
  id: string;
  kind: string;
  fragments: string[];
  finished: boolean;
}
interface Call {
  id: string;
  pass: number;
  finished: number | null;
}

const here = new URL("..", import.meta.url).pathname;
const file = process.argv[2] ?? "";
const { items } = JSON.parse(await readFile(`${here}data/sequences.json`, "utf8")) as {
  items: Item[];
};
const run = JSON.parse(await readFile(file, "utf8")) as {
  summary: { model: string };
  calls: Call[];
};
const byId = new Map(items.map((item) => [item.id, item]));
const heuristic = (item: Item) => heuristicFinished({ fragments: item.fragments });
const unsure = (item: Item) => {
  const value = heuristic(item);
  return value < HEURISTIC_BANDS.high && value > HEURISTIC_BANDS.low;
};

const passes = [...new Set(run.calls.map((call) => call.pass))];
const answered = run.calls.filter((call) => call.finished !== null);
const left: Scored[][] = passes.map((pass) =>
  answered
    .filter((call) => call.pass === pass && unsure(byId.get(call.id) as Item))
    .map((call) => ({
      label: (byId.get(call.id) as Item).finished,
      finished: call.finished as number,
    })),
);
const bands = zeroErrorBands(left);
const hybridAt = (pass: number) =>
  hybrid(
    answered
      .filter((call) => call.pass === pass)
      .map((call) => {
        const item = byId.get(call.id) as Item;
        return {
          label: item.finished,
          heuristic: heuristic(item),
          qualifier: call.finished as number,
        };
      }),
    bands,
  );

/** Confident decisions per kind in pass 1, with the wrong ones in brackets. */
const table: Record<string, { n: number; heuristic: string; qualifier: string; hybrid: string }> =
  {};
const tally = (cells: [number, number]) => (cells[0] === 0 ? "0" : `${cells[0]} (${cells[1]})`);
for (const item of items) {
  const call = answered.find((c) => c.pass === 1 && c.id === item.id);
  if (!call) continue;
  const key = `${item.kind} | ${item.finished ? "finished" : "unfinished"}`;
  const row = table[key] ?? { n: 0, heuristic: "", qualifier: "", hybrid: "" };
  table[key] = row;
  row.n += 1;
}
for (const key of Object.keys(table)) {
  const group = items.filter(
    (item) => `${item.kind} | ${item.finished ? "finished" : "unfinished"}` === key,
  );
  const decide = (value: number, b: { high: number; low: number }, label: boolean) =>
    value >= b.high ? [1, label ? 0 : 1] : value <= b.low ? [1, label ? 1 : 0] : [0, 0];
  const sum = (pick: (item: Item, value: number) => number[]) =>
    group.reduce(
      (acc, item) => {
        const value = answered.find((c) => c.pass === 1 && c.id === item.id)?.finished ?? 0.5;
        const [d = 0, w = 0] = pick(item, value);
        return [acc[0] + d, acc[1] + w] as [number, number];
      },
      [0, 0] as [number, number],
    );
  const row = table[key] as (typeof table)[string];
  row.heuristic = tally(sum((item) => decide(heuristic(item), HEURISTIC_BANDS, item.finished)));
  row.qualifier = tally(sum((item, value) => decide(value, bands, item.finished)));
  row.hybrid = tally(
    sum((item, value) =>
      unsure(item)
        ? decide(value, bands, item.finished)
        : decide(heuristic(item), HEURISTIC_BANDS, item.finished),
    ),
  );
}

console.log(
  JSON.stringify(
    {
      model: run.summary.model,
      leftToTheQualifier: left[0]?.length,
      bands,
      hybrid: passes.map(hybridAt),
      byKind: table,
    },
    null,
    2,
  ),
);
