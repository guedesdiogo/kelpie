// A static scan of a skill before the owner installs it (ADR-0058 §5), adapted from Hermes's
// `skills_guard`: patterns by category, found by file and line. It advises; Kelpie runs no script,
// and the owner reads what the agent will. Hidden characters are the exception, since they carry
// instructions the owner can't see, so they block the install.
import { fileBytes, frontmatterStrings, isScript, type SkillFile } from "./skills.ts";

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
  | "executable"
  /** An archive or a PDF, whose packed contents the scan can't read. */
  | "container";

export interface ScanFinding {
  path: string;
  /** From 1; 0 for a finding about the whole file, as an executable. */
  line: number;
  kind: FindingKind;
  /** About 120 characters of the line from a little before what was found, hidden ones spelled out. */
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
/** A keycap's digit, `#` or `*`, which a presentation selector serves before U+20E3. */
const KEYCAP_BASE = /[0-9#*]/u;
const KEYCAP = "\u{20E3}";
/** Control characters but tabs and line ends: an escape can write them where nothing shows. */
const CONTROL = /(?![\t\n\r])\p{Cc}/u;
/** In a text file's line, a control character but a tab, a form feed or a lone CR, as old sources hold. */
const LINE_CONTROL = /(?![\t\f\r])\p{Cc}/u;
const BEFORE_JOINER = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const HAN = /\p{sc=Han}/u;
const MONGOLIAN = /\p{scx=Mong}/u;
/** The scripts that shape with joiners: Arabic and its neighbours, Mongolian, India's and Southeast Asia's. */
const JOINING_SCRIPTS = [
  "Arab",
  "Syrc",
  "Mong",
  "Nkoo",
  "Mand",
  "Mani",
  "Phlp",
  "Adlm",
  "Rohg",
  "Sogd",
  "Phag",
  "Deva",
  "Beng",
  "Guru",
  "Gujr",
  "Orya",
  "Taml",
  "Telu",
  "Knda",
  "Mlym",
  "Sinh",
  "Khmr",
  "Mymr",
];
/** A letter of one of them, by its script extensions, or a mark, as a virama, of one by its own. */
const JOINING_LETTER = new RegExp(
  `(?=\\p{Lo})[${JOINING_SCRIPTS.map((script) => `\\p{scx=${script}}`).join("")}]`,
  "u",
);
const JOINING_MARK = new RegExp(
  `(?=\\p{M})[${JOINING_SCRIPTS.map((script) => `\\p{sc=${script}}`).join("")}]`,
  "u",
);
/** Unicode's tags, which a model reads as letters though nothing shows them. */
const TAG = /[\u{E0000}-\u{E007F}]/u;
/** In binary data, a run this long of characters that show nothing, or of tags, spells something. */
const MIN_RUN = 8;
const MIN_TAGS = 4;
/** Tags this many in a file spell something however they are spread; by chance, never. */
const MIN_SCATTERED_TAGS = 8;
/** Bytes whose text is at least this share printable read as text with a stray byte. */
const TEXT_SHARE = 0.9;
/** Past this many ideographic or Mongolian variants in a skill, they read as a code, not as text. */
const MAX_VARIANTS = 8;
/** Rules read a line in windows this long, so a line of any length costs the same per character. */
const WINDOW = 2_000;
const OVERLAP = 400;
/** An excerpt starts this many characters before what it shows. */
const EXCERPT_LEAD = 40;

/** Archives, PDFs and other packed formats, by their first bytes: what they pack, the scan can't read. */
const CONTAINERS: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x1f, 0x8b],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  [0x42, 0x5a, 0x68],
  [0x52, 0x61, 0x72, 0x21],
  [0x28, 0xb5, 0x2f, 0xfd],
  [0x25, 0x50, 0x44, 0x46],
  [0x50, 0x4b, 0x07, 0x08],
  [0x04, 0x22, 0x4d, 0x18],
  [0x1f, 0x9d],
  [0x4d, 0x53, 0x43, 0x46],
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00],
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
 * Scans each file of a skill, line by line. A binary file's bytes are read as the text they may
 * hold too, as UTF-8 and as the UTF-16 a BOM names, with UTF-16 tags found in the bytes whatever
 * comes first: when that text isn't mostly printable, only what spells words in it counts, runs of
 * tags and of characters that show nothing. The SKILL.md's description is read as its YAML decodes
 * it, since that is what reaches the agent.
 */
export function scanSkill(files: readonly SkillFile[]): ScanResult {
  // Hidden characters are listed first, so the finding that blocks is never past the list's end.
  const hiddenFindings: ScanFinding[] = [];
  const otherFindings: ScanFinding[] = [];
  let total = 0;
  let blocked = false;
  const add = (finding: Omit<ScanFinding, "excerpt">, excerpt: () => string) => {
    total += 1;
    const list = finding.kind === "hidden_characters" ? hiddenFindings : otherFindings;
    if (list.length < MAX_FINDINGS) list.push({ ...finding, excerpt: excerpt() });
  };
  const hide = (finding: Omit<ScanFinding, "excerpt" | "kind">, excerpt: () => string) => {
    blocked = true;
    add({ ...finding, kind: "hidden_characters" }, excerpt);
  };
  // Variants count across the whole skill, so spreading them over lines or files hides nothing.
  const variantLines: { path: string; line: number; text: string; offsets: number[] }[] = [];
  // Each line is reported once, whatever finds it.
  const flagged = new Set<string>();
  const flag = (path: string, line: number) => {
    const key = `${line}:${path}`;
    const fresh = !flagged.has(key);
    flagged.add(key);
    return fresh;
  };

  /**
   * Scans a file's text; whether it found hidden characters. A text file's control characters
   * count too: one read as text with a stray byte has them by chance.
   */
  const scanText = (path: string, content: string, data: boolean, controls: boolean): boolean => {
    let hid = false;
    const script = isScript(path);
    const instructions = path.toLowerCase().endsWith(".md");
    // In binary data, tags spread over the file count together.
    const tagLines: { line: number; text: string; tags: number[] }[] = [];
    content.split(/\r?\n/).forEach((line, index) => {
      // A BOM opens a file legitimately; anywhere else it hides.
      const scanned = index === 0 ? line.replace(/^\u{FEFF}/u, "") : line;
      const at = { path, line: index + 1 };
      if (MAYBE_HIDDEN.test(scanned) || (controls && LINE_CONTROL.test(scanned))) {
        const { found, variants } = data
          ? {
              found: spelledIn(scanned, (tags) =>
                tagLines.push({ line: index + 1, text: scanned, tags }),
              ),
              variants: [],
            }
          : hiddenIn(scanned);
        if (controls) {
          let offset = 0;
          for (const char of scanned) {
            if (LINE_CONTROL.test(char)) found.add(offset);
            offset += char.length;
          }
        }
        if (variants.length > 0) variantLines.push({ ...at, text: scanned, offsets: variants });
        if (found.size > 0 && flag(path, at.line)) {
          hid = true;
          let first = Number.POSITIVE_INFINITY;
          for (const offset of found) first = Math.min(first, offset);
          hide(at, () => excerpt(scanned, first, (_char, offset) => found.has(offset)));
        }
      }
      if (data) return;
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
    const scattered = tagLines.reduce((sum, { tags }) => sum + tags.length, 0);
    if (scattered >= MIN_SCATTERED_TAGS) {
      hid = true;
      for (const { line, text, tags } of tagLines) {
        if (!flag(path, line)) continue;
        const shown = new Set(tags);
        hide({ path, line }, () =>
          excerpt(text, tags[0] ?? 0, (_char, offset) => shown.has(offset)),
        );
      }
    }
    return hid;
  };

  for (const file of files) {
    if (!file.binary) {
      scanText(file.path, file.content, false, true);
      if (file.path === "SKILL.md") scanFrontmatter(file, variantLines, hide, flag);
      continue;
    }
    const bytes = fileBytes(file);
    // One a machine would run, or one that packs what the scan can't read, is a finding of its own.
    if (isExecutable(file)) add({ path: file.path, line: 0, kind: "executable" }, () => "");
    else if (isContainer(bytes)) {
      add({ path: file.path, line: 0, kind: "container" }, () => "");
    }
    let hid = false;
    for (const text of decodings(bytes))
      hid = scanText(file.path, text, !mostlyText(text), false) || hid;
    // Tags in UTF-16 no decoding read, as with no BOM, once.
    const tags = hid ? null : utf16Tags(bytes);
    if (tags !== null) hide({ path: file.path, line: 0 }, () => tags);
  }

  const variants = variantLines.reduce((sum, { offsets }) => sum + offsets.length, 0);
  if (variants > MAX_VARIANTS) {
    for (const { text, offsets, ...at } of variantLines) {
      const shown = new Set(offsets);
      hide(at, () => excerpt(text, offsets[0] ?? 0, (_char, offset) => shown.has(offset)));
    }
  }
  const findings = [...hiddenFindings, ...otherFindings].slice(0, MAX_FINDINGS);
  return {
    verdict: blocked ? "blocked" : total > 0 ? "caution" : "clean",
    findings,
    more: total - findings.length,
  };
}

/**
 * Text with what hides in it left out, as the scan finds it, variants too: an agent's prompt takes
 * a skill's name and description this way, from files no scan may have read, emoji sequences and
 * joining scripts whole.
 */
export function withoutHidden(text: string): string {
  if (!MAYBE_HIDDEN.test(text)) return text;
  const { found, variants } = hiddenIn(text);
  for (const at of variants) found.add(at);
  let kept = "";
  let offset = 0;
  for (const char of text) {
    if (!found.has(offset)) kept += char;
    offset += char.length;
  }
  return kept;
}

/**
 * The SKILL.md's frontmatter as its YAML decodes it: an escape such as `\U000E0049` writes a
 * hidden character, or a control one, the file's text doesn't show. A string the file shows as it
 * is, its own lines were scanned for.
 */
function scanFrontmatter(
  file: SkillFile,
  variantLines: { path: string; line: number; text: string; offsets: number[] }[],
  hide: (finding: Omit<ScanFinding, "excerpt" | "kind">, excerpt: () => string) => void,
  flag: (path: string, line: number) => boolean,
): void {
  const parsed = frontmatterStrings(file.content);
  if (!parsed) return;
  // Only the plain spaces and line ends YAML folds; anything else must show as it is.
  const plain = (text: string) => text.replace(/[ \t\r\n]+/g, "");
  const raw = plain(parsed.head);
  const lines = parsed.head.split(/\r?\n/);
  for (const { key, text } of parsed.strings) {
    if (!MAYBE_HIDDEN.test(text) && !CONTROL.test(text)) continue;
    if (raw.includes(plain(text))) continue;
    const { found, variants } = hiddenIn(text);
    let offset = 0;
    for (const char of text) {
      if (CONTROL.test(char)) found.add(offset);
      offset += char.length;
    }
    const keyed = (line: string) => {
      const rest = line.replace(/^["']/, "");
      return rest.startsWith(key) && /^["']?\s*:/.test(rest.slice(key.length));
    };
    const index = key === "" ? -1 : lines.findIndex(keyed);
    // The frontmatter's lines start after its opening `---`.
    const at = { path: file.path, line: index === -1 ? 1 : index + 2 };
    if (variants.length > 0) variantLines.push({ ...at, text, offsets: variants });
    if (found.size === 0 || !flag(at.path, at.line)) continue;
    let first = Number.POSITIVE_INFINITY;
    for (const hidden of found) first = Math.min(first, hidden);
    hide(at, () => excerpt(text, first, (_char, offset) => found.has(offset)));
  }
}

/**
 * Where a line hides text, as offsets into it, and the ideographic or Mongolian variants it holds.
 * A joiner shapes text between emoji, or between letters of a script that joins; a variation
 * selector after the emoji, the ideograph or the Mongolian letter it serves. Anywhere else they
 * only hide; the variants are counted per skill.
 */
function hiddenIn(line: string): { found: Set<number>; variants: number[] } {
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
        const serves = PICTOGRAPH.test(before) || (KEYCAP_BASE.test(before) && after === KEYCAP);
        if (!base || !serves) found.add(at);
      } else if (base && (MONGOLIAN_SELECTOR.test(char) ? MONGOLIAN : HAN).test(before)) {
        variants.push(at);
      } else {
        found.add(at);
      }
    } else if (FORMAT.test(char)) {
      found.add(at);
    }
  });
  return { found, variants };
}

const joins = (char: string) => JOINING_LETTER.test(char) || JOINING_MARK.test(char);

/**
 * Where binary data spells words that don't show: runs of four or more tags, or of eight or more
 * invisible characters. One alone happens by chance in compressed bytes; `onTags` hears every tag
 * a line holds, for the count over the whole file.
 */
function spelledIn(line: string, onTags: (tags: number[]) => void): Set<number> {
  const found = new Set<number>();
  const all: number[] = [];
  const tags: number[] = [];
  const invisibles: number[] = [];
  const close = (run: number[], least: number) => {
    if (run.length >= least) for (const at of run) found.add(at);
    run.length = 0;
  };
  let offset = 0;
  for (const char of line) {
    if (TAG.test(char)) {
      tags.push(offset);
      all.push(offset);
    } else close(tags, MIN_TAGS);
    if (MAYBE_HIDDEN.test(char)) invisibles.push(offset);
    else close(invisibles, MIN_RUN);
    offset += char.length;
  }
  close(tags, MIN_TAGS);
  close(invisibles, MIN_RUN);
  if (all.length > 0) onTags(all);
  return found;
}

/** Whether decoded bytes are mostly text: few replacement characters and controls. */
function mostlyText(text: string): boolean {
  let all = 0;
  let printable = 0;
  for (const char of text) {
    all += 1;
    const code = char.codePointAt(0) ?? 0;
    const control = (code < 0x20 && !"\t\n\r\f".includes(char)) || code === 0x7f;
    if (!control && code !== 0xfffd) printable += 1;
  }
  return all === 0 || printable / all >= TEXT_SHARE;
}

/** A long line in overlapping windows, so no rule reads more than WINDOW characters at a time. */
function windows(line: string): { text: string; start: number }[] {
  if (line.length <= WINDOW) return [{ text: line, start: 0 }];
  const out: { text: string; start: number }[] = [];
  for (let start = 0; start < line.length; start += WINDOW - OVERLAP) {
    out.push({ text: line.slice(start, start + WINDOW), start });
  }
  return out;
}

/** An executable, by its name or its first bytes: Windows' MZ, ELF, Mach-O and WebAssembly. */
function isExecutable(file: SkillFile): boolean {
  if (/\.(?:exe|dll|so|dylib|bin|com|msi|scr|app)$/i.test(file.path)) return true;
  const head = fileBytes(file).subarray(0, 4);
  const magic = Array.from(head, (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    magic.startsWith("4d5a") ||
    magic === "7f454c46" ||
    magic === "0061736d" ||
    ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(magic)
  );
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** An archive or a PDF: by its first bytes, a tar's `ustar` at 257, or a PDF's header within 1 KiB. */
function isContainer(bytes: Uint8Array): boolean {
  if (CONTAINERS.some((magic) => starts(bytes, magic))) return true;
  if (starts(bytes.subarray(257), [0x75, 0x73, 0x74, 0x61, 0x72])) return true;
  const head = bytes.subarray(0, 1_024);
  for (let at = 0; at + 3 < head.length; at += 1) {
    if (starts(head.subarray(at), [0x25, 0x50, 0x44, 0x46])) return true;
  }
  return false;
}

/**
 * The text bytes may hold: as UTF-8, with what fails replaced, whatever a BOM says, so two bytes in
 * front can't change how the rest is read; and as UTF-16 too, when a BOM names it.
 */
function decodings(bytes: Uint8Array): string[] {
  const out = [new TextDecoder().decode(bytes)];
  const utf16 =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : null;
  if (utf16) out.push(new TextDecoder(utf16).decode(bytes));
  return out;
}

/**
 * Tags in UTF-16, of either byte order and at any offset, found in the bytes, so a file with no
 * BOM can't hide them: a run of four or more, or eight or more however spread, spelled out; or null.
 */
function utf16Tags(bytes: Uint8Array): string | null {
  const tagAt = (at: number): number | null => {
    const [a, b, c, d] = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]];
    if (a === 0x40 && b === 0xdb && d === 0xdc && c !== undefined && c < 0x80) return c;
    if (a === 0xdb && b === 0x40 && c === 0xdc && d !== undefined && d < 0x80) return d;
    return null;
  };
  const lows: number[] = [];
  let total = 0;
  let longest = 0;
  for (let align = 0; align < 4; align += 1) {
    let run = 0;
    for (let at = align; at + 3 < bytes.length; at += 4) {
      const low = tagAt(at);
      if (low === null) {
        run = 0;
        continue;
      }
      run += 1;
      total += 1;
      longest = Math.max(longest, run);
      if (lows.length < 12) lows.push(low);
    }
  }
  return longest >= MIN_TAGS || total >= MIN_SCATTERED_TAGS ? spellTags(lows) : null;
}

const spellTags = (lows: readonly number[]) =>
  lows
    .slice(0, 12)
    .map((low) => `⟨U+${(0xe0000 + low).toString(16).toUpperCase()}⟩`)
    .join("");

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
