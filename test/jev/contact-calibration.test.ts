/**
 * The built-in contact policy's cutoffs, held to the committed scores (`corpus/contact-scores.json`): Jev's answers
 * on every sample and thread, taken with `npx chaperone-chat calibrate`. A change to the question, its lines, the
 * state's shape, the corpus or the cutoffs fails here until it is calibrated again.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTACT_CUTOFFS, CONTACT_SCOPES, contactLeak, policyFingerprint } from "../../src/guard";
import { bandMisses, DEFAULT_JEV_MODEL } from "../../src/jev";
import { calibrationItems, type ScoresFile } from "../../src/jev/calibrate";
import { CORPUS } from "../fixtures/corpus";

const SCORES: ScoresFile = JSON.parse(readFileSync(new URL("../../corpus/contact-scores.json", import.meta.url), "utf8"));

/** Contact details the rules miss that Jev scores under review: what gets through. Listed, or the cutoffs move. */
const KNOWN_MISSES: Record<(typeof CONTACT_SCOPES)[number], string[]> = {
  // A username with nothing around it: no @, no app, no label.
  "off-platform": ["hd-16"],
  "details-only": ["hd-16"],
};

describe.each(CONTACT_SCOPES)("the %s cutoffs", (scope) => {
  const policy = contactLeak({ scope });
  const cutoffs = CONTACT_CUTOFFS[scope]!;
  const entry = SCORES[cutoffs.fingerprint]!;
  const items = calibrationItems(CORPUS, policy).map((i) => ({ ...i, p: entry.scores[i.id] as number }));
  const judged = items.filter((i) => i.reachesJudge);
  const clean = judged.filter((i) => !i.positive);
  const misses = bandMisses(items, cutoffs);

  it("belong to this question, state shape and model, with a score for every sample", () => {
    expect(cutoffs).toMatchObject({ model: DEFAULT_JEV_MODEL, fingerprint: policyFingerprint(policy, DEFAULT_JEV_MODEL) });
    expect(entry).toMatchObject({ policy: "contact", label: scope, model: DEFAULT_JEV_MODEL, shape: 1 });
    for (const i of items) expect(entry.scores[i.id], i.id).toBeTypeOf("number");
  });

  it("refuse no clean message outright", () => {
    expect(misses.cleanBlocked.map((i) => i.id)).toEqual([]);
  });

  it("let no contact detail through but the known misses", () => {
    expect(misses.positiveSent.map((i) => i.id).sort()).toEqual(KNOWN_MISSES[scope]);
  });

  it("put at most a tenth of the clean messages in the appeal band", () => {
    expect(misses.cleanAppeal.length / clean.length).toBeLessThanOrEqual(0.1);
  });

  it("keep a margin on both sides", () => {
    const maxClean = Math.max(...clean.map((i) => i.p));
    const caught = judged.filter((i) => i.positive && !KNOWN_MISSES[scope].includes(i.id));
    expect(cutoffs.block - maxClean).toBeGreaterThanOrEqual(0.03);
    expect(Math.min(...caught.map((i) => i.p)) - cutoffs.review).toBeGreaterThanOrEqual(0.03);
  });
});
