import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLinks, isChaperoneError, MAX_TOKEN_LENGTH, tokenFragment } from "../../src/links";

const SECRET = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const NOW = new Date("2026-01-01T00:00:00Z");
const DAY = 86_400_000;

// Minted by the reference implementation (node:crypto HMAC) this format comes from.
const VECTORS = [
  {
    kind: "chat",
    subject: "p_7Hq2xK9mVb3",
    ttlMs: 10 * DAY,
    token:
      "eyJ2IjoxLCJzIjoicF83SHEyeEs5bVZiMyIsImUiOjE3NjgwODk2MDB9.zD4IiLGHyt4nhSBZJoUknmDMxrt0fU-ZPa0kSUdOlQQ",
  },
  {
    kind: "join",
    subject: "subject with spaces ✓",
    ttlMs: DAY / 2,
    token:
      "eyJ2IjoxLCJzIjoic3ViamVjdCB3aXRoIHNwYWNlcyDinJMiLCJlIjoxNzY3MjY4ODAwfQ.oRnj5RSWVEX_a6p2gR94Q8IUXzthhsJUYFttTImsVg4",
  },
];

async function errorOf(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("the token format", () => {
  const links = createLinks({ secret: SECRET });

  it.each(VECTORS)("mints the fixed vector for $kind byte for byte, and verifies it", async (v) => {
    expect(await links.sign({ kind: v.kind, subject: v.subject, ttlMs: v.ttlMs, now: NOW })).toBe(v.token);
    expect(await links.verify(v.token, v.kind, NOW)).toEqual({
      ok: true,
      subject: v.subject,
      expiresAt: new Date(NOW.getTime() + v.ttlMs),
    });
  });

  it("matches an HMAC-SHA256 over kind.v1.payload, as documented", async () => {
    const token = await links.sign({ kind: "chat", subject: "abc", ttlMs: DAY, now: NOW });
    const [payload, signature] = token.split(".");
    expect(createHmac("sha256", SECRET).update(`chat.v1.${payload}`).digest("base64url")).toBe(signature);
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))).toEqual({
      v: 1,
      s: "abc",
      e: (NOW.getTime() + DAY) / 1000,
    });
  });
});

describe("verify refuses", () => {
  const links = createLinks({ secret: SECRET });
  const token = VECTORS[0]!.token;

  it("a token of another kind", async () => {
    expect(await links.verify(token, "join", NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("a tampered signature or payload", async () => {
    const [payload, signature] = token.split(".") as [string, string];
    const flipped = signature.slice(0, -2) + (signature.at(-2) === "A" ? "B" : "A") + signature.at(-1);
    expect(await links.verify(`${payload}.${flipped}`, "chat", NOW)).toEqual({ ok: false, reason: "bad-signature" });
    const otherPayload = Buffer.from(JSON.stringify({ v: 1, s: "p_someoneelse", e: 1768089600 })).toString("base64url");
    expect(await links.verify(`${otherPayload}.${signature}`, "chat", NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("an expired token, at the second it expires", async () => {
    expect(await links.verify(token, "chat", new Date(NOW.getTime() + 10 * DAY - 1000))).toMatchObject({ ok: true });
    expect(await links.verify(token, "chat", new Date(NOW.getTime() + 10 * DAY))).toEqual({ ok: false, reason: "expired" });
  });

  it("a token signed with a secret it doesn't hold", async () => {
    const stranger = createLinks({ secret: OTHER });
    expect(await stranger.verify(token, "chat", NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it.each([
    ["not a string", 42],
    ["empty", ""],
    ["no dot", "abc"],
    ["two dots", "a.b.c"],
    ["a leading dot", ".abc"],
    ["a trailing dot", "abc."],
    ["not base64url", "eyJ2Ijox+.zD4I/iLG"],
    ["too long", `${"a".repeat(MAX_TOKEN_LENGTH)}.b`],
  ])("a malformed token (%s) before decoding anything", async (_label, input) => {
    expect(await links.verify(input, "chat", NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("a validly signed payload that isn't a link", async () => {
    const payload = Buffer.from(JSON.stringify({ v: 2, s: "x", e: 9_999_999_999 })).toString("base64url");
    const signature = createHmac("sha256", SECRET).update(`chat.v1.${payload}`).digest("base64url");
    expect(await links.verify(`${payload}.${signature}`, "chat", NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("rotation", () => {
  it("signs with the first secret and verifies with any", async () => {
    const old = createLinks({ secret: SECRET });
    const rotated = createLinks({ secret: [OTHER, SECRET] });
    const oldToken = await old.sign({ kind: "chat", subject: "p1", ttlMs: DAY, now: NOW });
    const newToken = await rotated.sign({ kind: "chat", subject: "p1", ttlMs: DAY, now: NOW });
    expect(newToken).not.toBe(oldToken);
    expect(await rotated.verify(oldToken, "chat", NOW)).toMatchObject({ ok: true, subject: "p1" });
    expect(await rotated.verify(newToken, "chat", NOW)).toMatchObject({ ok: true, subject: "p1" });
    expect(await old.verify(newToken, "chat", NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });
});

describe("configuration", () => {
  it.each([[""], ["short"], [["0123456789abcdef0123456789abcdef", "short"]], [[]]])(
    "refuses a missing or short secret: %j",
    async (secret) => {
      expect(isChaperoneError(await errorOf(() => createLinks({ secret })), "invalid_secret")).toBe(true);
    },
  );

  it("refuses a bad kind, subject or expiry when signing", async () => {
    const links = createLinks({ secret: SECRET });
    for (const input of [
      { kind: "Chat", subject: "p", ttlMs: DAY },
      { kind: "chat", subject: "", ttlMs: DAY },
      { kind: "chat", subject: "x".repeat(129), ttlMs: DAY },
      { kind: "chat", subject: "p" },
    ]) {
      expect(isChaperoneError(await errorOf(() => links.sign(input)), "invalid_link")).toBe(true);
    }
  });

  it("puts the token in a fragment", () => {
    expect(tokenFragment("abc.def")).toBe("#t=abc.def");
  });
});
