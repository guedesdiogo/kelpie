// The request checks themselves are shared with channel-egress: see protocol.ts (#420).

/** A request body as JSON, read up to `maxBytes`; or the status that refuses it. */
export async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ value: unknown } | { status: 400 | 413 }> {
  if (Number(request.headers.get("content-length")) > maxBytes) return { status: 413 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { status: 413 };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { status: 400 };
  }
}
