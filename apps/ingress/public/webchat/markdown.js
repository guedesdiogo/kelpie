// An agent's own Markdown files as blocks (#381): its soul, its rules and its skills, read in the
// page so the formatted view follows the draft as it is typed. The blocks are blocks.js's, a reply's
// subset (#188) plus headings, quotes, rules and a skill's frontmatter, and each carries the source
// lines it came from, so switching views keeps the place. Nothing is ever parsed as HTML: raw HTML
// stays text. Only http and https links become links. Every step is linear in the file's length.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+/;
const BULLET = /^ {0,3}[-*+][ \t]+/;
const NUMBERED = /^ {0,3}(\d{1,9})[.)][ \t]+/;
const QUOTE = /^ {0,3}>[ \t]?/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FRONTMATTER_END = /^---[ \t]*$/;
/** Emphasis nested deeper than this stays text. */
const MAX_DEPTH = 8;
const MAX_HREF_CHARS = 2_048;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const WEB_URL_AT = /https?:\/\/[^\s<>"]+/iy;
const AFTER_URL = ".,:;!?'\"";

/**
 * The marks that open a line, as the plain text shows them in `--muted`: a heading's `#`, a list's
 * bullet or number, a quote's `>` and a fence's backticks.
 */
export function lineMark(line) {
  const match =
    HEADING.exec(line) ?? BULLET.exec(line) ?? NUMBERED.exec(line) ?? QUOTE.exec(line) ?? FENCE.exec(line);
  return match ? match[0] : "";
}

/**
 * Reads a file into blocks, each with `line` and `end`, its first and last source lines from 0. A
 * list's items carry their own `line`. A `SKILL.md`'s frontmatter is a block of its own.
 */
export function readMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = null;
  let list = null;
  let quote = null;
  const flush = (end) => {
    if (paragraph) blocks.push({ type: "paragraph", children: readInline(paragraph.text.join("\n")), line: paragraph.line, end });
    if (list) {
      blocks.push({
        type: "list",
        ordered: list.ordered,
        start: list.start,
        items: list.items.map((item) => ({ children: readInline(item.text), line: item.line })),
        line: list.line,
        end,
      });
    }
    if (quote) blocks.push({ type: "quote", children: readInline(quote.text.join("\n")), line: quote.line, end });
    paragraph = null;
    list = null;
    quote = null;
  };
  let i = 0;
  if (lines[0] === "---") {
    const close = lines.findIndex((line, index) => index > 0 && FRONTMATTER_END.test(line));
    if (close > 0) {
      blocks.push({ type: "frontmatter", text: lines.slice(1, close).join("\n"), line: 0, end: close });
      i = close + 1;
    }
  }
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = openingFence(line);
    if (fence) {
      flush(i - 1);
      const start = i;
      const closing = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
      const body = [];
      for (i += 1; i < lines.length && !closing.test(lines[i]); i += 1) body.push(lines[i]);
      blocks.push({ type: "code", text: body.join("\n"), line: start, end: Math.min(i, lines.length - 1) });
      continue;
    }
    if (line.trim() === "") {
      flush(i - 1);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush(i - 1);
      blocks.push({
        type: "heading",
        level: heading[1].length,
        children: readInline(headingText(line.slice(heading[0].length))),
        line: i,
        end: i,
      });
      continue;
    }
    if (RULE.test(line)) {
      flush(i - 1);
      blocks.push({ type: "rule", line: i, end: i });
      continue;
    }
    const quoted = QUOTE.exec(line);
    if (quoted) {
      if (paragraph || list) flush(i - 1);
      quote ??= { line: i, text: [] };
      quote.text.push(line.slice(quoted[0].length));
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const marker = bullet ?? numbered;
    if (marker) {
      const ordered = numbered !== null;
      if (paragraph || quote || (list && list.ordered !== ordered)) flush(i - 1);
      list ??= { ordered, start: numbered ? Number(numbered[1]) : 1, items: [], line: i };
      list.items.push({ text: line.slice(marker[0].length), line: i });
      continue;
    }
    // A line that continues a list item, indented under it.
    if (list && /^[ \t]{2,}\S/.test(line)) {
      const item = list.items.at(-1);
      item.text += `\n${line.trim()}`;
      continue;
    }
    if (list || quote) flush(i - 1);
    paragraph ??= { line: i, text: [] };
    paragraph.text.push(line);
  }
  flush(lines.length - 1);
  return blocks;
}

function openingFence(line) {
  const match = FENCE.exec(line);
  const marks = match?.[1];
  if (!marks) return null;
  if (marks[0] === "`" && line.slice(match[0].length).includes("`")) return null;
  return marks;
}

function headingText(rest) {
  return rest.replace(/[ \t]+#+[ \t]*$/, "").replace(/^#+[ \t]*$/, "").trim();
}

/**
 * A block's inline text, as the runtime reads a reply's (packages/channels): code, links, bold and
 * italics. Unbalanced markers stay as they are.
 */
export function readInline(source, depth = 0) {
  const emphasis = depth < MAX_DEPTH;
  const closers = emphasis ? closerPositions(source) : new Map();
  const nodes = [];
  let buffer = "";
  const push = (...items) => {
    if (buffer !== "") nodes.push({ type: "text", text: buffer });
    buffer = "";
    nodes.push(...items);
  };
  for (let i = 0; i < source.length; ) {
    const char = source[i];
    const next = source[i + 1] ?? "";
    if (char === "\\" && ESCAPABLE.test(next)) {
      buffer += next;
      i += 2;
      continue;
    }
    if (char === "`") {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) {
        push({ type: "code", text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (char === "[") {
      const link = readLink(source, i);
      if (link) {
        push({ type: "link", href: link.href, children: readInline(link.label, depth + 1) });
        i = link.end;
        continue;
      }
    }
    if (char === "h" || char === "H") {
      const url = bareUrl(source, i);
      if (url) {
        push({ type: "link", href: url, children: [{ type: "text", text: url }] });
        i += url.length;
        continue;
      }
    }
    if (emphasis && (char === "*" || char === "_") && next === char) {
      const end = closingOf(source, i, char + char, closers);
      if (end === -1) {
        buffer += char + char;
        i += 2;
        continue;
      }
      push({ type: "bold", children: readInline(source.slice(i + 2, end), depth + 1) });
      i = end + 2;
      continue;
    }
    if (emphasis && (char === "*" || char === "_")) {
      const end = closingOf(source, i, char, closers);
      if (end !== -1) {
        push({ type: "italic", children: readInline(source.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }
    buffer += char;
    i += 1;
  }
  if (buffer !== "") nodes.push({ type: "text", text: buffer });
  return nodes;
}

const isWordChar = (char) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

function closerPositions(source) {
  const positions = new Map([["**", []], ["__", []], ["*", []], ["_", []]]);
  for (let at = 0; at < source.length; ) {
    const char = source[at];
    if (char !== "*" && char !== "_") {
      at += 1;
      continue;
    }
    let end = at + 1;
    while (source[end] === char) end += 1;
    if (at > 0 && !/\s/.test(source[at - 1]) && !isWordChar(source[end])) {
      const length = end - at;
      if (length !== 1) positions.get(char + char).push(end - 2);
      if (length !== 2) positions.get(char).push(end - 1);
    }
    at = end;
  }
  return positions;
}

function closingOf(source, start, marker, closers) {
  const after = source[start + marker.length];
  if (after === undefined || /\s/.test(after) || isWordChar(source[start - 1])) return -1;
  const positions = closers.get(marker) ?? [];
  const from = start + marker.length + 1;
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions[middle] < from) low = middle + 1;
    else high = middle;
  }
  return positions[low] ?? -1;
}

function readLink(source, start) {
  let close = start + 1;
  while (close < source.length && !"[]\n".includes(source[close])) close += 1;
  if (source[close] !== "]" || source[close + 1] !== "(" || close === start + 1) return null;
  const label = source.slice(start + 1, close);
  let depth = 0;
  const limit = Math.min(source.length, close + 3 + MAX_HREF_CHARS);
  for (let at = close + 2; at < limit; at += 1) {
    const char = source[at];
    if (/[\s[\]]/.test(char)) return null;
    if (char === "(") depth += 1;
    if (char === ")") {
      if (depth === 0) {
        const href = source.slice(close + 2, at);
        return href === "" ? null : { label, href, end: at + 1 };
      }
      depth -= 1;
    }
  }
  return null;
}

function bareUrl(source, start) {
  WEB_URL_AT.lastIndex = start;
  const found = WEB_URL_AT.exec(source)?.[0];
  if (!found) return null;
  let opens = 0;
  let closes = 0;
  for (const char of found) {
    if (char === "(") opens += 1;
    else if (char === ")") closes += 1;
  }
  let end = found.length;
  while (end > 0) {
    const char = found.charAt(end - 1);
    if (AFTER_URL.includes(char)) end -= 1;
    else if (char === ")" && closes > opens) {
      closes -= 1;
      end -= 1;
    } else break;
  }
  const url = found.slice(0, end);
  return /^https?:\/\/./i.test(url) ? url : null;
}
