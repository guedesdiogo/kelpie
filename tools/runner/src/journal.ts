/** The most of one text from Claude Code that the runner's log keeps. */
export const MAX_LOGGED_CHARS = 2_000;

/**
 * Text from Claude Code, such as its stderr or an error's message, made fit for the journal: one
 * line, with every control character and line separator as a space, cut at MAX_LOGGED_CHARS.
 */
export function forLog(text: string): string {
  let line = "";
  for (const char of text.slice(0, MAX_LOGGED_CHARS)) {
    const code = char.codePointAt(0) as number;
    const control =
      code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    line += control ? " " : char;
  }
  return text.length > MAX_LOGGED_CHARS ? `${line}…` : line;
}
