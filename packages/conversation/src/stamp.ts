// Each user message reaches the model with the local time it was sent, written into its text once
// and never rewritten, so history stays append-only and the system prompt never changes (Story
// 3.12). The time zone isn't in the system prompt for the same reason.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * `[Sat 3 Oct 2026, 23:30, America/Sao_Paulo, UTC-03:00]`. Without a time zone the stamp says UTC
 * explicitly, `[Sun 4 Oct 2026, 02:30, UTC]`, so the model never mistakes it for local time.
 * The separators are written here, not taken from the locale, so the stamp is the same on every
 * runtime.
 */
export function stampOf(epochMs: number, timeZone: string | null): string {
  const parts = Object.fromEntries(
    formatterFor(timeZone ?? "UTC")
      .formatToParts(epochMs)
      .map((part) => [part.type, part.value]),
  );
  const when = `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
  if (!timeZone) return `[${when}, UTC]`;
  return `[${when}, ${timeZone}, ${utcOffset(parts.timeZoneName ?? "")}]`;
}

/** `GMT-03:00` becomes `UTC-03:00`; a zero offset is plain `UTC`, however the runtime writes it. */
function utcOffset(name: string): string {
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
  if (!match?.[1]) return "UTC";
  const hours = (match[2] ?? "0").padStart(2, "0");
  const minutes = match[3] ?? "00";
  return hours === "00" && minutes === "00" ? "UTC" : `UTC${match[1]}${hours}:${minutes}`;
}

/** Exactly the shapes `stampOf` writes, so ordinary bracketed text is left alone. */
const STAMP_AT_START =
  /^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}, [A-Za-z][A-Za-z0-9_/+-]{0,63}(?:, UTC(?:[+-]\d{2}:\d{2})?)?\]/;
/** Invisible characters that could hide in front of a typed stamp. */
const FORMAT_CHARACTERS = /[\u200B-\u200F\u2060-\u2064\uFEFF]/g;
/** `]` and its fullwidth lookalike, which NFKC turns into `]`. */
const CLOSING_BRACKET = /[\]\uFF3D]/;
/** More stamps than this at the start of one line is an attack; the line is dropped. */
const MAX_STAMPS_PER_LINE = 20;

/**
 * Removes stamps a user typed at the start of any line, so no one can fake when a message was
 * sent. Lookalike brackets and invisible characters are caught too: each line is compared in NFKC
 * form with format characters removed. Text in any other shape is only a claim the user makes.
 */
export function withoutTypedStamps(text: string): string {
  return text.split("\n").map(withoutLineStamps).join("\n");
}

function withoutLineStamps(line: string): string {
  let rest = line;
  for (let removed = 0; looksStamped(rest); removed += 1) {
    const end = rest.search(CLOSING_BRACKET);
    if (end < 0 || removed === MAX_STAMPS_PER_LINE) return "";
    rest = rest.slice(end + 1).replace(/^\s+/, "");
  }
  return rest;
}

function looksStamped(line: string): boolean {
  return STAMP_AT_START.test(line.normalize("NFKC").replace(FORMAT_CHARACTERS, ""));
}
