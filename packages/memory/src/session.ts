// A conversation's session page (#109): built by rule, with no model call, from the messages of
// one stretch of conversation. Its shape follows ai-memory's rule-based session pages at fc4da03
// (`crates/ai-memory-hooks/src/synth.rs`): a title from the first message, a metadata line, then
// the messages, with the first and last kept when there are too many.
import { memoryPath, type Scope, slugify } from "./layout.ts";
import { sanitizeSecrets } from "./sanitize.ts";
import { writeMemory } from "./write.ts";

export interface SessionLine {
  role: "user" | "assistant";
  /** Who said it: a user id, or the agent's id. */
  speaker: string;
  text: string;
  /** Epoch milliseconds. */
  at: number;
}

export interface SessionInput {
  /** Names this session in the page's path, so two sessions never share a file: a history row id. */
  key: string;
  channel: string;
  threadId: string;
  /** The IANA time zone a person in the conversation last gave, or null for UTC. */
  timeZone: string | null;
  lines: readonly SessionLine[];
}

export interface SessionPage {
  path: string;
  text: string;
  /** How many secrets the sanitizer replaced. */
  redactions: number;
}

/** Each message is cut to this many characters, after its secrets are replaced. */
const EXCERPT_CHARS = 280;
/**
 * Only a message's start is read: the page shows at most its first 280 characters, and a secret
 * cut off past this can't reach them. It bounds the sanitizer's work on long messages.
 */
const READ_CHARS = 8_192;
const BEGIN_KEY = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const END_KEY = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
/** A longer session keeps its first and last messages. */
const HEAD_LINES = 30;
const TAIL_LINES = 30;
/** How sure a session page is: what the owner said alone, or with others in a group (#109). */
const PRIVATE_CONFIDENCE = 0.9;
const GROUP_CONFIDENCE = 0.6;

function zoneOf(timeZone: string | null): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** `YYYY-MM-DD` and `HH:MM` of an instant in a time zone. */
function clock(at: number, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/**
 * One line of text, at most `max` characters. `[[` is broken, so a message doesn't add links to
 * the vault's graph.
 */
function excerpt(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").replaceAll("[[", "[ [").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Each message's text with its secrets replaced. A private key one speaker opened and didn't close
 * is redacted in their next messages too, up to its end, as when it is pasted in parts.
 */
function sanitizeAll(lines: readonly SessionLine[]): { texts: string[]; redactions: number } {
  let redactions = 0;
  /** Who opened a private key that no message of theirs has closed yet. */
  let keyHolder: string | null = null;
  const texts = lines.map((line) => {
    let text = line.text.slice(0, READ_CHARS);
    if (keyHolder !== null && line.speaker === keyHolder) {
      const end = END_KEY.exec(text);
      if (end === null) {
        text = "";
      } else {
        keyHolder = null;
        text = text.slice(end.index + end[0].length);
      }
      text = `[REDACTED:private_key]${text}`;
      redactions += 1;
    }
    const begin = BEGIN_KEY.exec(text);
    if (begin && !END_KEY.test(text.slice(begin.index))) keyHolder = line.speaker;
    const sanitized = sanitizeSecrets(text);
    redactions += sanitized.redactions;
    return sanitized.text;
  });
  return { texts, redactions };
}

/** A speaker as plain text: nothing that Markdown would read as structure. */
function plainName(name: string): string {
  return excerpt(name.replace(/[*_#`[\]()<>|\\]/g, " "), 64) || "someone";
}

/**
 * The session page for a stretch of conversation, or null when no person spoke in it. Secrets are
 * replaced before anything is cut, so a cut can't split one past the sanitizer.
 */
export async function sessionPage(input: SessionInput): Promise<SessionPage | null> {
  const lines = [...input.lines].sort((a, b) => a.at - b.at);
  const firstUser = lines.find((line) => line.role === "user");
  const first = lines[0];
  const last = lines.at(-1);
  if (!firstUser || !first || !last) return null;

  const timeZone = zoneOf(input.timeZone);
  // Each message is sanitized once, before anything is cut.
  const { texts, redactions } = sanitizeAll(lines);
  const cleanText = (line: SessionLine) => texts[lines.indexOf(line)] ?? "";

  const start = clock(first.at, timeZone);
  const end = clock(last.at, timeZone);
  const opening = excerpt(cleanText(firstUser), 200);
  const title = excerpt(`${clock(firstUser.at, timeZone).time} ${opening}`, 120);
  const source = `${input.channel}:${input.threadId}`.replace(/[\p{Cc}]/gu, "").slice(0, 300);
  const thread = input.threadId.replace(/^-/, "g");
  const scope = `conversation/${slugify(`${input.channel}-${thread}`)}` as Scope;
  const speakers = new Set(
    lines.filter((line) => line.role === "user").map((line) => line.speaker),
  );

  const shown =
    lines.length > HEAD_LINES + TAIL_LINES
      ? [...lines.slice(0, HEAD_LINES), null, ...lines.slice(-TAIL_LINES)]
      : lines;
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  const body = [
    `${input.channel} · ${start.date} ${start.time}–${end.time} (${timeZone}) · ${lines.length} messages`,
    "",
    ...shown.map((line) =>
      line === null
        ? `- … ${omitted} messages omitted …`
        : `- **${clock(line.at, timeZone).time} ${plainName(line.speaker)}:** ${excerpt(cleanText(line), EXCERPT_CHARS)}`,
    ),
  ].join("\n");

  const { text } = await writeMemory(
    {
      scope,
      kind: "session",
      title,
      body,
      level: "explicit",
      confidence: speakers.size > 1 ? GROUP_CONFIDENCE : PRIVATE_CONFIDENCE,
      sources: [source],
      // A first message with nothing left once sanitized has no abstract.
      ...(opening === "" ? {} : { abstract: opening }),
    },
    { at: new Date(last.at).toISOString().replace(/\.\d{3}Z$/, "Z") },
  );
  return {
    path: memoryPath(scope, "session", `${title} ${input.key}`, start.date),
    text,
    redactions,
  };
}
