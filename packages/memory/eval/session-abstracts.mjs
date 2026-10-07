// Writes eval/session-abstracts.json (cache: by path, the blob asked about and its abstract, or null
// when the answer wasn't one): the abstracts Dream's cheap tier gives the session pages of
// the 1,000-memory evaluation vault (#112), with the prompt Dream runs. `eval` then measures them
// against the vault as it is, without calling a model. It calls OpenAI's gpt-6-luna, llm-gateway's
// cheap fallback, once for each page not cached for its current content:
// `OPENAI_API_KEY="$(node eval/openai-key.mjs)" bun eval/session-abstracts.mjs`.
import { readFileSync, writeFileSync } from "node:fs";
import { ABSTRACT_PROMPT, abstractInput, abstractOf, gitBlobSha, readNote } from "../src/index.ts";
import { buildVault, SEED } from "./generate.ts";

const MODEL = "gpt-6-luna";
const SIZE = 1_000;
const OUTPUT_TOKENS = 2_000;
const CONCURRENCY = 8;
const FILE = new URL("./session-abstracts.json", import.meta.url);

const key = process.env.OPENAI_API_KEY ?? "";
if (key === "") throw new Error("OPENAI_API_KEY is empty: see the command at the top of this file");

let cache = { model: MODEL, seed: SEED, size: SIZE, abstracts: {} };
try {
  cache = JSON.parse(readFileSync(FILE, "utf8"));
} catch {
  // No cache yet.
}

const vault = await buildVault(SIZE);
const latest = new Map();
for (const commit of vault.commits) {
  for (const change of commit.changes) {
    if (change.content === null) latest.delete(change.path);
    else latest.set(change.path, change.content);
  }
}
/** The session pages to ask about: their path, current blob, title and body. */
const pages = [];
for (const [path, text] of latest) {
  const note = readNote(path, text);
  if (note?.kind !== "session") continue;
  const blob = await gitBlobSha(text);
  if (cache.abstracts[path]?.blob === blob) continue;
  pages.push({ path, blob, title: note.title, body: note.body });
}
console.log(`${pages.length} session pages to ask, of ${latest.size} memories`);

let failed = 0;
let input = 0;
let output = 0;
async function ask(page) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      instructions: ABSTRACT_PROMPT,
      input: [{ role: "user", content: [{ type: "input_text", text: abstractInput(page) }] }],
      max_output_tokens: OUTPUT_TOKENS,
      store: false,
    }),
  });
  if (!response.ok) {
    failed += 1;
    console.error(`${page.path}: HTTP ${response.status}`);
    return;
  }
  const body = await response.json();
  input += body.usage?.input_tokens ?? 0;
  output += body.usage?.output_tokens ?? 0;
  const text = (body.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
  cache.abstracts[page.path] = { blob: page.blob, abstract: abstractOf(text) };
}

for (let i = 0; i < pages.length; i += CONCURRENCY) {
  await Promise.all(pages.slice(i, i + CONCURRENCY).map(ask));
}
cache.abstracts = Object.fromEntries(
  Object.entries(cache.abstracts).sort(([a], [b]) => (a < b ? -1 : 1)),
);
writeFileSync(FILE, `${JSON.stringify(cache, null, 2)}\n`);
const kept = Object.values(cache.abstracts).filter((entry) => entry.abstract !== null).length;
console.log(
  `asked ${pages.length}, failed ${failed}; ${kept} abstracts kept; tokens in ${input}, out ${output}`,
);
