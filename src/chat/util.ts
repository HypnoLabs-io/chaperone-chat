/** Small helpers the engine shares. */
import { encodeBytes } from "../links/base64url";

/** A random id with a prefix that names what it is (`c_` conversation, `p_` participant, `m_` message, `e_` event). */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${encodeBytes(bytes)}`;
}

/**
 * A message as typed, cleaned: line breaks normalized, control characters out (newlines and tabs kept), runs of blank
 * lines folded, trimmed. Length is checked on the result.
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A probability rounded to three places for an event's meta. */
export const round3 = (p: number | null | undefined): number | null =>
  typeof p === "number" && Number.isFinite(p) ? Math.round(p * 1000) / 1000 : null;
