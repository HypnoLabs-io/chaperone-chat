/**
 * chaperone-chat/links: signed link tokens. A token names ONE kind and ONE subject (in the chat, a participant id),
 * with an expiry, HMAC-SHA256-signed under a per-kind prefix (`chat.v1.`), so a token of one kind never verifies as
 * another. The signature is checked (constant-time, inside the runtime's WebCrypto) before the payload is parsed.
 *
 * Format: `base64url(JSON {v: 1, s: subject, e: expiry in seconds}) "." base64url(HMAC-SHA256(secret, kind ".v1." payload))`.
 *
 * Rotation: `secret` may be a list. New tokens are signed with the first; a token signed with any of them verifies,
 * so a new secret can go first while links already sent keep working until the old one is dropped.
 *
 * The token belongs in a URL fragment (`#t=…`), never a query string, so it never reaches a server log; and a route
 * should act on a POST, never a GET, because link scanners and message previews fetch every URL they see.
 *
 * WebCrypto only: Node 22+, Bun, Deno, workers.
 */
import { ChaperoneError } from "../errors";
import { decodeBytes, decodeText, encodeBytes, encodeText, isBase64url } from "./base64url";

export { ChaperoneError, isChaperoneError } from "../errors";

/** A secret shorter than this is refused: a short or placeholder secret lets anyone forge a link. */
export const MIN_SECRET_LENGTH = 32;
/** A longer token is refused before anything is decoded. */
export const MAX_TOKEN_LENGTH = 512;
/** A subject is 1 to this many characters. */
export const MAX_SUBJECT_LENGTH = 128;

const KIND = /^[a-z][a-z0-9_-]{0,31}$/;

export interface LinksOptions {
  /** At least 32 characters each. A list rotates: the first signs, any verifies. */
  secret: string | readonly string[];
}

export interface SignInput {
  /** Short and lowercase ("chat"). A token verifies only as its own kind. */
  kind: string;
  /** What the token stands for (a participant id). 1 to 128 characters. */
  subject: string;
  /** When it stops working. Give this or `ttlMs`. */
  expiresAt?: Date;
  /** How long it works from `now`. */
  ttlMs?: number;
  now?: Date;
}

export type VerifyResult =
  | { ok: true; subject: string; expiresAt: Date }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export interface Links {
  sign(input: SignInput): Promise<string>;
  /** Checks a token against the kind the caller expects. Never throws. */
  verify(token: unknown, kind: string, now?: Date): Promise<VerifyResult>;
}

/** The URL fragment that carries a token: `${pageUrl}${tokenFragment(token)}`. */
export function tokenFragment(token: string): string {
  return `#t=${token}`;
}

export function createLinks(options: LinksOptions): Links {
  const secrets = (typeof options.secret === "string" ? [options.secret] : [...options.secret]).map((s) =>
    typeof s === "string" ? s.trim() : "",
  );
  if (secrets.length === 0 || secrets.some((s) => s.length < MIN_SECRET_LENGTH)) {
    throw new ChaperoneError(
      "invalid_secret",
      `every link secret must be at least ${MIN_SECRET_LENGTH} characters; a short or placeholder secret lets anyone forge a link`,
    );
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new ChaperoneError("no_webcrypto", "this runtime has no WebCrypto (crypto.subtle)");

  const keys = new Map<string, ReturnType<typeof subtle.importKey>>();
  const keyFor = (secret: string) => {
    let key = keys.get(secret);
    if (!key) {
      key = subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
      ]);
      keys.set(secret, key);
    }
    return key;
  };
  const signed = (kind: string, payload: string) => new TextEncoder().encode(`${kind}.v1.${payload}`);

  return {
    async sign(input) {
      if (!KIND.test(input.kind)) throw new ChaperoneError("invalid_link", `a link kind is lowercase, 1-32 characters: "${input.kind}"`);
      if (typeof input.subject !== "string" || input.subject.length === 0 || input.subject.length > MAX_SUBJECT_LENGTH) {
        throw new ChaperoneError("invalid_link", `a link subject is 1-${MAX_SUBJECT_LENGTH} characters`);
      }
      const now = input.now ?? new Date();
      const expiresAt = input.expiresAt ?? (input.ttlMs !== undefined ? new Date(now.getTime() + input.ttlMs) : null);
      if (!expiresAt || !Number.isFinite(expiresAt.getTime())) {
        throw new ChaperoneError("invalid_link", "a link needs expiresAt or ttlMs");
      }
      const e = Math.floor(expiresAt.getTime() / 1000);
      const payload = encodeText(JSON.stringify({ v: 1, s: input.subject, e }));
      const signature = await subtle.sign("HMAC", await keyFor(secrets[0] as string), signed(input.kind, payload));
      return `${payload}.${encodeBytes(new Uint8Array(signature))}`;
    },

    async verify(token, kind, now = new Date()) {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH || !KIND.test(kind)) {
        return { ok: false, reason: "malformed" };
      }
      const dot = token.indexOf(".");
      if (dot <= 0 || dot !== token.lastIndexOf(".") || dot === token.length - 1) return { ok: false, reason: "malformed" };
      const payload = token.slice(0, dot);
      const signatureText = token.slice(dot + 1);
      if (!isBase64url(payload) || !isBase64url(signatureText)) return { ok: false, reason: "malformed" };
      const signature = decodeBytes(signatureText);
      if (!signature || signature.length !== 32) return { ok: false, reason: "bad-signature" };

      let valid = false;
      for (const secret of secrets) {
        if (await subtle.verify("HMAC", await keyFor(secret), signature, signed(kind, payload))) {
          valid = true;
          break;
        }
      }
      if (!valid) return { ok: false, reason: "bad-signature" };

      const json = decodeText(payload);
      let parsed: unknown;
      try {
        parsed = json === null ? null : JSON.parse(json);
      } catch {
        parsed = null;
      }
      const p = parsed as { v?: unknown; s?: unknown; e?: unknown } | null;
      if (!p || p.v !== 1 || typeof p.s !== "string" || !p.s || typeof p.e !== "number" || !Number.isFinite(p.e)) {
        return { ok: false, reason: "malformed" };
      }
      if (p.e * 1000 <= now.getTime()) return { ok: false, reason: "expired" };
      return { ok: true, subject: p.s, expiresAt: new Date(p.e * 1000) };
    },
  };
}
