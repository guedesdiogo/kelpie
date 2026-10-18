// What keeps secrets out of the text that leaves the server (ADR-0057 §3): the session-event hook
// redacts a reply before it cuts its excerpt, and the runner redacts again before anything goes
// out. This file imports nothing, so the hook stays cheap to start.

/** What stands where a secret was. */
export const REDACTED = "[redacted]";

/**
 * The words in a name that say it holds a secret, in any case. Not `tokens`, a count, nor
 * `author`; and not the shell's `PWD` and `OLDPWD`, which hold folders.
 */
const SECRET_WORDS = "key|token(?!s)|secret|pass|pwd|credential|auth(?!or)|cookie|dsn|signature";
const NAME_CHAR = "[A-Za-z0-9_.-]";
const NAME = `(?!(?:old)?pwd(?!${NAME_CHAR}))(?=${NAME_CHAR}*?(?:${SECRET_WORDS}))[A-Za-z_]${NAME_CHAR}*`;
/** `=`, but not `==` or `=>`. */
const ASSIGN = "[ \\t]*=(?![=>])";
/** A value up to its closing quote, or up to the next space. */
const VALUE = `(?:"[^"\\n]*"?|'[^'\\n]*'?|[^\\s"']+)`;
/** The schemes an `Authorization` value starts with, kept in front of what is redacted. */
const SCHEME = /^(?:Basic|Bearer|Digest|Token|Negotiate)[ \t]+/i;
/** What a name holds when it only says a type, or nothing: code, not a secret. */
const NO_SECRET = /^(?:string|number|boolean|null|undefined|true|false|unknown|any|never)\b/;

/** A line that is `NAME=value`, maybe exported: its whole value goes, to the line's end. */
const SECRET_LINE = new RegExp(`^([ \\t]*(?:export[ \\t]+)?${NAME}${ASSIGN})[^\\n]*`, "gim");
/** A YAML or header line, `name: value`, maybe a list's item: its value goes. */
const SECRET_FIELD = new RegExp(`^([ \\t]*(?:-[ \\t]+)?${NAME}[ \\t]*:[ \\t]+)([^\\n]*)`, "gim");
/** A quoted name, as JSON and code write it: `"name": value`. */
const QUOTED_FIELD = new RegExp(
  `(["'])(${NAME})\\1([ \\t]*:[ \\t]*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,}\\]]+)`,
  "gi",
);
/** A header within a quoted command, as curl's `-H 'name: value'`: up to its closing quote. */
const QUOTED_HEADER = new RegExp(`(["'])(${NAME}[ \\t]*:[ \\t]*)([^"'\\n]+)`, "gi");
/** `NAME=value` within a line, as a command's prefix, a flag or a query string: the value goes. */
const SECRET_ASSIGNMENT = new RegExp(`(?<![A-Za-z0-9_.])(${NAME}${ASSIGN}[ \\t]*)${VALUE}`, "gi");
/** A command's flag and its value: `--password value`. */
const SECRET_FLAG = new RegExp(`(?<![A-Za-z0-9_.-])(--?${NAME}[ \\t]+)(?!-)${VALUE}`, "gi");
/** curl's `-u user:password`. */
const USER_FLAG = /(?<![A-Za-z0-9_-])((?:-u|--user)[ \t=]+["']?[^\s:"']+:)[^\s"']+/g;
/** A URL's userinfo: `scheme://user:password@host`. */
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi;
/** A bearer or basic token, when it looks like one. */
const AUTH_TOKEN = /\b((?:Bearer|Basic|Token)[ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi;
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
/** A commit's SHA-1, as git writes it: 40 lowercase hex digits. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** What says, just before it, that 40 hex digits are a commit. */
const COMMIT_CONTEXT =
  /(?:^|[^A-Za-z])(?:commit|sha|merge|revert|cherry|blob|tree|rev|head|parent)[^\n]{0,24}$/i;
/**
 * 32 base64 or base64url characters or more; they go when they mix cases and digits. A `/`
 * isn't one of them, so a path is never taken whole.
 */
const BASE64 = /[A-Za-z0-9+_-]{32,}={0,2}/g;

/**
 * `text` without the secrets it shows, each replaced by REDACTED:
 * - each of `secrets`, by value;
 * - PEM blocks;
 * - the value of a name that says key, token, secret, pass, pwd, credential, auth, cookie, dsn or
 *   signature: `NAME=value`, `--name value`, `name: value` on a line of its own, `"name": value`,
 *   and a quoted header;
 * - a URL's password, curl's `-u user:password`, bearer and basic tokens;
 * - keys of a known format, and long runs of hex or base64, but a commit's SHA.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret !== "") redacted = redacted.replaceAll(secret, REDACTED);
  }
  redacted = redacted
    .replace(PEM, REDACTED)
    .replace(SECRET_LINE, `$1${REDACTED}`)
    .replace(SECRET_FIELD, (field, name: string, value: string) =>
      NO_SECRET.test(value) ? field : `${name}${schemeOf(value)}${REDACTED}`,
    )
    .replace(QUOTED_FIELD, (field, quote: string, name: string, colon: string, value: string) => {
      if (/^(?:null|true|false|-?\d+(?:\.\d+)?)$/.test(value)) return field;
      const quoted = value.startsWith('"') || value.startsWith("'");
      const shown = quoted ? `${value.charAt(0)}${REDACTED}${value.charAt(0)}` : REDACTED;
      return `${quote}${name}${quote}${colon}${shown}`;
    })
    .replace(
      QUOTED_HEADER,
      (_header, quote: string, name: string, value: string) =>
        `${quote}${name}${schemeOf(value)}${REDACTED}`,
    )
    .replace(SECRET_ASSIGNMENT, `$1${REDACTED}`)
    .replace(SECRET_FLAG, `$1${REDACTED}`)
    .replace(USER_FLAG, `$1${REDACTED}`)
    .replace(USERINFO, `$1${REDACTED}@`)
    .replace(AUTH_TOKEN, (token, scheme: string, value: string) =>
      looksLikeToken(value) ? `${scheme}${REDACTED}` : token,
    );
  for (const pattern of KNOWN_KEYS) redacted = redacted.replace(pattern, REDACTED);
  return redacted
    .replace(HEX, (run, offset: number, whole: string) =>
      COMMIT_SHA.test(run) && COMMIT_CONTEXT.test(whole.slice(Math.max(0, offset - 40), offset))
        ? run
        : REDACTED,
    )
    .replace(BASE64, (run) =>
      /[0-9]/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run) ? REDACTED : run,
    );
}

/** An `Authorization` value's scheme and its space, if it starts with one. */
function schemeOf(value: string): string {
  return SCHEME.exec(value)?.[0] ?? "";
}

/** A token, not a word: it has a digit or a symbol, or a capital past its first letter. */
function looksLikeToken(value: string): boolean {
  return /[0-9+/=_.~-]/.test(value) || /.[A-Z]/.test(value);
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
