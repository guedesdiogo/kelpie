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
 * Bidirectional controls, zero-width characters, word joiners and invisible operators, a BOM past
 * the start, and Unicode's tag characters, which can spell text that doesn't show.
 */
const HIDDEN =
  /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}]|[\u{E0000}-\u{E007F}]/u;
const HIDDEN_ALL = new RegExp(HIDDEN.source, "gu");

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
  { kind: "exfiltration", pattern: /\/dev\/tcp\/|\bnc\s+(?:-[a-z]*e|-c)\b/, in: "any" },
  {
    kind: "destructive",
    pattern:
      /\brm\s+-[a-z]*(?:rf|fr)[a-z]*\s+(?:\/|~|\$HOME|\*)(?:\s|$)|\bmkfs(?:\.\w+)?\b|\bdd\s+if=[^\n]*of=\/dev\/|:\(\)\s*\{\s*:\|:&\s*\};:/,
    in: "any",
  },
  {
    kind: "obfuscation",
    pattern:
      /\b(?:eval|exec)\s*\(\s*(?:base64|atob|b64decode|codecs\.decode|bytes\.fromhex)|base64\s+(?:-d|--decode)[^\n]*\|\s*(?:ba|z)?sh\b|\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
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
      /\b(?:pip3?|uv\s+pip|npm|pnpm|yarn|bun)\s+(?:install|add|i)\b[^\n]*(?:https?:\/\/|git\+)|\b(?:curl|wget)\b[^\n|]*\|\s*(?:python3?|node|perl|ruby)\b/,
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
  const add = (finding: ScanFinding) => {
    total += 1;
    if (findings.length < MAX_FINDINGS) findings.push(finding);
  };
  for (const file of files) {
    // A binary file isn't read as text; one a machine would run is a finding.
    if (file.binary) {
      if (isExecutable(file)) add({ path: file.path, line: 0, kind: "executable", excerpt: "" });
      continue;
    }
    const script = isScript(file.path);
    const instructions = file.path.toLowerCase().endsWith(".md");
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      // A BOM opens a file legitimately; anywhere else it hides.
      const scanned = index === 0 ? line.replace(/^\u{FEFF}/u, "") : line;
      if (HIDDEN.test(scanned)) {
        blocked = true;
        add({
          path: file.path,
          line: index + 1,
          kind: "hidden_characters",
          excerpt: excerpt(scanned),
        });
      }
      for (const rule of RULES) {
        if (rule.in === "instructions" && !instructions) continue;
        if (rule.in === "scripts" && !script) continue;
        if (rule.pattern.test(scanned)) {
          add({ path: file.path, line: index + 1, kind: rule.kind, excerpt: excerpt(scanned) });
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
function excerpt(line: string): string {
  const shown = line
    .replace(
      HIDDEN_ALL,
      (char) => `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`,
    )
    .trim();
  const chars = [...shown];
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS - 1).join("")}…` : shown;
}
