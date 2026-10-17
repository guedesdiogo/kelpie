// A static scan of a skill before the owner installs it (ADR-0058 §5), adapted from Hermes's
// `skills_guard`: patterns by category, found by file and line. It advises; Kelpie runs no script,
// and the owner reads what the agent will. Hidden characters are the exception, since they carry
// instructions the owner can't see, so they block the install.
import { fileBytes, isScript, type SkillFile } from "./skills.ts";

export type FindingKind =
  | "hidden_characters"
  | "prompt_injection"
  | "secrets"
  | "exfiltration"
  | "destructive"
  | "obfuscation"
  | "persistence"
  | "privilege"
  | "supply_chain"
  | "traversal"
  | "mining"
  | "executable";

export interface ScanFinding {
  path: string;
  /** From 1; 0 for a finding about the whole file, as an executable. */
  line: number;
  kind: FindingKind;
  /** The line, cut to 120 characters, hidden characters spelled out. */
  excerpt: string;
}

export interface ScanResult {
  verdict: "clean" | "caution" | "blocked";
  findings: ScanFinding[];
  /** Findings past the first 50 aren't listed. */
  more: number;
}

const MAX_FINDINGS = 50;
const EXCERPT_CHARS = 120;

/**
 * Characters that hide text: the default-ignorable code points and the format characters
 * (bidirectional controls, zero-width characters, joiners, invisible operators, a soft hyphen, the
 * Hangul fillers, Unicode's tags), and the line and paragraph separators.
 */
const FORMAT = /\p{Default_Ignorable_Code_Point}|\p{Cf}|[\u{2028}\u{2029}]/u;
/** Variation selectors pick a glyph's form after the characters they serve; elsewhere they spell bytes. */
const SELECTOR = /\p{Variation_Selector}/u;
const EMOJI_SELECTOR = /[\u{FE0E}\u{FE0F}]/u;
const MONGOLIAN_SELECTOR = /[\u{180B}-\u{180D}\u{180F}]/u;
/** The zero-width joiner and non-joiner, which shape emoji and the letters of some scripts. */
const JOINER = /[\u{200C}\u{200D}]/u;
const MAYBE_HIDDEN = new RegExp(`${FORMAT.source}|${SELECTOR.source}`, "u");
const EMOJI = /\p{Emoji}/u;
const BEFORE_JOINER = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const HAN = /\p{sc=Han}/u;
const MONGOLIAN = /\p{scx=Mong}/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
/** The scripts that shape with joiners: Arabic and its neighbours, Mongolian, India's and Southeast Asia's. */
const JOINS =
  /[\p{scx=Arab}\p{scx=Syrc}\p{scx=Mong}\p{scx=Nkoo}\p{scx=Mand}\p{scx=Mani}\p{scx=Phlp}\p{scx=Adlm}\p{scx=Rohg}\p{scx=Sogd}\p{scx=Phag}\p{scx=Deva}\p{scx=Beng}\p{scx=Guru}\p{scx=Gujr}\p{scx=Orya}\p{scx=Taml}\p{scx=Telu}\p{scx=Knda}\p{scx=Mlym}\p{scx=Sinh}\p{scx=Khmr}\p{scx=Mymr}]/u;
/** Past this many ideographic or Mongolian variants on one line, they read as a code, not as text. */
const MAX_VARIANTS = 8;
/** Rules read a line in windows this long, so a line of any length costs the same per character. */
const WINDOW = 2_000;
const OVERLAP = 400;
/** An excerpt starts this many characters before what it shows. */
const EXCERPT_LEAD = 40;

/** Binary files a format explains, by their extension and their first bytes: images, fonts, PDFs and archives. */
const BINARY: [RegExp, (head: Uint8Array) => boolean][] = [
  [/\.png$/i, (head) => starts(head, [0x89, 0x50, 0x4e, 0x47])],
  [/\.jpe?g$/i, (head) => starts(head, [0xff, 0xd8, 0xff])],
  [/\.gif$/i, (head) => starts(head, [0x47, 0x49, 0x46, 0x38])],
  [
    /\.webp$/i,
    (head) =>
      starts(head, [0x52, 0x49, 0x46, 0x46]) && starts(head.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  ],
  [/\.ico$/i, (head) => starts(head, [0, 0, 1, 0])],
  [/\.pdf$/i, (head) => starts(head, [0x25, 0x50, 0x44, 0x46])],
  [
    /\.(?:zip|docx|xlsx|pptx|odt|ods|odp)$/i,
    (head) => starts(head, [0x50, 0x4b, 0x03, 0x04]) || starts(head, [0x50, 0x4b, 0x05, 0x06]),
  ],
  [/\.(?:gz|tgz)$/i, (head) => starts(head, [0x1f, 0x8b])],
  [/\.woff$/i, (head) => starts(head, [0x77, 0x4f, 0x46, 0x46])],
  [/\.woff2$/i, (head) => starts(head, [0x77, 0x4f, 0x46, 0x32])],
  [
    /\.(?:ttf|otf|ttc)$/i,
    (head) =>
      starts(head, [0, 1, 0, 0]) ||
      starts(head, [0x4f, 0x54, 0x54, 0x4f]) ||
      starts(head, [0x74, 0x74, 0x63, 0x66]),
  ],
];

interface Rule {
  kind: Exclude<FindingKind, "hidden_characters" | "executable">;
  pattern: RegExp;
  /** Where it applies: the instructions the model reads, the scripts, or both. */
  in: "instructions" | "scripts" | "any";
}

const RULES: Rule[] = [
  {
    kind: "prompt_injection",
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|your|system)\s+(?:instructions|rules|directions|prompts?|guidelines)\b/i,
    in: "instructions",
  },
  {
    kind: "prompt_injection",
    pattern:
      /\b(?:reveal|print|show|output|repeat|leak)\b[^\n]{0,40}\b(?:system prompt|hidden instructions|developer (?:message|prompt))\b/i,
    in: "instructions",
  },
  {
    kind: "prompt_injection",
    pattern:
      /\b(?:don't|do not|never)\s+(?:tell|inform|show|mention (?:this |it )?to)\s+(?:the\s+)?(?:user|owner)\b/i,
    in: "instructions",
  },
  {
    kind: "secrets",
    pattern:
      /(?:~|\$HOME|\$\{HOME\})\/\.(?:ssh|aws|gnupg|kube|docker|netrc)\b|\bid_(?:rsa|ed25519)\b|\/etc\/(?:passwd|shadow)\b|\b(?:AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)\b/,
    in: "any",
  },
  {
    kind: "exfiltration",
    pattern:
      /\b(?:curl|wget|Invoke-WebRequest|requests\.(?:post|put)|fetch)\b[^\n]{0,160}(?:\$\{?[A-Z][A-Z0-9_]{2,}|\b(?:token|secret|password|api[_-]?key|credentials?)\b)/i,
    in: "any",
  },
  { kind: "exfiltration", pattern: /\/dev\/tcp\/|\bnc\s+(?:-[a-z]{0,8}e|-c)\b/, in: "any" },
  {
    kind: "destructive",
    pattern:
      /\brm\s+-[a-z]{0,8}(?:rf|fr)[a-z]{0,8}\s+(?:\/|~|\$HOME|\*)(?:\s|$)|\bmkfs(?:\.\w+)?\b|\bdd\s+if=[^\n]{0,200}of=\/dev\/|:\(\)\s*\{\s*:\|:&\s*\};:/,
    in: "any",
  },
  {
    kind: "obfuscation",
    pattern:
      /\b(?:eval|exec)\s*\(\s*(?:base64|atob|b64decode|codecs\.decode|bytes\.fromhex)|base64\s+(?:-d|--decode)[^\n]{0,200}\|\s*(?:ba|z)?sh\b|\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
    in: "any",
  },
  {
    kind: "persistence",
    pattern:
      /\bcrontab\b|\/etc\/cron|\blaunchctl\s+(?:load|bootstrap)\b|\bsystemctl\s+enable\b|(?:~|\$HOME)\/\.(?:bashrc|zshrc|profile|bash_profile)\b/,
    in: "any",
  },
  {
    kind: "supply_chain",
    pattern:
      /\b(?:pip3?|uv\s+pip|npm|pnpm|yarn|bun)\s+(?:install|add|i)\b[^\n]{0,200}(?:https?:\/\/|git\+)|\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:python3?|node|perl|ruby)\b/,
    in: "any",
  },
  { kind: "traversal", pattern: /(?:\.\.\/){2,}|\.\.\\\.\.\\/, in: "any" },
  {
    kind: "mining",
    pattern: /\bstratum\+(?:tcp|ssl):\/\/|\b(?:xmrig|minerd|cpuminer)\b/i,
    in: "any",
  },
  {
    kind: "privilege",
    pattern: /\bsudo\s+\S|\bchmod\s+(?:[ugoa]*\+s|[0-7]?[4-7][0-7]{2}7)\b|\bsetuid\b/,
    in: "any",
  },
];

/**
 * Scans each text file of a skill, line by line. A binary file no format explains is read as text
 * too, so one stray byte can't keep a file's lines from the scan.
 */
export function scanSkill(files: readonly SkillFile[]): ScanResult {
  const findings: ScanFinding[] = [];
  let total = 0;
  let blocked = false;
  const add = (finding: Omit<ScanFinding, "excerpt">, excerpt: () => string) => {
    total += 1;
    if (findings.length < MAX_FINDINGS) findings.push({ ...finding, excerpt: excerpt() });
  };
  for (const file of files) {
    let content = file.content;
    if (file.binary) {
      // One a machine would run is a finding of its own.
      const executable = isExecutable(file);
      if (executable) add({ path: file.path, line: 0, kind: "executable" }, () => "");
      if (executable || isKnownBinary(file)) continue;
      content = asText(fileBytes(file));
    }
    const script = isScript(file.path);
    const instructions = file.path.toLowerCase().endsWith(".md");
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      // A BOM opens a file legitimately; anywhere else it hides.
      const scanned = index === 0 ? line.replace(/^\u{FEFF}/u, "") : line;
      const at = { path: file.path, line: index + 1 };
      const hidden = MAYBE_HIDDEN.test(scanned) ? hiddenIn(scanned) : new Set<number>();
      if (hidden.size > 0) {
        blocked = true;
        let first = Number.POSITIVE_INFINITY;
        for (const offset of hidden) first = Math.min(first, offset);
        add({ ...at, kind: "hidden_characters" }, () =>
          excerpt(scanned, first, (_char, offset) => hidden.has(offset)),
        );
      }
      // A run of spaces counts as one, so padding can't push a phrase's words apart.
      const spaced = scanned.replace(/\s+/gu, " ");
      const parts = windows(spaced);
      for (const rule of RULES) {
        if (rule.in === "instructions" && !instructions) continue;
        if (rule.in === "scripts" && !script) continue;
        for (const part of parts) {
          const match = rule.pattern.exec(part.text);
          if (!match) continue;
          add({ ...at, kind: rule.kind }, () =>
            excerpt(spaced, part.start + match.index, (char) => MAYBE_HIDDEN.test(char)),
          );
          break;
        }
      }
    });
  }
  return {
    verdict: blocked ? "blocked" : total > 0 ? "caution" : "clean",
    findings,
    more: total - findings.length,
  };
}

/**
 * Where a line hides text, as offsets into it. A joiner shapes text between emoji, or between
 * letters of a script that joins; a variation selector after the emoji, the ideograph or the
 * Mongolian letter it serves. Anywhere else, and past a few variants a line, they only hide.
 */
function hiddenIn(line: string): Set<number> {
  const chars = [...line];
  const found = new Set<number>();
  const variants: number[] = [];
  let offset = 0;
  chars.forEach((char, index) => {
    const at = offset;
    offset += char.length;
    const before = chars[index - 1] ?? "";
    const after = chars[index + 1] ?? "";
    if (JOINER.test(char)) {
      const shapes =
        (BEFORE_JOINER.test(before) && PICTOGRAPH.test(after)) || (joins(before) && joins(after));
      if (!shapes) found.add(at);
    } else if (SELECTOR.test(char)) {
      const base = before !== "" && !SELECTOR.test(before);
      if (EMOJI_SELECTOR.test(char)) {
        if (!base || !EMOJI.test(before)) found.add(at);
      } else if (base && (MONGOLIAN_SELECTOR.test(char) ? MONGOLIAN : HAN).test(before)) {
        variants.push(at);
      } else {
        found.add(at);
      }
    } else if (FORMAT.test(char)) {
      found.add(at);
    }
  });
  if (variants.length > MAX_VARIANTS) for (const at of variants) found.add(at);
  return found;
}

const joins = (char: string) => LETTER_OR_MARK.test(char) && JOINS.test(char);

/** A long line in overlapping windows, so no rule reads more than WINDOW characters at a time. */
function windows(line: string): { text: string; start: number }[] {
  if (line.length <= WINDOW) return [{ text: line, start: 0 }];
  const out: { text: string; start: number }[] = [];
  for (let start = 0; start < line.length; start += WINDOW - OVERLAP) {
    out.push({ text: line.slice(start, start + WINDOW), start });
  }
  return out;
}

/** An executable, by its name or its first bytes: Windows' MZ, ELF and Mach-O. */
function isExecutable(file: SkillFile): boolean {
  if (/\.(?:exe|dll|so|dylib|bin|com|msi|scr|app)$/i.test(file.path)) return true;
  const head = fileBytes(file).subarray(0, 4);
  const magic = Array.from(head, (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    magic.startsWith("4d5a") ||
    magic === "7f454c46" ||
    ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(magic)
  );
}

/** A binary file whose extension names a format its first bytes confirm. */
function isKnownBinary(file: SkillFile): boolean {
  const head = fileBytes(file).subarray(0, 16);
  return BINARY.some(([extension, matches]) => extension.test(file.path) && matches(head));
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** Bytes as the text they may hold: UTF-16 when a BOM says so, else UTF-8, with what fails replaced. */
function asText(bytes: Uint8Array): string {
  const label =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/**
 * A line as the review shows it: about 120 characters from a little before `around`, an offset into
 * it, with the characters `spelled` picks written out as `U+200B`.
 */
function excerpt(
  line: string,
  around: number,
  spelled: (char: string, offset: number) => boolean,
): string {
  let start = Math.max(0, around - EXCERPT_LEAD);
  const code = line.charCodeAt(start);
  if (start > 0 && code >= 0xdc00 && code <= 0xdfff) start -= 1;
  let shown = "";
  let offset = start;
  for (const char of line.slice(start, start + EXCERPT_CHARS * 4)) {
    shown += spelled(char, offset)
      ? `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`
      : char;
    offset += char.length;
  }
  const chars = [...(start > 0 ? `…${shown.trimEnd()}` : shown.trim())];
  return chars.length > EXCERPT_CHARS
    ? `${chars.slice(0, EXCERPT_CHARS - 1).join("")}…`
    : chars.join("");
}
