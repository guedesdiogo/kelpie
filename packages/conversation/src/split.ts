export interface SplitOptions {
  /** The channel's maximum message length, in UTF-16 code units (how channels such as Telegram count). */
  maxLength: number;
  /** In conversational mode, the most bubbles one reply becomes; the tail is merged beyond it. */
  maxBubbles: number;
  /** On: one bubble per paragraph. Off: as few messages as the maximum length allows. */
  conversational: boolean;
}

type Block = { kind: "text" | "code"; text: string };

const FENCE = /^\s*```/;
const CLOSING_FENCE = /^\s*```\s*$/;
const PARAGRAPH_JOIN = "\n\n";

/** Splits one model reply into the messages to send (ADR-0002): never past `maxLength`. */
export function splitReply(text: string, options: SplitOptions): string[] {
  const blocks = toBlocks(text);
  const pieces = blocks.flatMap((block) => fitBlock(block, options.maxLength));
  if (!options.conversational) return pack(pieces, options.maxLength, PARAGRAPH_JOIN);
  if (pieces.length <= options.maxBubbles) return pieces;

  const head = pieces.slice(0, options.maxBubbles - 1);
  const tail = pack(pieces.slice(options.maxBubbles - 1), options.maxLength, PARAGRAPH_JOIN);
  return [...head, ...tail];
}

/** Paragraphs separated by blank lines, with fenced code blocks kept whole. */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let inCode = false;
  const flushText = () => {
    const paragraph = buffer.join("\n").trim();
    if (paragraph) blocks.push({ kind: "text", text: paragraph });
    buffer = [];
  };

  for (const line of text.split(/\r?\n/)) {
    if (inCode) {
      buffer.push(line);
      if (CLOSING_FENCE.test(line)) {
        blocks.push({ kind: "code", text: buffer.join("\n") });
        buffer = [];
        inCode = false;
      }
    } else if (FENCE.test(line)) {
      flushText();
      buffer = [line];
      inCode = true;
    } else if (line.trim() === "") {
      flushText();
    } else {
      buffer.push(line);
    }
  }
  if (inCode) blocks.push({ kind: "code", text: buffer.join("\n") });
  else flushText();
  return blocks;
}

function fitBlock(block: Block, max: number): string[] {
  if (block.text.length <= max) return [block.text];
  return block.kind === "code" ? fitCode(block.text, max) : fitText(block.text, max, 0);
}

/** Splits an oversized code block by lines, re-opening and closing the fence on every piece. */
function fitCode(code: string, max: number): string[] {
  const lines = code.split("\n");
  const open = lines[0] ?? "```";
  const close = "```";
  const hasClose = lines.length > 1 && CLOSING_FENCE.test(lines.at(-1) ?? "");
  const inner = lines.slice(1, hasClose ? -1 : undefined);
  const budget = max - open.length - close.length - 2;
  const pieces = inner.flatMap((line) => (line.length <= budget ? [line] : hardCut(line, budget)));
  return pack(pieces, budget, "\n").map((chunk) => `${open}\n${chunk}\n${close}`);
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

/** Cuts text into pieces of at most `max` code units without splitting a grapheme (an emoji, say). */
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
