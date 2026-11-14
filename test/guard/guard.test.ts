import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  block,
  combine,
  CONTACT_KINDS,
  createGuard,
  has,
  KIND_REASONS,
  scan,
  scrub,
  type Scrubber,
} from "../../src/guard";
import { cleanMessage, mixedMessage } from "../fixtures/corpus";

/** Flags the word "pineapple" as an app, with its span. Nothing else. */
const pineapple: Scrubber = {
  id: "pineapple",
  find(text) {
    const i = text.indexOf("pineapple");
    return i < 0 ? [] : [{ kind: "app", start: i, end: i + "pineapple".length }];
  },
};

describe("the default method", () => {
  it("is the rules", async () => {
    expect(createGuard().rules.id).toBe("rules");
    expect((await scan("dana@gmail.com")).scrubberId).toBe("rules");
  });

  it("has a sentence for every kind", () => {
    for (const kind of CONTACT_KINDS) expect(KIND_REASONS[kind]).toMatch(/\.$/);
  });
});

describe("block", () => {
  it("is null for a clean message", async () => {
    expect(await block("Can you do Tuesdays at 4?")).toBeNull();
    expect(await block("")).toBeNull();
  });

  it("names the most specific kind, its sentence and the method", async () => {
    expect(await block("text me at 312 555 0142")).toEqual({
      kind: "phone",
      reason: KIND_REASONS.phone,
      scrubberId: "rules",
    });
  });

  it("uses the method it is given", async () => {
    const withPineapple = createGuard({ scrubber: pineapple });
    expect(await block("I like pineapple")).toBeNull();
    expect(await block("I like pineapple", withPineapple)).toEqual({
      kind: "app",
      reason: KIND_REASONS.app,
      scrubberId: "pineapple",
    });
    expect(await has("dana@gmail.com", withPineapple)).toBe(false);
  });

  it("takes options directly, and builds them once", async () => {
    const options = { kinds: { phone: false } };
    expect(await has("312-555-0142", options)).toBe(false);
    expect(await has("312-555-0142", options)).toBe(false);
    expect(await has("312-555-0142")).toBe(true);
  });
});

describe("a method that fails falls back to the rules", () => {
  const throws: Scrubber = {
    id: "throws",
    find() {
      throw new Error("down");
    },
  };
  const rejects: Scrubber = { id: "rejects", find: async () => Promise.reject(new Error("timeout")) };
  const unknownKind: Scrubber = { id: "unknown", find: () => [{ kind: "phone_number" as never }] };
  const notAnArray: Scrubber = { id: "junk", find: () => "phone" as never };

  it.each([throws, rejects, unknownKind, notAnArray].map((m) => [m.id, m] as const))("%s", async (_id, method) => {
    const guard = createGuard({ scrubber: method });
    expect(await guard.scan("write to dana@gmail.com")).toMatchObject({ kinds: ["email"], scrubberId: "rules", fellBack: true });
    expect(await guard.block("all good here")).toBeNull();
  });

  it("falls back to the rules with the guard's own options", async () => {
    const guard = createGuard({ scrubber: { id: "throws", find: () => Promise.reject(new Error("x")) }, kinds: { email: false } });
    expect(await guard.scan("write to dana@gmail.com")).toMatchObject({ kinds: [], fellBack: true });
  });

  it("drops a span that doesn't fit, and keeps the finding", async () => {
    const guard = createGuard({ scrubber: { id: "bad-span", find: () => [{ kind: "email", start: 5, end: 500 }] } });
    expect(await guard.scan("hello")).toMatchObject({ kinds: ["email"], findings: [{ kind: "email" }], fellBack: false });
    expect(await guard.scrub("hello")).toBe("");
  });
});

describe("combine", () => {
  it("reports what any member finds", async () => {
    const guard = createGuard();
    const both = createGuard({ scrubber: combine("rules+pineapple", [guard.rules, pineapple]) });
    expect((await both.scan("pineapple, or dana@gmail.com")).kinds).toEqual(["email", "app"]);
    expect(await both.block("I like pineapple")).toMatchObject({ kind: "app", scrubberId: "rules+pineapple" });
  });

  it("fails whole when a member fails, so the rules still run", async () => {
    const broken = combine("pineapple+throws", [
      pineapple,
      {
        id: "throws",
        find() {
          throw new Error("down");
        },
      },
    ]);
    expect(await scan("pineapple", createGuard({ scrubber: broken }))).toMatchObject({
      kinds: [],
      fellBack: true,
      scrubberId: "rules",
    });
  });
});

describe("scrub", () => {
  it("cuts the sentences that hold a contact detail", async () => {
    expect(await scrub("Six years in sales. Email me at dana.k@gmail.com or text 312-555-0142 for rates.")).toBe(
      "Six years in sales.",
    );
    expect(await scrub("Weddings and portraits. Find me on Thumbtack! Booking for June.")).toBe(
      "Weddings and portraits. Booking for June.",
    );
  });

  it("blanks a field it can't cut (a finding with no span, or nothing left)", async () => {
    expect(await scrub("Portraits. three one two five five five zero one four two")).toBe("");
    expect(await scrub("dana@gmail.com")).toBe("");
  });

  it("uses the method it is given", async () => {
    expect(await scrub("Oak. I like pineapple. Ships in June.", createGuard({ scrubber: pineapple }))).toBe(
      "Oak. Ships in June.",
    );
  });

  it("returns clean text untouched", async () => {
    await fc.assert(
      fc.asyncProperty(cleanMessage, async (text) => {
        expect(await scrub(text)).toBe(text);
      }),
      { numRuns: 200 },
    );
  });

  it("is idempotent, and what it returns never trips", async () => {
    await fc.assert(
      fc.asyncProperty(mixedMessage, async (text) => {
        const once = await scrub(text);
        expect(await has(once)).toBe(false);
        expect(await scrub(once)).toBe(once);
      }),
      { numRuns: 300 },
    );
  });
});
