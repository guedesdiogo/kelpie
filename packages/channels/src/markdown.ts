// What a reply shows (#188): a small Markdown subset the model writes, read in code and rendered by
// each channel without ever passing the model's text as markup. Raw HTML stays text. A web address
// is a link only when the caller allows it; any other shows as code. Telegram links addresses in
// plain text on its own, with or without a scheme, so its renderer puts every address it doesn't
// link in code too. Every step is linear in the reply's length: a reply is the model's to write.

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "italic"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export type Block = (
  | { type: "paragraph"; children: Inline[] }
  | {
      type: "list";
      ordered: boolean;
      start: number;
      items: Inline[][];
      /** An ordered list's numbers as written, which Telegram shows; the webchat counts from `start`. */
      numbers?: number[];
    }
  | { type: "code"; text: string }
) & {
  /** Written on the line right after the previous block, with no blank line between. */
  tight?: true;
};

/** The addresses a reply may link. A `Set` of them will do. */
export type AllowedLinks = { has(href: string): boolean };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}[ \t]+/;
const BULLET = /^ {0,3}[-*+][ \t]+/;
const NUMBERED = /^ {0,3}(\d{1,9})[.)][ \t]+/;
const URL_START = /^https?:\/\//i;
/** A web URL starting at `lastIndex`. */
const WEB_URL_AT = /https?:\/\/[^\s<>"]+/iy;
/** The longest link address read; anything longer stays text. */
const MAX_HREF_CHARS = 2_048;
/** Emphasis nested deeper than this stays text: no reply needs it, and it bounds the work. */
const MAX_DEPTH = 8;
const EMPHASIS = ["**", "__", "*", "_"] as const;
/** Punctuation after a URL belongs to the sentence. */
const AFTER_URL = ".,:;!?'\"";
/** What a backslash may escape, as CommonMark has it. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const NONE: AllowedLinks = { has: () => false };

/**
 * Reads a reply into blocks. `allowed` holds the URLs that may be links, written as the reply
 * writes them, as `linksOf` finds them; only http and https URLs among them become links.
 */
export function formatReply(text: string, allowed: AllowedLinks): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let blank = false;
  let paragraph: string[] = [];
  let list: { ordered: boolean; numbers: number[]; items: string[] } | null = null;
  const inline = (source: string) => readInline(source, allowed);
  const add = (block: Block) => {
    if (blocks.length > 0 && !blank) block.tight = true;
    blocks.push(block);
    blank = false;
  };
  const flush = () => {
    if (paragraph.length > 0) add({ type: "paragraph", children: inline(paragraph.join("\n")) });
    paragraph = [];
    if (list) {
      add({
        type: "list",
        ordered: list.ordered,
        start: list.numbers[0] ?? 1,
        items: list.items.map(inline),
        ...(list.ordered ? { numbers: list.numbers } : {}),
      });
    }
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fence = openingFence(line);
    if (fence) {
      flush();
      const closing = new RegExp(
        `^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`,
      );
      const body: string[] = [];
      for (i += 1; i < lines.length && !closing.test(lines[i] ?? ""); i += 1)
        body.push(lines[i] ?? "");
      add({ type: "code", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      blank = true;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const title = headingText(line.slice(heading[0].length));
      add({ type: "paragraph", children: [{ type: "bold", children: inline(title) }] });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const marker = bullet ?? numbered;
    if (marker) {
      const ordered = numbered !== null;
      if (paragraph.length > 0 || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, numbers: [], items: [] };
      if (numbered) list.numbers.push(Number(numbered[1]));
      list.items.push(line.slice(marker[0].length));
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/**
 * The http and https addresses a reply holds, as `formatReply` reads them: the ones a caller may
 * allow. Those in code, and in a link's label, never become links, so they aren't listed.
 */
export function linksOf(text: string): string[] {
  const found: string[] = [];
  formatReply(text, {
    has: (href) => {
      found.push(href);
      return false;
    },
  });
  return found;
}

/**
 * A URL found in text, without the punctuation of the sentence after it. A closing parenthesis
 * stays only when it closes one the URL opened (`/wiki/Foo_(bar)`). One pass from the end.
 */
export function trimUrl(found: string): string {
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
  return found.slice(0, end);
}

/** A fence's marks, unless a backtick fence's info string holds a backtick (that's inline code). */
function openingFence(line: string): string | null {
  const match = FENCE.exec(line);
  const marks = match?.[1];
  if (!match || !marks) return null;
  if (marks[0] === "`" && line.slice(match[0].length).includes("`")) return null;
  return marks;
}

/** A heading's text, without the closing run of `#` that follows a space, if any. */
function headingText(rest: string): string {
  let end = rest.length;
  while (end > 0 && " \t".includes(rest.charAt(end - 1))) end -= 1;
  let hashes = end;
  while (hashes > 0 && rest.charAt(hashes - 1) === "#") hashes -= 1;
  if (hashes < end && (hashes === 0 || " \t".includes(rest.charAt(hashes - 1)))) {
    end = hashes;
    while (end > 0 && " \t".includes(rest.charAt(end - 1))) end -= 1;
  }
  return rest.slice(0, end);
}

/**
 * Reads one block's inline text. Unbalanced markers stay as they are. Past `MAX_DEPTH` emphasis
 * stays text, but code, links and addresses are still read, so none goes out unchecked.
 */
function readInline(source: string, allowed: AllowedLinks, depth = 0): Inline[] {
  const emphasis = depth < MAX_DEPTH;
  const closers = emphasis ? closerPositions(source) : new Map<string, number[]>();
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
        const label = readInline(link.label, NONE, depth + 1);
        push(...linkOrAddress(link.href, label, allowed));
        i = link.end;
        continue;
      }
    }
    if (char === "h" || char === "H") {
      const url = bareUrl(source, i);
      if (url) {
        push(...linkOrAddress(url, [{ type: "text", text: url }], allowed, true));
        i += url.length;
        continue;
      }
    }
    if (emphasis && (char === "*" || char === "_") && next === char) {
      // A pair that doesn't open bold stays text whole: half of it isn't an italic's marker.
      const end = closingOf(source, i, char + char, closers);
      if (end === -1) {
        buffer += char + char;
        i += 2;
        continue;
      }
      push({ type: "bold", children: readInline(source.slice(i + 2, end), allowed, depth + 1) });
      i = end + 2;
      continue;
    }
    if (emphasis && (char === "*" || char === "_")) {
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
 * Where each emphasis marker could close, in order: a run of markers after a non-space and before a
 * non-word character. A run of one closes `*`, of two `**`, and a longer one both, with its last
 * two and its last one, so `***x***` is bold italics and `*a **b** c*` italics around bold. One
 * pass, so finding a closer costs a search, not a scan.
 */
function closerPositions(source: string): Map<string, number[]> {
  const positions = new Map<string, number[]>(EMPHASIS.map((marker) => [marker, []]));
  for (let at = 0; at < source.length; ) {
    const char = source.charAt(at);
    if (char !== "*" && char !== "_") {
      at += 1;
      continue;
    }
    let end = at + 1;
    while (source[end] === char) end += 1;
    if (at > 0 && !/\s/.test(source.charAt(at - 1)) && !isWordChar(source[end])) {
      const length = end - at;
      if (length !== 1) positions.get(char + char)?.push(end - 2);
      if (length !== 2) positions.get(char)?.push(end - 1);
    }
    at = end;
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
  const limit = Math.min(source.length, close + 3 + MAX_HREF_CHARS);
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
  const url = trimUrl(found);
  return /^https?:\/\/./i.test(url) ? url : null;
}

/**
 * A link when `href` is an allowed http(s) URL; otherwise its label and its address, as code,
 * which no channel links. A bare URL's label is the address itself, so it shows once.
 */
function linkOrAddress(
  href: string,
  label: Inline[],
  allowed: AllowedLinks,
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

/**
 * Telegram's HTML (`parse_mode: "HTML"`): only its own tags, every text and address escaped. What
 * it shows is never longer than the reply as written, so a bubble split for Telegram's limit fits.
 */
export function toTelegramHtml(blocks: readonly Block[]): string {
  return blocks
    .map((block, index) => {
      const gap = index === 0 ? "" : block.tight ? "\n" : "\n\n";
      return gap + telegramBlock(block);
    })
    .join("");
}

/**
 * A reply as written, for when Telegram can't read its HTML: no formatting and no links, with every
 * address in code all the same.
 */
export function toTelegramPlain(text: string): string {
  const nodes: Inline[] = [];
  let from = 0;
  for (const [found, at = 0] of webUrls(text)) {
    nodes.push({ type: "text", text: text.slice(from, at) }, { type: "code", text: found });
    from = at + found.length;
  }
  nodes.push({ type: "text", text: text.slice(from) });
  const html = telegramInline(nodes);
  return fitsTelegram(html) ? html : `<pre>${escapeHtml(text)}</pre>`;
}

/**
 * Telegram reads about 100 entities in a message and ignores the rest (python-telegram-bot's
 * `MAX_MESSAGE_ENTITIES`), so a code span past them would leave its address to be linked. Some room
 * stays for the entities Telegram adds itself.
 */
const MAX_ENTITIES = 90;

/** Whether Telegram reads every entity in `html`: if not, the reply goes plainer. */
export function fitsTelegram(html: string): boolean {
  return (html.match(/<[a-z]/g) ?? []).length <= MAX_ENTITIES;
}

/**
 * The http and https links in `text`, in order, about as Telegram finds them: punctuation after a
 * link stays out (`trimUrl`). Links without a scheme (`t.me/x`, `example.com`) aren't listed.
 */
export function webLinks(text: string): string[] {
  return [...webUrls(text)].map(([url]) => url);
}

/** Each web URL in `text`, as `bareUrl` reads one, with where it starts. */
function* webUrls(text: string): Generator<[string, number]> {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const url = trimUrl(match[0]);
    if (/^https?:\/\/./i.test(url)) yield [url, match.index];
  }
}

function telegramBlock(block: Block): string {
  switch (block.type) {
    case "paragraph":
      return telegramInline(block.children);
    case "list":
      return block.items
        .map((item, index) => {
          const marker = block.ordered ? `${block.numbers?.[index] ?? block.start + index}.` : "•";
          return `${marker} ${telegramInline(item)}`;
        })
        .join("\n");
    case "code":
      return `<pre>${escapeHtml(block.text)}</pre>`;
  }
}

/** A stretch of inline text and the tags around it, outermost first. */
type Run = { text: string; code: boolean; tags: readonly string[] };

/**
 * Telegram can't nest code in bold, italics or a link, so code closes the tags around it and opens
 * them again after, and inside a link it is plain text. Text outside a link that Telegram could
 * read as an address goes in code, whatever formatting it crosses.
 */
function telegramInline(nodes: readonly Inline[]): string {
  const runs: Run[] = [];
  flatten(nodes, [], runs);
  let html = "";
  let open: readonly string[] = [];
  for (const run of codeAddresses(runs)) {
    if (run.text === "") continue;
    const tags = run.code ? [] : run.tags;
    let kept = 0;
    while (kept < open.length && kept < tags.length && open[kept] === tags[kept]) kept += 1;
    html += closeTags(open.slice(kept));
    html += tags
      .slice(kept)
      .map((tag) => `<${tag}>`)
      .join("");
    open = tags;
    html += run.code ? `<code>${escapeHtml(run.text)}</code>` : escapeHtml(run.text);
  }
  return html + closeTags(open);
}

function flatten(nodes: readonly Inline[], tags: readonly string[], runs: Run[]): void {
  const inLink = tags.some(isLinkTag);
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        runs.push({ text: node.text, code: false, tags });
        break;
      case "code":
        runs.push({ text: node.text, code: !inLink, tags });
        break;
      case "bold":
        flatten(node.children, [...tags, "b"], runs);
        break;
      case "italic":
        flatten(node.children, [...tags, "i"], runs);
        break;
      case "link":
        flatten(node.children, [...tags, `a href="${escapeHtml(node.href)}"`], runs);
        break;
    }
  }
}

function isLinkTag(tag: string): boolean {
  return tag.startsWith("a ");
}

function closeTags(tags: readonly string[]): string {
  return tags
    .map((tag) => `</${tag.split(" ")[0]}>`)
    .reverse()
    .join("");
}

/**
 * Puts in code each address in a stretch of text outside code and links, read across the runs it
 * spans, since Telegram reads the text as shown.
 */
function codeAddresses(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  let stretch: Run[] = [];
  const flushStretch = () => {
    const text = stretch.map((run) => run.text).join("");
    const ranges = addressRanges(text);
    let next = 0;
    let offset = 0;
    for (const run of stretch) {
      const end = offset + run.text.length;
      let from = offset;
      while (from < end) {
        const range = ranges[next];
        if (range && range.start <= from) {
          if (from === range.start)
            out.push({ text: text.slice(range.start, range.end), code: true, tags: [] });
          from = Math.min(end, range.end);
          if (from === range.end) next += 1;
        } else {
          const stop = range ? Math.min(end, range.start) : end;
          out.push({ text: text.slice(from, stop), code: false, tags: run.tags });
          from = stop;
        }
      }
      offset = end;
    }
    stretch = [];
  };
  for (const run of runs) {
    if (run.code || run.tags.some(isLinkTag)) {
      flushStretch();
      out.push(run);
    } else stretch.push(run);
  }
  flushStretch();
  return out;
}

/** A host name: labels joined by dots, as Telegram's clients find one in text. */
const HOST = /(?<![\p{L}\p{N}-])[\p{L}\p{N}-]+(?:[.。．｡][\p{L}\p{N}-]+)+/gu;
/** What may follow a host in an address: a port, a path, a query or a fragment. */
const HOST_TAIL = /[/?#:][^\s<>"]*/y;
const TOP_LEVEL = /^(?:\p{L}{2,}|xn--[\p{L}\p{N}-]+)$/iu;
/** An address with any scheme, such as `tg://resolve?domain=…`, host or not. */
const SCHEMED = /(?<![\p{L}\p{N}+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s<>"]+/giu;

/**
 * Where `text` holds something Telegram could link: an address with a scheme, or a host with a
 * top-level domain or an IPv4 address, with the path after it. In order, and never overlapping.
 */
function addressRanges(text: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (const match of text.matchAll(SCHEMED)) {
    const address = trimUrl(match[0]);
    if (!address.endsWith("://"))
      found.push({ start: match.index, end: match.index + address.length });
  }
  found.push(...hostRanges(text));
  found.sort((a, b) => a.start - b.start);
  const ranges: { start: number; end: number }[] = [];
  for (const range of found) {
    const last = ranges.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else ranges.push({ ...range });
  }
  return ranges;
}

function hostRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  HOST.lastIndex = 0;
  for (let match = HOST.exec(text); match; match = HOST.exec(text)) {
    const labels = match[0].split(/[.。．｡]/);
    let count = labels.length;
    const ipv4 = count === 4 && labels.every((label) => /^\d{1,3}$/.test(label));
    // `evil.example.-` is the host `evil.example` and some text: the host ends at its last label
    // that could be a top-level domain.
    while (!ipv4 && count > 1 && !TOP_LEVEL.test(labels[count - 1] ?? "")) count -= 1;
    if (count < 2) continue;
    const start = match.index;
    let end = match.index + labels.slice(0, count).join(".").length;
    HOST_TAIL.lastIndex = end;
    const tail = count === labels.length ? HOST_TAIL.exec(text)?.[0] : undefined;
    if (tail) {
      end += trimUrl(tail).length;
      // The path's own dots aren't another host.
      HOST.lastIndex = match.index + match[0].length + tail.length;
    }
    ranges.push({ start, end });
  }
  return ranges;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
