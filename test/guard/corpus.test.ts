import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createGuard, createRules, kindsOf } from "../../src/guard";
import { ALLOWED_LINES, contactLines, DETAIL_LINES, MOVE_LINES, scopeKinds } from "../../src/guard/policies/contact-lines";
import { CLEAN, cleanMessage, CORPUS, isContact } from "../fixtures/corpus";

const rules = createRules();
const DOMAINS = ["any", "marketplace", "dating", "recruiting", "rentals", "support"];

describe("the corpus", () => {
  it("holds at least 450 single messages and 30 threads", () => {
    expect(CORPUS.samples.length).toBeGreaterThanOrEqual(450);
    expect(CORPUS.threads.length).toBeGreaterThanOrEqual(30);
  });

  it("has unique ids across samples and threads, in the line's prefix", () => {
    const ids = [...CORPUS.samples, ...CORPUS.threads].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]{2}-\d{2,3}$/);
  });

  it("cites every line of the definition, and only those", () => {
    const lines = new Set([...DETAIL_LINES, ...MOVE_LINES, ...ALLOWED_LINES].map((l) => l.id));
    const cited = new Set([...CORPUS.samples, ...CORPUS.threads].map((s) => s.cites));
    expect([...cited].sort()).toEqual([...lines].sort());
  });

  it("spans marketplace, dating, recruiting, rentals and peer support", () => {
    const counts = new Map<string, number>();
    for (const s of CORPUS.samples) counts.set(s.domain, (counts.get(s.domain) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual([...DOMAINS].sort());
    for (const domain of DOMAINS.filter((d) => d !== "any")) expect(counts.get(domain)).toBeGreaterThanOrEqual(40);
  });

  it("holds no duplicate text", () => {
    const texts = CORPUS.samples.map((s) => s.text.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("gives Jev contact details to catch under both scopes", () => {
    const offPlatformMisses = CORPUS.samples.filter((s) => isContact(s) && s.rules.length === 0);
    expect(offPlatformMisses.length).toBeGreaterThanOrEqual(40);
    const detailKinds = new Set(["email", "phone", "link", "handle", "address"]);
    const detailsOnlyMisses = CORPUS.samples.filter(
      (s) => isContact(s, "details-only") && !s.rules.some((k) => detailKinds.has(k)),
    );
    expect(detailsOnlyMisses.length).toBeGreaterThanOrEqual(25);
    expect(CORPUS.threads.filter((t) => isContact(t) && !t.window).length).toBeGreaterThanOrEqual(8);
  });

  it("never cites a moving line for a message whose detail the rules find", () => {
    // Under details-only the moving lines stop counting; a message holding an actual detail must cite its detail line.
    const moving = new Set(MOVE_LINES.map((l) => l.id));
    const detailKinds = new Set(["email", "phone", "link", "handle", "address"]);
    const wrong = CORPUS.samples.filter((s) => moving.has(s.cites) && s.rules.some((k) => detailKinds.has(k)));
    expect(wrong.map((s) => s.id)).toEqual([]);
  });

  it("has clean samples that end their own sentence, so any mix of them stays clean", () => {
    for (const text of CLEAN) expect(text).toMatch(/[.!?]$/);
    fc.assert(
      fc.property(cleanMessage, (text) => {
        expect(rules.find(text)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

describe("the rules on every sample", () => {
  it.each(CORPUS.samples.map((s) => [s.id, s.text, s.rules.join(",") || "nothing", s] as const))(
    "%s %j → %s",
    (_id, text, _label, sample) => {
      expect(kindsOf(rules.find(text))).toEqual(sample.rules);
    },
  );
});

describe("the details-only scope", () => {
  const detailsOnly = createRules({ kinds: scopeKinds("details-only") });

  it("drops only the app and ask kinds from every pinned answer", () => {
    for (const s of CORPUS.samples) {
      expect(kindsOf(detailsOnly.find(s.text))).toEqual(s.rules.filter((k) => k !== "app" && k !== "ask"));
    }
  });

  it("moves exactly the four moving lines", () => {
    const off = contactLines("off-platform");
    const details = contactLines("details-only");
    expect(off.counts.map((l) => l.id)).toEqual([...DETAIL_LINES, ...MOVE_LINES].map((l) => l.id));
    expect(details.counts.map((l) => l.id)).toEqual(DETAIL_LINES.map((l) => l.id));
    expect(details.doesntCount.map((l) => l.id)).toEqual([...MOVE_LINES, ...ALLOWED_LINES].map((l) => l.id));
  });
});

describe("the split-message pass on every thread", () => {
  const guard = createGuard();

  it.each(CORPUS.threads.map((t) => [t.id, t] as const))("%s: every message passes the rules alone", (_id, t) => {
    for (const turn of t.turns) expect(rules.find(turn.text)).toEqual([]);
  });

  it.each(CORPUS.threads.map((t) => [t.id, t.window ?? "nothing", t] as const))("%s → %s", (_id, _label, t) => {
    const last = t.turns[t.turns.length - 1]!;
    const earlier = t.turns
      .slice(0, -1)
      .filter((turn) => turn.from === last.from)
      .map((turn) => turn.text);
    expect(guard.windowKinds(earlier, last.text)[0] ?? null).toBe(t.window);
  });
});
