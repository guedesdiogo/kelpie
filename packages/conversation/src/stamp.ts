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
  const offset = parts.timeZoneName === "GMT" ? "UTC" : `UTC${parts.timeZoneName?.slice(3)}`;
  return `[${when}, ${timeZone}, ${offset}]`;
}

const TYPED_STAMP =
  /^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}, [^\]\n]{1,80}\]\s*/;

/** Removes stamps a user typed at the start of a message, so no one can fake the time it was sent. */
export function withoutTypedStamps(text: string): string {
  let rest = text;
  while (TYPED_STAMP.test(rest)) rest = rest.replace(TYPED_STAMP, "");
  return rest;
}
