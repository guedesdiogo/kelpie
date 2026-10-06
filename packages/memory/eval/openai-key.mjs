// Prints the OpenAI key from ~/.kelpie/.env for `eval:models`, whose command substitution keeps it
// out of the terminal. The last OPENAI_API_KEY line wins; `export`, quotes and a trailing comment
// are tolerated. It prints nothing when there is no such file or line.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

let text = "";
try {
  text = readFileSync(`${homedir()}/.kelpie/.env`, "utf8");
} catch {
  process.exit(0);
}
const values = text
  .split(/\r?\n/)
  .map((line) => /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*)$/.exec(line)?.[1])
  .filter((value) => value !== undefined)
  .map((value) => {
    const quoted = /^(["'])(.*)\1/.exec(value.trim());
    return quoted ? quoted[2] : value.replace(/\s+#.*$/, "").trim();
  });
process.stdout.write(values.at(-1) ?? "");
