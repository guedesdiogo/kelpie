// Zip archives for the tests, built byte by byte: stored or deflated entries, and the odd ones a
// skill's install must refuse (a link, an encrypted entry, a lying size).
import { crc32 } from "../src/zip.ts";

export interface TestEntry {
  path: string;
  content?: string | Uint8Array;
  deflate?: boolean;
  link?: boolean;
  encrypted?: boolean;
  /** The uncompressed size the directory declares, when it should lie. */
  declared?: number;
}

const encoder = new TextEncoder();

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function makeZip(entries: readonly TestEntry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const raw =
      typeof entry.content === "string"
        ? encoder.encode(entry.content)
        : (entry.content ?? new Uint8Array());
    const data = entry.deflate ? await deflateRaw(raw) : raw;
    const crc = crc32(raw);
    const flags = (entry.encrypted ? 1 : 0) | 0x800;
    const method = entry.deflate ? 8 : 0;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, entry.declared ?? raw.length, true);
    cv.setUint16(28, name.length, true);
    const mode = entry.link ? 0o120777 : entry.path.endsWith("/") ? 0o40755 : 0o100644;
    cv.setUint32(38, (mode << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const directory = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directory, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A SKILL.md with its frontmatter. */
export const skillMd = (name: string, description = `Does ${name}.`, body = `# ${name}\n`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
