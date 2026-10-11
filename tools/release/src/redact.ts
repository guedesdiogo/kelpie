/**
 * Keeps the account id and the instance's vars, with the hosts in them, out of what this tool
 * writes. CI logs, step summaries and issues are public, and the runner masks registered values
 * in its logs only.
 */
export function redactor(mask: (value: string) => void) {
  const hidden = new Set<string>();
  return {
    hide(value: string): void {
      let host = "";
      try {
        host = new URL(value).host;
      } catch {
        // Not a URL.
      }
      for (const part of [value, host]) {
        // A shorter value would hide pieces of unrelated text.
        if (part.length < 4 || hidden.has(part)) continue;
        hidden.add(part);
        mask(part);
      }
    },
    redact(text: string): string {
      return [...hidden]
        .sort((a, b) => b.length - a.length)
        .reduce((out, value) => out.replaceAll(value, "***"), text);
    },
  };
}

/** The workflow commands that mask a value in the runner's logs: one per line, `%` escaped. */
export function maskCommands(value: string): string[] {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => `::add-mask::${line.replaceAll("%", "%25")}`);
}
