// What a reply shows (#188): a small Markdown subset the model writes, read in code and rendered by
// each channel without ever passing the model's text as markup. Raw HTML stays text. A link is a
// link only when its URL is one the caller allows; any other shows its address as code, so a
// channel that links bare URLs on its own (Telegram does) can't make it clickable either.

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "italic"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { type: "code"; text: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^ {0,3}[-*+][ \t]+(.*)$/;
const NUMBERED = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const URL_START = /^https?:\/\//i;
/** A web URL starting at `lastIndex`. */
const WEB_URL_AT = /https?:\/\/[^\s<>"]+/iy;
/** The longest link address read; anything longer stays text. */
const MAX_HREF_CHARS = 2_048;
/** Emphasis nested deeper than this stays text: no reply needs it, and it bounds the work. */
const MAX_DEPTH = 8;
const EMPHASIS = ["**", "__", "*", "_"] as const;
/** Punctuation after a URL belongs to the sentence. */
const AFTER_URL = /[.,:;!?'"]+$/;
/** What a backslash may escape, as CommonMark has it. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/**
 * Reads a reply into blocks. `allowed` holds the URLs that may be links, written as the reply
 * writes them; only http and https URLs among them become links.
 */
export function formatReply(text: string, allowed: ReadonlySet<string>): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  const inline = (source: string) => readInline(source, allowed);
  const flush = () => {
    if (paragraph.length > 0)
      blocks.push({ type: "paragraph", children: inline(paragraph.join("\n")) });
    paragraph = [];
    if (list) {
      blocks.push({
        type: "list",
        ordered: list.ordered,
        start: list.start,
        items: list.items.map(inline),
      });
    }
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marks = fence[1] ?? "```";
      const closing = new RegExp(
        `^ {0,3}${marks[0] === "`" ? "`" : "~"}{${marks.length},}[ \\t]*$`,
      );
      const body: string[] = [];
      for (i += 1; i < lines.length && !closing.test(lines[i] ?? ""); i += 1)
        body.push(lines[i] ?? "");
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        type: "paragraph",
        children: [{ type: "bold", children: inline(heading[1] ?? "") }],
      });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, start: ordered ? Number(numbered?.[1]) : 1, items: [] };
      list.items.push((bullet ? bullet[1] : numbered?.[2]) ?? "");
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Reads one block's inline text. Unbalanced markers stay as they are. */
function readInline(source: string, allowed: ReadonlySet<string>, depth = 0): Inline[] {
  if (depth > MAX_DEPTH) return source === "" ? [] : [{ type: "text", text: source }];
  const closers = closerPositions(source);
  const nodes: Inline[] = [];
  let buffer = "";
  const flushText = () => {
    if (buffer !== "") nodes.push({ type: "text", text: buffer });
    buffer = "";
  };
  const push = (...items: Inline[]) => {
    flushText();
    nodes.push(...items);
  };

  for (let i = 0; i < source.length; ) {
    const char = source[i] ?? "";
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
        const label = readInline(link.label, new Set(), depth + 1);
        push(...linkOrAddress(link.href, label, allowed));
        i = link.end;
        continue;
      }
    }
    if ((char === "h" || char === "H") && !isWordChar(source[i - 1])) {
      const url = bareUrl(source, i);
      if (url) {
        push(...linkOrAddress(url, [{ type: "text", text: url }], allowed, true));
        i += url.length;
        continue;
      }
    }
    if ((char === "*" || char === "_") && next === char) {
      const end = closingOf(source, i, char + char, closers);
      if (end !== -1) {
        push({ type: "bold", children: readInline(source.slice(i + 2, end), allowed, depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (char === "*" || char === "_") {
      const end = closingOf(source, i, char, closers);
      if (end !== -1) {
        push({
          type: "italic",
          children: readInline(source.slice(i + 1, end), allowed, depth + 1),
        });
        i = end + 1;
        continue;
      }
    }
    buffer += char;
    i += 1;
  }
  flushText();
  return nodes;
}

/**
 * Where each emphasis marker could close, in order: after a non-space and before a non-word
 * character, and not as part of a longer run of the same marker. One pass, so finding a closer
 * costs a search, not a scan.
 */
function closerPositions(source: string): Map<string, number[]> {
  const positions = new Map<string, number[]>(EMPHASIS.map((marker) => [marker, []]));
  for (let at = 1; at < source.length; at += 1) {
    const char = source[at];
    if (char !== "*" && char !== "_") continue;
    const before = source[at - 1] ?? "";
    if (/\s/.test(before)) continue;
    for (const marker of EMPHASIS) {
      if (!source.startsWith(marker, at)) continue;
      const after = source[at + marker.length];
      if (!isWordChar(after) && after !== marker[0]) positions.get(marker)?.push(at);
    }
  }
  return positions;
}

/**
 * Where an emphasis marker at `start` closes, or -1. It opens only before a non-space and after a
 * non-word character, so `snake_case` and `2*3` stay text, and holds at least one character.
 */
function closingOf(
  source: string,
  start: number,
  marker: string,
  closers: ReadonlyMap<string, number[]>,
): number {
  const after = source[start + marker.length];
  if (after === undefined || /\s/.test(after) || isWordChar(source[start - 1])) return -1;
  const positions = closers.get(marker) ?? [];
  const from = start + marker.length + 1;
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((positions[middle] ?? 0) < from) low = middle + 1;
    else high = middle;
  }
  return positions[low] ?? -1;
}

/**
 * A `[label](href)` at `start`: neither holds a bracket or white space (the label may hold spaces),
 * and neither is read past its own end, so a reply of unclosed brackets costs one pass.
 */
function readLink(
  source: string,
  start: number,
): { label: string; href: string; end: number } | null {
  let close = start + 1;
  while (close < source.length && !"[]\n".includes(source[close] ?? "")) close += 1;
  if (source[close] !== "]" || source[close + 1] !== "(" || close === start + 1) return null;
  const label = source.slice(start + 1, close);
  let depth = 0;
  const limit = Math.min(source.length, close + 2 + MAX_HREF_CHARS);
  for (let at = close + 2; at < limit; at += 1) {
    const char = source[at];
    if (char === undefined || /[\s[\]]/.test(char)) return null;
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

/** The web URL at `start`, without the punctuation of the sentence after it. */
function bareUrl(source: string, start: number): string | null {
  WEB_URL_AT.lastIndex = start;
  const found = WEB_URL_AT.exec(source)?.[0];
  if (!found) return null;
  let url: string = found;
  for (;;) {
    const trimmed: string = url.replace(AFTER_URL, "");
    const opens = (trimmed.match(/\(/g) ?? []).length;
    const closes = (trimmed.match(/\)/g) ?? []).length;
    const cut = trimmed.endsWith(")") && closes > opens ? trimmed.slice(0, -1) : trimmed;
    if (cut === url) break;
    url = cut;
  }
  return /^https?:\/\/[^/?#]/i.test(url) ? url : null;
}

/**
 * A link when `href` is an allowed http(s) URL; otherwise its label and its address, as code,
 * which no channel links. A bare URL's label is the address itself, so it shows once.
 */
function linkOrAddress(
  href: string,
  label: Inline[],
  allowed: ReadonlySet<string>,
  bare = false,
): Inline[] {
  if (URL_START.test(href) && allowed.has(href)) return [{ type: "link", href, children: label }];
  if (bare) return [{ type: "code", text: href }];
  return [
    ...label,
    { type: "text", text: " (" },
    { type: "code", text: href },
    { type: "text", text: ")" },
  ];
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/** What the blocks show, as text: what a channel counts against its length limit. */
export function visibleText(blocks: readonly Block[]): string {
  return blocks.map((block) => renderBlock(block, plainInline)).join("\n\n");
}

/** Telegram's HTML (`parse_mode: "HTML"`): only its own tags, every text and address escaped. */
export function toTelegramHtml(blocks: readonly Block[]): string {
  return blocks.map((block) => renderBlock(block, htmlInline, true)).join("\n\n");
}

function renderBlock(
  block: Block,
  inline: (nodes: readonly Inline[]) => string,
  html = false,
): string {
  switch (block.type) {
    case "paragraph":
      return inline(block.children);
    case "list":
      return block.items
        .map((item, index) => `${block.ordered ? `${block.start + index}.` : "•"} ${inline(item)}`)
        .join("\n");
    case "code":
      return html ? `<pre>${escapeHtml(block.text)}</pre>` : block.text;
  }
}

function plainInline(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.text;
        default:
          return plainInline(node.children);
      }
    })
    .join("");
}

function htmlInline(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return escapeHtml(node.text);
        case "code":
          return `<code>${escapeHtml(node.text)}</code>`;
        case "bold":
          return `<b>${htmlInline(node.children)}</b>`;
        case "italic":
          return `<i>${htmlInline(node.children)}</i>`;
      }
      return `<a href="${escapeHtml(node.href)}">${htmlInline(node.children)}</a>`;
    })
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
