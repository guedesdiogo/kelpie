// What keeps secrets out of the text that leaves the server (ADR-0057 §3): the session-event hook
// redacts a reply before it cuts its excerpt, and the runner redacts again before anything goes
// out. This file imports nothing, so the hook stays cheap to start.

/** What stands where a secret was. */
export const REDACTED = "[redacted]";

/** A variable's name that says it holds a secret: key, token, secret or password, in any case. */
const NAME = "(?=[A-Za-z0-9_.-]*?(?:key|token|secret|password))[A-Za-z_][A-Za-z0-9_.-]*";
/** `=`, but not `==` or `=>`. */
const ASSIGN = String.raw`[ \t]*=(?![=>])`;

/** A line that is `NAME=value`, maybe exported: its whole value goes, to the line's end. */
const SECRET_LINE = new RegExp(String.raw`^([ \t]*(?:export[ \t]+)?${NAME}${ASSIGN})[^\n]*`, "gim");
/** `NAME=value` within a line, as a command's prefix or a query string: the value goes. */
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(${NAME}${ASSIGN}[ \t]*)(?:"[^"\n]*"?|'[^'\n]*'?|[^\s"']+)`,
  "gi",
);
const BEARER = /(\bBearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** A PEM block, or what is left of one when the text ends inside it. */
const PEM = /-----BEGIN [A-Z0-9 ]{1,64}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,64}-----|$)/g;
/** Keys whose format says what they are: Anthropic's and OpenAI's, GitHub's, AWS's. */
const KNOWN_KEYS = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
];
/** 32 hex digits or more, as the runner's own secret, 64 of them. */
const HEX = /[0-9a-fA-F]{32,}/g;
/** 32 base64 or base64url characters or more; they go when they mix cases and digits. */
const BASE64 = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

/**
 * `text` without the secrets it shows: each of `secrets`, by value; then PEM blocks, `NAME=value`
 * whose name says key, token, secret or password, bearer tokens, keys of a known format, and long
 * runs of hex or base64. Each becomes REDACTED. It errs toward redacting: a long path that mixes
 * cases and digits goes too.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret !== "") redacted = redacted.replaceAll(secret, REDACTED);
  }
  redacted = redacted
    .replace(PEM, REDACTED)
    .replace(SECRET_LINE, `$1${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`);
  for (const pattern of KNOWN_KEYS) redacted = redacted.replace(pattern, REDACTED);
  return redacted
    .replace(HEX, REDACTED)
    .replace(BASE64, (run) =>
      /[0-9]/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run) ? REDACTED : run,
    );
}

/**
 * The first `max` characters of `text`, without a trailing partial word. A text that is one word
 * that long is cut where it reaches `max`. Redact before cutting, so no secret straddles the cut.
 */
export function excerptOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  if (/\s/.test(text.charAt(max))) return head.trimEnd();
  const space = head.search(/\s\S*$/);
  return space > 0 ? head.slice(0, space).trimEnd() : cut(text, max);
}

/** The first `max` characters of `text`, never half of a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const last = head.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}
