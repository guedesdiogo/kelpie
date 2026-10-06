// biome-ignore-all lint/suspicious/noControlCharactersInRegex: this file matches control characters on purpose
// The secrets sanitizer for captured conversations (ADR-0020 §4: secrets only, no personal-data
// gate). Translated from ai-memory's `sanitize.rs` at fc4da03
// (https://github.com/akitaonrails/ai-memory/blob/fc4da03/crates/ai-memory-core/src/sanitize.rs),
// with changes:
// - each pattern runs only when the text holds one of its literal markers, as hermes-agent's
//   `redact.py` gates its own, and quantifiers are bounded, because V8's regexes backtrack;
// - an unterminated private key is redacted to the end of the text;
// - rules for chat: passwords in Portuguese, Spanish and English prose and fields, more vendor
//   prefixes, cookies, credentials in a curl command or as a URL's user, and 40-character keys
//   next to "AWS" or "Cloudflare", which have no prefix of their own;
// - zero-width characters are removed, so one can't hide a secret.
//
// ai-memory is MIT licensed:
// Copyright (c) 2026 Fabio Akita
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

/** Terminal escape sequences, removed whole so a colour code leaves nothing behind. */
const ESCAPES =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/**
 * C0 and C1 controls but tab, newline and carriage return; DEL; bidirectional overrides; and
 * invisible characters that could split a secret: zero-width spaces, marks, word joiners, the
 * soft hyphen and the BOM. The zero-width joiner stays, for emoji.
 */
const CONTROLS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Lowercase markers; the pattern runs only when the lowercased text holds one. */
  markers: readonly string[];
}

/** Most specific first. A false positive costs a word; a miss puts a secret in git. */
const RULES: readonly Rule[] = [
  { kind: "bearer_token", pattern: /bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, markers: ["bearer"] },
  {
    kind: "stripe_key",
    pattern: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{16,}/g,
    markers: ["_live_", "_test_"],
  },
  { kind: "api_key", pattern: /sk-[A-Za-z0-9_-]{16,}/g, markers: ["sk-"] },
  { kind: "github_token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g, markers: ["gh"] },
  { kind: "github_token", pattern: /github_pat_[A-Za-z0-9_]{20,}/g, markers: ["github_pat_"] },
  {
    kind: "gitlab_token",
    pattern: /gl(?:pat|dt|rt|cbt|ptt|ft|imt|agent)-[A-Za-z0-9_-]{20,}/g,
    markers: ["gl"],
  },
  // Exactly the published length: "ASIA" is also a word, and redaction can't be undone.
  { kind: "aws_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, markers: ["akia", "asia"] },
  { kind: "google_api_key", pattern: /AIza[A-Za-z0-9_-]{30,}/g, markers: ["aiza"] },
  { kind: "google_api_key", pattern: /AQ\.Ab[A-Za-z0-9_-]{30,}/g, markers: ["aq.ab"] },
  { kind: "google_oauth", pattern: /1\/\/[0-9A-Za-z_-]{20,}/g, markers: ["1//"] },
  { kind: "google_oauth", pattern: /ya29\.[0-9A-Za-z_-]{20,}/g, markers: ["ya29."] },
  { kind: "meta_token", pattern: /EAA[A-Za-z0-9]{20,}/g, markers: ["eaa"] },
  { kind: "npm_token", pattern: /npm_[A-Za-z0-9]{30,}/g, markers: ["npm_"] },
  { kind: "huggingface_token", pattern: /hf_[A-Za-z0-9]{30,}/g, markers: ["hf_"] },
  {
    kind: "sendgrid_key",
    pattern: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    markers: ["sg."],
  },
  { kind: "webhook_secret", pattern: /whsec_[A-Za-z0-9+/=]{20,}/g, markers: ["whsec_"] },
  {
    kind: "api_key",
    pattern: /(?:xai|gsk|cfut|cfat)[-_][A-Za-z0-9]{20,}/g,
    markers: ["xai", "gsk_", "cfut_", "cfat_"],
  },
  // A bot token: the bot's id, a colon, and the secret; anchored so times and ports don't match.
  // No word boundary before it: in the Bot API's URL it follows "bot" directly.
  {
    kind: "telegram_token",
    pattern: /(?<!\d)\d{6,10}:(?:AA[A-Za-z0-9_-]{30,}|[A-Za-z0-9_-]{34,35})(?![A-Za-z0-9_-])/g,
    markers: [":"],
  },
  {
    kind: "ghl_token",
    pattern: /pit-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
    markers: ["pit-"],
  },
  { kind: "slack_token", pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g, markers: ["xox"] },
  { kind: "slack_token", pattern: /xapp-[A-Za-z0-9-]{10,}/g, markers: ["xapp-"] },
  {
    kind: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    markers: ["eyj"],
  },
  { kind: "base64_json_token", pattern: /eyJ[A-Za-z0-9_\-+/]{40,}={0,2}/g, markers: ["eyj"] },
  {
    kind: "private_key",
    pattern:
      /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g,
    markers: ["private key"],
  },
  // An unterminated key, cut or pasted in part: the rest of the text goes.
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/g,
    markers: ["private key"],
  },
  {
    kind: "url_credentials",
    pattern: /[a-zA-Z][a-zA-Z0-9+\-.]{0,31}:\/\/[^:/\s@]{1,200}:[^@\s]{1,200}@[^\s]+/g,
    markers: ["://"],
  },
  // A token as a URL's user, as GitHub accepts for git over HTTPS.
  {
    kind: "url_credentials",
    pattern: /[a-zA-Z][a-zA-Z0-9+\-.]{0,31}:\/\/[A-Za-z0-9_-]{20,200}@[^\s]+/g,
    markers: ["://"],
  },
  { kind: "cookie", pattern: /\b(?:set-)?cookie\s*:\s*[^\n]+/gi, markers: ["cookie"] },
  {
    kind: "curl_credentials",
    pattern: /(?:^|\s)(?:-u|--user)\s+[^\s:]{1,200}:\S+/g,
    markers: ["-u", "--user"],
  },
  // A header or field whose name says it carries a credential. A bare `key` or `token` suffix
  // doesn't: `Idempotency-Key` and continuation tokens hold none.
  {
    kind: "auth_header",
    pattern:
      /\b[A-Za-z0-9_-]{0,40}?(?:authentication|authorization|credentials?|apikey|accountkey|authtoken|(?:api|auth|access|secret|security|private|session|refresh|client|consumer|subscription|app|bearer)-(?:key|token))"?\s*[=:]\s*(?:(?:basic|bearer|digest|token|apikey)\s+)?"?[^\s"'[][^\s"']{7,}/gi,
    markers: ["auth", "credential", "apikey", "accountkey", "-key", "-token"],
  },
  {
    kind: "env_secret",
    pattern:
      /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|VOYAGE_API_KEY|MISTRAL_API_KEY|GROQ_API_KEY|HF_TOKEN|HUGGINGFACE_TOKEN|AWS_(?:SECRET_)?ACCESS_KEY[A-Z_]*|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|GOOGLE_API_KEY|GEMINI_API_KEY|OLLAMA_API_KEY)"?\s*[=:]\s*[^\s[]\S*/gi,
    markers: ["_key", "_token"],
  },
  {
    kind: "env_secret",
    pattern:
      /\b[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL|CREDENTIALS|PRIVATE_KEY)"?\s*[=:]\s*[^\s[]\S*/gi,
    markers: ["_key", "_token", "_secret", "_pass", "_pwd", "_credential"],
  },
  // Uppercase only, as environment variables are: as code identifiers these are plain names.
  {
    kind: "env_secret",
    pattern:
      /\b[A-Z][A-Z0-9_]*_(?:KEY_ID|PASSPHRASE|SIGNING_KEY|PEPPER|SALT)"?\s*[=:]\s*[^\s[]\S*/g,
    markers: ["_key_id", "_passphrase", "_signing_key", "_pepper", "_salt"],
  },
  // A password, secret or token named in a field or an assignment, in any case and quoting:
  // `senha: x`, `"token": "x"`, `accessToken=x`, `DB_PASS=x`. Symbols count as part of the value.
  {
    kind: "password",
    pattern:
      /["']?\b[A-Za-z0-9_-]{0,40}?(?:password|passwd|passphrase|pwd|pass|senha|contrase[ñn]a|segredo|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)["']?\s*[=:]\s*["']?[^\s"',;}[][^\s"',;}]*/gi,
    markers: ["pass", "pwd", "senha", "contrase", "segredo", "secret", "token", "key"],
  },
  // A password in prose: "minha senha é x", "my password is x", "mi contraseña es x".
  {
    kind: "password",
    pattern:
      /\b(?:senha|password|passphrase|contrase[ñn]a)\s+(?:(?:é|e|is|es|era|was)\s+)["']?[^\s"',;]+/gi,
    markers: ["senha", "password", "passphrase", "contrase"],
  },
  // AWS secret keys and Cloudflare API tokens have no prefix: a 40-character key in a text that
  // names either goes. A commit hash nearby may go too, which is the cost.
  {
    kind: "unprefixed_key",
    pattern: /(?<![A-Za-z0-9/+_-])[A-Za-z0-9/+_-]{40}(?![A-Za-z0-9/+_-])/g,
    markers: ["aws", "secret access key", "cloudflare"],
  },
];

export interface Sanitized {
  text: string;
  /** How many secrets were replaced. */
  redactions: number;
}

/**
 * Replaces secrets and credentials with `[REDACTED:<kind>]`. Run it before any cut, so a secret
 * split by a truncation is still found; running it twice changes nothing more.
 */
export function sanitizeSecrets(input: string): Sanitized {
  let text = input.replace(ESCAPES, "").replace(CONTROLS, "");
  let redactions = 0;
  for (const rule of RULES) {
    const lower = text.toLowerCase();
    if (!rule.markers.some((marker) => lower.includes(marker))) continue;
    text = text.replace(rule.pattern, () => {
      redactions += 1;
      return `[REDACTED:${rule.kind}]`;
    });
  }
  return { text, redactions };
}
