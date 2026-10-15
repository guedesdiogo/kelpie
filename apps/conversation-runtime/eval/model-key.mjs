// Prints one model provider's key from ~/.kelpie/.env for `eval:handoff`, whose command
// substitution keeps it out of the terminal: `node eval/model-key.mjs ANTHROPIC_API_KEY`. Only the
// two providers' keys are read. The last line for the key wins; `export`, quotes and a trailing
// comment are tolerated. It prints nothing when there is no such file or line.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

/** Each key this script reads, with the line that holds it. */
const KEYS = new Map([
  ["ANTHROPIC_API_KEY", /^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.*)$/],
  ["OPENAI_API_KEY", /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*)$/],
]);
const pattern = KEYS.get(process.argv[2] ?? "");
if (!pattern) process.exit(1);
let text = "";
try {
  text = readFileSync(`${homedir()}/.kelpie/.env`, "utf8");
} catch {
  process.exit(0);
}
const values = text
  .split(/\r?\n/)
  .map((line) => pattern.exec(line)?.[1])
  .filter((value) => value !== undefined)
  .map((value) => {
    const quoted = /^(["'])(.*)\1/.exec(value.trim());
    return quoted ? quoted[2] : value.replace(/\s+#.*$/, "").trim();
  });
process.stdout.write(values.at(-1) ?? "");
