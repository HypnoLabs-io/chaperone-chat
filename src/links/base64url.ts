/** base64url without padding, over bytes, with no `Buffer`: runs on Node, Bun, Deno, workers and browsers. */

const ALPHABET = /^[A-Za-z0-9_-]*$/;

export function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes, or null when `text` isn't base64url. */
export function decodeBytes(text: string): Uint8Array | null {
  if (!ALPHABET.test(text) || text.length % 4 === 1) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isBase64url(text: string): boolean {
  return ALPHABET.test(text);
}

export const encodeText = (text: string): string => encodeBytes(new TextEncoder().encode(text));

export function decodeText(text: string): string | null {
  const bytes = decodeBytes(text);
  if (!bytes) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
