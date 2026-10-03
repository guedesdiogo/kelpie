export interface SplitOptions {
  /** The channel's maximum message length, in UTF-16 code units (how channels such as Telegram count). */
  maxLength: number;
  /**
   * In conversational mode, the most bubbles one reply becomes; the tail is merged beyond it.
   * `maxLength` wins when both can't hold: a merged tail too long for one message is split again.
   */
  maxBubbles: number;
  /** On: one bubble per paragraph. Off: as few messages as the maximum length allows. */
  conversational: boolean;
}

type Fence = { char: string; length: number; open: string };
type Block = { kind: "text"; text: string } | { kind: "code"; text: string; fence: Fence };

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const PARAGRAPH_JOIN = "\n\n";

/** Splits one model reply into the messages to send (ADR-0002): never past `maxLength`. */
export function splitReply(text: string, options: SplitOptions): string[] {
  const blocks = toBlocks(text);
  const pieces = blocks.flatMap((block) => fitBlock(block, options.maxLength));
  if (!options.conversational) return pack(pieces, options.maxLength, PARAGRAPH_JOIN);

  const cap = Math.max(1, Math.floor(options.maxBubbles));
  if (pieces.length <= cap) return pieces;
  const head = pieces.slice(0, cap - 1);
  const tail = pack(pieces.slice(cap - 1), options.maxLength, PARAGRAPH_JOIN);
  return [...head, ...tail];
}

/** A fence opener per CommonMark: 3+ backticks or tildes; a backtick fence's info has no backtick. */
function openingFence(line: string): Fence | null {
  const match = OPENING_FENCE.exec(line);
  const marks = match?.[1];
  if (!match || !marks) return null;
  const char = marks.charAt(0);
  if (char === "`" && (match[2] ?? "").includes("`")) return null;
  return { char, length: marks.length, open: line };
}

/** A closer uses the opener's character, at least as many times, and nothing else on the line. */
function closesFence(line: string, fence: Fence): boolean {
  const marks = CLOSING_FENCE.exec(line)?.[1];
  return marks !== undefined && marks.charAt(0) === fence.char && marks.length >= fence.length;
}

/** Paragraphs separated by blank lines, with fenced code blocks kept whole. */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let fence: Fence | null = null;
  const flushText = () => {
    const paragraph = buffer.join("\n").trimEnd();
    if (paragraph.trim()) blocks.push({ kind: "text", text: paragraph });
    buffer = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (fence) {
      buffer.push(line);
      if (closesFence(line, fence)) {
        blocks.push({ kind: "code", text: buffer.join("\n"), fence });
        buffer = [];
        fence = null;
      }
      continue;
    }
    const opener = openingFence(line);
    if (opener) {
      flushText();
      buffer = [line];
      fence = opener;
    } else if (line.trim() === "") {
      flushText();
    } else {
      buffer.push(line);
    }
  }
  if (fence) blocks.push({ kind: "code", text: buffer.join("\n"), fence });
  else flushText();
  return blocks;
}

function fitBlock(block: Block, max: number): string[] {
  if (block.text.length <= max) return [block.text];
  return block.kind === "code" ? fitCode(block, max) : fitText(block.text, max, 0);
}

/** Splits an oversized code block by lines, re-opening and closing the fence on every piece. */
function fitCode({ text, fence }: Extract<Block, { kind: "code" }>, max: number): string[] {
  const lines = text.split("\n");
  const close = fence.char.repeat(fence.length);
  const hasClose = lines.length > 1 && closesFence(lines.at(-1) ?? "", fence);
  const inner = lines.slice(1, hasClose ? -1 : undefined);
  const budget = max - fence.open.length - close.length - 2;
  // A limit too small to hold the fences: send the code unfenced rather than exceed the limit.
  if (budget < 1) return fitText(inner.join("\n"), max, 0);
  const pieces = inner.flatMap((line) => (line.length <= budget ? [line] : hardCut(line, budget)));
  return pack(pieces, budget, "\n").map((chunk) => `${fence.open}\n${chunk}\n${close}`);
}

const LEVELS: { split: (text: string) => string[]; join: string }[] = [
  { split: (text) => text.split("\n"), join: "\n" },
  { split: (text) => text.split(/(?<=[.!?…])\s+/), join: " " },
  { split: (text) => text.split(/\s+/), join: " " },
];

/** Splits text by lines, then sentences, then words, then graphemes, until every piece fits. */
function fitText(text: string, max: number, level: number): string[] {
  if (text.length <= max) return [text];
  const current = LEVELS[level];
  if (!current) return hardCut(text, max);
  const units = current.split(text).filter((unit) => unit.length > 0);
  if (units.length <= 1) return fitText(text, max, level + 1);
  return pack(
    units.flatMap((unit) => fitText(unit, max, level + 1)),
    max,
    current.join,
  );
}

/** Greedily joins pieces while the result stays within `max`. */
function pack(pieces: string[], max: number, join: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const candidate = current ? `${current}${join}${piece}` : piece;
    if (candidate.length <= max) {
      current = candidate;
    } else {
      if (current) out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
  return out;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Cuts text into pieces of at most `max` code units without splitting a grapheme (an emoji, say).
 * A single grapheme wider than `max` stays whole: splitting it would corrupt the text.
 */
function hardCut(text: string, max: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const { segment } of graphemes.segment(text)) {
    if (current.length + segment.length > max && current) {
      out.push(current);
      current = "";
    }
    current += segment;
  }
  if (current) out.push(current);
  return out;
}
