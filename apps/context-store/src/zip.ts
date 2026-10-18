// A zip archive's entries, read without trusting it (ADR-0058 §5): a skill's `.zip` or `.skill`
// file, or a GitHub archive. Only what a skill needs: stored and deflated entries, no ZIP64, no
// encryption. Each entry is read only when asked, and never past the size its central directory
// declares, so a small archive can't inflate into a large one.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The end record is 22 bytes, after a comment of up to 65,535. */
const EOCD_SEARCH = 22 + 0xffff;
const UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export class ZipError extends Error {
  constructor(
    readonly reason: "not_zip" | "unsupported" | "corrupt",
    message: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  /** As the archive names it, decoded as UTF-8. */
  path: string;
  /** The uncompressed size the central directory declares. */
  size: number;
  directory: boolean;
  /** A symbolic link, from its Unix mode. */
  link: boolean;
  encrypted: boolean;
  /** Its bytes, refused past `size` or when they don't match its CRC. */
  read(): Promise<Uint8Array>;
}

const names = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The archive's entries, from its central directory, in its order. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(view);
  if (end === -1) throw new ZipError("not_zip", "no end of central directory");
  const disk = view.getUint16(end + 4, true);
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const offset = view.getUint32(end + 16, true);
  if (disk !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new ZipError("unsupported", "a multi-part archive");
  }
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ZipError("unsupported", "a ZIP64 archive");
  }
  if (offset + size > end) throw new ZipError("corrupt", "the central directory runs past its end");
  const entries: ZipEntry[] = [];
  let at = offset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL) {
      throw new ZipError("corrupt", "a central directory entry is missing");
    }
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const external = view.getUint32(at + 38, true);
    const local = view.getUint32(at + 42, true);
    const nameEnd = at + 46 + nameLength;
    if (nameEnd > end) throw new ZipError("corrupt", "a name runs past the directory");
    let path: string;
    try {
      path = names.decode(bytes.subarray(at + 46, nameEnd));
    } catch {
      throw new ZipError("unsupported", "a name that isn't UTF-8");
    }
    const link = madeBy >> 8 === UNIX && ((external >>> 16) & S_IFMT) === S_IFLNK;
    entries.push({
      path,
      size: uncompressed,
      directory: path.endsWith("/"),
      link,
      encrypted: (flags & 1) === 1,
      read: () => readEntry(bytes, view, { local, method, compressed, uncompressed, crc }),
    });
    at = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function findEnd(view: DataView): number {
  const last = view.byteLength - 22;
  for (let at = last; at >= 0 && at >= last - EOCD_SEARCH; at -= 1) {
    if (view.getUint32(at, true) === EOCD) return at;
  }
  return -1;
}

async function readEntry(
  bytes: Uint8Array,
  view: DataView,
  entry: { local: number; method: number; compressed: number; uncompressed: number; crc: number },
): Promise<Uint8Array> {
  const { local, method, compressed, uncompressed } = entry;
  if (local + 30 > view.byteLength || view.getUint32(local, true) !== LOCAL) {
    throw new ZipError("corrupt", "an entry's local header is missing");
  }
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  if (start + compressed > view.byteLength)
    throw new ZipError("corrupt", "an entry runs past its end");
  const data = bytes.subarray(start, start + compressed);
  let out: Uint8Array;
  if (method === 0) {
    if (compressed !== uncompressed) throw new ZipError("corrupt", "a stored entry's sizes differ");
    out = data;
  } else if (method === 8) {
    out = await inflate(data, uncompressed);
  } else {
    throw new ZipError("unsupported", `compression method ${method}`);
  }
  if (crc32(out) !== entry.crc) throw new ZipError("corrupt", "an entry's CRC doesn't match");
  return out;
}

/** Inflates raw deflate, stopping as soon as it passes `most` bytes. */
async function inflate(data: Uint8Array, most: number): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const out = new Uint8Array(most);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > most) {
        await reader.cancel();
        throw new ZipError("corrupt", "an entry inflates past its declared size");
      }
      out.set(value, size);
      size += value.byteLength;
    }
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError("corrupt", "an entry doesn't inflate");
  }
  if (size !== most) throw new ZipError("corrupt", "an entry inflates short of its declared size");
  return out;
}

let table: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (table === null) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
