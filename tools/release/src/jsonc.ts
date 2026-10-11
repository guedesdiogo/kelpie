/** Parses JSON with comments and trailing commas, as `wrangler.jsonc` allows. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  const skipComment = (at: number): number => {
    if (text.startsWith("//", at)) {
      const end = text.indexOf("\n", at);
      return end === -1 ? text.length : end;
    }
    if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      return end === -1 ? text.length : end + 2;
    }
    return at;
  };
  const nextSignificant = (from: number): string | undefined => {
    let at = from;
    for (;;) {
      while (at < text.length && /\s/.test(text[at] as string)) at++;
      const after = skipComment(at);
      if (after === at) return text[at];
      at = after;
    }
  };
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
      continue;
    }
    const after = skipComment(i);
    if (after !== i) {
      i = after;
      continue;
    }
    if (char === ",") {
      const next = nextSignificant(i + 1);
      if (next === "}" || next === "]") {
        i++;
        continue;
      }
    }
    out += char;
    i++;
  }
  return JSON.parse(out);
}
