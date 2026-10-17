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
 * Characters that hide text: format characters (bidirectional controls, zero-width characters, word
 * joiners, invisible operators, a soft hyphen, Unicode's tags), the line and paragraph separators,
 * and the Hangul fillers.
 */
const FORMAT = /\p{Cf}|[\u{2028}\u{2029}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{E0000}-\u{E007F}]/u;
/** Variation selectors: one picks a glyph's form, a run of them can spell bytes. */
const SELECTOR = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;
/** The zero-width joiner and non-joiner, which shape emoji and the letters of some scripts. */
const JOINER = /[\u{200C}\u{200D}]/u;
const MAYBE_HIDDEN = new RegExp(`${FORMAT.source}|${SELECTOR.source}`, "u");
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
/** A letter or mark of a script that joins, as Arabic or Devanagari; Latin, Greek and Cyrillic don't. */
const JOINING = /^(?![\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}])[\p{L}\p{M}]$/u;
/** Rules read a line in windows this long, so a line of any length costs the same per character. */
const WINDOW = 2_000;
const OVERLAP = 400;

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

/** Scans each text file of a skill, line by line. */
export function scanSkill(files: readonly SkillFile[]): ScanResult {
  const findings: ScanFinding[] = [];
  let total = 0;
  let blocked = false;
  const add = (finding: Omit<ScanFinding, "excerpt">, excerpt: () => string) => {
    total += 1;
    if (findings.length < MAX_FINDINGS) findings.push({ ...finding, excerpt: excerpt() });
  };
  for (const file of files) {
    // A binary file isn't read as text; one a machine would run is a finding.
    if (file.binary) {
      if (isExecutable(file)) add({ path: file.path, line: 0, kind: "executable" }, () => "");
      continue;
    }
    const script = isScript(file.path);
    const instructions = file.path.toLowerCase().endsWith(".md");
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      // A BOM opens a file legitimately; anywhere else it hides.
      const scanned = index === 0 ? line.replace(/^\u{FEFF}/u, "") : line;
      const at = { path: file.path, line: index + 1 };
      const chars = MAYBE_HIDDEN.test(scanned) ? [...scanned] : null;
      const hidden = chars ? hiddenIn(chars) : new Set<number>();
      let shown: string | undefined;
      const lineExcerpt = () => {
        shown ??= excerpt(chars ?? [...scanned.slice(0, WINDOW)], hidden);
        return shown;
      };
      if (hidden.size > 0) {
        blocked = true;
        add({ ...at, kind: "hidden_characters" }, lineExcerpt);
      }
      // A run of spaces counts as one, so padding can't push a phrase's words apart.
      const parts = windows(scanned.replace(/\s+/gu, " "));
      for (const rule of RULES) {
        if (rule.in === "instructions" && !instructions) continue;
        if (rule.in === "scripts" && !script) continue;
        if (parts.some((part) => rule.pattern.test(part))) {
          add({ ...at, kind: rule.kind }, lineExcerpt);
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
 * The characters of a line that hide text, by their index in its code points. A joiner between
 * emoji, or between letters of a script that joins, shapes text, and so does one variation selector
 * after a character; a joiner inside a Latin word, or a run of selectors, only hides.
 */
function hiddenIn(chars: readonly string[]): Set<number> {
  const found = new Set<number>();
  chars.forEach((char, index) => {
    const before = chars[index - 1] ?? "";
    const after = chars[index + 1] ?? "";
    if (JOINER.test(char)) {
      const shapes =
        (EMOJI.test(before) && PICTOGRAPH.test(after)) ||
        (JOINING.test(before) && JOINING.test(after));
      if (!shapes) found.add(index);
    } else if (SELECTOR.test(char)) {
      const alone = before !== "" && !/\s/u.test(before) && !SELECTOR.test(before);
      if (!alone || SELECTOR.test(after)) found.add(index);
    } else if (FORMAT.test(char)) {
      found.add(index);
    }
  });
  return found;
}

/** A long line in overlapping windows, so no rule reads more than WINDOW characters at a time. */
function windows(line: string): string[] {
  if (line.length <= WINDOW) return [line];
  const out: string[] = [];
  for (let start = 0; start < line.length; start += WINDOW - OVERLAP) {
    out.push(line.slice(start, start + WINDOW));
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

/** A line as the review shows it: hidden characters spelled `U+200B`, at most 120 characters. */
function excerpt(chars: readonly string[], hidden: ReadonlySet<number>): string {
  const shown = chars
    .slice(0, WINDOW)
    .map((char, index) =>
      hidden.has(index)
        ? `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`
        : char,
    )
    .join("")
    .trim();
  const cut = [...shown];
  return cut.length > EXCERPT_CHARS ? `${cut.slice(0, EXCERPT_CHARS - 1).join("")}…` : shown;
}
