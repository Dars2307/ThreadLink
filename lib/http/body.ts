/**
 * Reads a request body as UTF-8 text, streaming, and stops as soon as it
 * passes `maxBytes` (the rest is never buffered). A declared Content-Length
 * over the cap is refused before reading anything.
 *
 * Returns the text, or `{ tooLarge: true }`. Throws only when the body cannot
 * be read at all.
 */
export async function readCappedText(
  request: Request,
  maxBytes: number,
): Promise<string | { tooLarge: true }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true };
  const stream = request.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}
