/** JSON responses and request bodies, Web-standard. */

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

export function failure(error: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json({ ok: false, error, ...extra }, status, headers);
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

/** The request's JSON body, read up to `maxBytes`: 405, 415, 413 or 400 otherwise. */
export async function readJson(req: Request, maxBytes: number): Promise<BodyResult> {
  if (req.method !== "POST") {
    return { ok: false, response: failure("method_not_allowed", 405, {}, { Allow: "POST" }) };
  }
  const type = req.headers.get("content-type") ?? "";
  if (!/\bjson\b/i.test(type)) return { ok: false, response: failure("unsupported_media_type", 415) };
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, response: failure("body_too_large", 413) };
  if (!req.body) return { ok: false, response: failure("invalid_body", 400) };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, response: failure("body_too_large", 413) };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, response: failure("invalid_body", 400) };
  }
}
