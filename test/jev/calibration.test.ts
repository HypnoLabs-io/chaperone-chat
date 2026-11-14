import { describe, expect, it } from "vitest";
import { contactLeak } from "../../src/guard";
import { bandMisses, reliabilityTable, suggestCutoffs, type ScoredItem } from "../../src/jev";
import { calibrationItems } from "../../src/jev/calibrate";
import { CORPUS, isContact } from "../fixtures/corpus";

const item = (id: string, positive: boolean, p: number, reachesJudge = true): ScoredItem => ({ id, positive, p, reachesJudge });

describe("reliabilityTable", () => {
  it("counts items and positives per tenth, the last tenth holding 1", () => {
    const rows = reliabilityTable([item("a", false, 0), item("b", true, 0.95), item("c", true, 1), item("d", false, 0.1)]);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual({ from: 0, to: 0.1, count: 1, positive: 0 });
    expect(rows[1]).toMatchObject({ count: 1, positive: 0 });
    expect(rows[9]).toMatchObject({ from: 0.9, to: 1, count: 2, positive: 2 });
  });
});

describe("bandMisses", () => {
  it("reads only what reaches the judge", () => {
    const items = [item("c1", false, 0.9), item("c2", false, 0.6), item("p1", true, 0.2), item("p2", true, 0.1, false)];
    expect(bandMisses(items, { block: 0.8, review: 0.5 })).toEqual({
      cleanBlocked: [items[0]],
      cleanAppeal: [items[1]],
      positiveSent: [items[2]],
    });
  });
});

describe("suggestCutoffs", () => {
  it("puts block just above every clean score and review at the lowest positive miss", () => {
    const items = [item("c1", false, 0.1), item("c2", false, 0.38), item("p1", true, 0.4), item("p2", true, 0.9)];
    expect(suggestCutoffs(items)).toEqual({ block: 0.39, review: 0.39, appealShare: 0, knownMisses: [], overlap: 0 });
  });

  it("raises review until the appeal band holds at most a tenth of the clean items", () => {
    const clean = Array.from({ length: 10 }, (_, i) => item(`c${i}`, false, 0.05 + i * 0.03));
    const items = [...clean, item("p1", true, 0.06), item("p2", true, 0.9)];
    const s = suggestCutoffs(items);
    expect(s.block).toBe(0.33);
    expect(s.appealShare).toBeLessThanOrEqual(0.1);
    expect(s.knownMisses).toEqual(["p1"]);
    // Nine clean items score at or above the lowest positive miss (0.06); 0.05 doesn't.
    expect(s.overlap).toBe(9);
    expect(s.review).toBe(0.3);
  });

  it("ignores what the rules catch: with no clean item reaching Jev, block sits at the top", () => {
    expect(suggestCutoffs([item("c", false, 0.95, false), item("p", true, 0.2)])).toMatchObject({ block: 1, review: 0.2 });
  });
});

describe("calibrationItems from the corpus", () => {
  const off = calibrationItems(CORPUS, contactLeak());
  const details = calibrationItems(CORPUS, contactLeak({ scope: "details-only" }));

  it("reads every sample and thread once", () => {
    expect(off).toHaveLength(CORPUS.samples.length + CORPUS.threads.length);
  });

  it("labels each by the line it cites, under each scope", () => {
    for (const s of CORPUS.samples) {
      expect(off.find((i) => i.id === s.id)!.positive).toBe(isContact(s));
      expect(details.find((i) => i.id === s.id)!.positive).toBe(isContact(s, "details-only"));
    }
  });

  it("sends Jev what the rules pass, by the scope's rules", () => {
    for (const s of CORPUS.samples) {
      expect(off.find((i) => i.id === s.id)!.reachesJudge).toBe(s.rules.length === 0);
      const detailKinds = s.rules.filter((k) => k !== "app" && k !== "ask");
      expect(details.find((i) => i.id === s.id)!.reachesJudge).toBe(detailKinds.length === 0);
    }
    for (const t of CORPUS.threads) expect(off.find((i) => i.id === t.id)!.reachesJudge).toBe(t.window === null);
  });

  it("reads a thread from its last sender's side, the last nine turns", () => {
    const t = CORPUS.threads.find((x) => x.turns.length > 1 && new Set(x.turns.map((y) => y.from)).size > 1)!;
    const read = off.find((i) => i.id === t.id)!;
    const last = t.turns[t.turns.length - 1]!;
    expect(read.turns).toEqual(t.turns.slice(-9).map((x) => ({ sender: x.from === last.from, text: x.text })));
  });

  it("refuses a sample with no label and an unknown line", () => {
    expect(() => calibrationItems({ samples: [{ id: "x", text: "hi" }] }, contactLeak())).toThrow(/positive/);
    expect(() => calibrationItems({ samples: [{ id: "x", text: "hi", cites: "nope" }] }, contactLeak())).toThrow(/positive/);
  });
});
