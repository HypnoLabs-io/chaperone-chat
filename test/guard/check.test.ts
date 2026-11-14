/**
 * The full check with a fake judge standing in for Jev (a third-party service): the order, the bands' exact edges,
 * appeals, every fallback, several policies, observe mode, and what the judge reads.
 */
import { describe, expect, it, vi } from "vitest";
import {
  check,
  contactLeak,
  definePolicy,
  FALLBACK_REASON,
  HOLD_REASON,
  KIND_REASONS,
  policyFingerprint,
  WINDOW_REASONS,
  type CheckOptions,
  type Judge,
  type JudgeResult,
  type JudgeTurn,
  type Policy,
} from "../../src/guard";
import { CORPUS } from "../fixtures/corpus";

const MODEL = "fake-1";

function calibrated(policy: Policy, block = 0.85, review = 0.5): Policy {
  return { ...policy, cutoffs: { model: MODEL, fingerprint: policyFingerprint(policy, MODEL), block, review } };
}

const CONTACT = calibrated(contactLeak());
const CIVIL = calibrated(
  definePolicy({
    id: "civil",
    question: "Is the latest message abusive?",
    counts: [{ id: "abuse", text: "Abuse." }],
    doesntCount: [{ id: "fine", text: "Anything else." }],
    reason: "Please keep it civil.",
  }),
  0.9,
  0.6,
);

/** A judge answering by policy id; what it was asked is recorded. */
function judgeOf(answers: Record<string, JudgeResult | (() => JudgeResult)>, model = MODEL) {
  const calls: { policy: string; turns: readonly JudgeTurn[] }[] = [];
  const judge: Judge = {
    model,
    judge: vi.fn(async (policy: Policy, turns: readonly JudgeTurn[]) => {
      calls.push({ policy: policy.id, turns });
      const a = answers[policy.id];
      if (!a) throw new Error("unexpected policy");
      return typeof a === "function" ? a() : a;
    }),
  };
  return { judge, calls };
}
const scoring = (p: number) => judgeOf({ contact: { ok: true, p, usage: { inputTokens: 40, outputTokens: 1 } } });
const base = (judge: Judge | null, extra: Partial<CheckOptions> = {}): CheckOptions => ({ judge, policies: [CONTACT], ...extra });

describe("the rules", () => {
  it("refuse a hit with its kind, without asking the judge", async () => {
    const { judge, calls } = scoring(0);
    expect(await check({ text: "text me at 312 555 0142" }, base(judge))).toEqual({
      action: "refuse",
      decidedBy: "rules",
      kind: "phone",
      reason: KIND_REASONS.phone,
      p: 1,
      checkedBy: "rules",
    });
    expect(calls).toEqual([]);
  });

  it("can't be appealed", async () => {
    const { judge, calls } = scoring(0);
    expect(await check({ text: "dm me", appeal: true }, base(judge))).toMatchObject({ action: "refuse", decidedBy: "rules" });
    expect(calls).toEqual([]);
  });

  it("run on the guard given", async () => {
    const { judge } = scoring(0);
    expect((await check({ text: "text me" }, base(judge, { guard: { kinds: { ask: false } } }))).action).toBe("send");
  });
});

describe("the split-message pass", () => {
  it.each(CORPUS.threads.map((t) => [t.id, t.window ?? "the judge", t] as const))("%s → %s", async (_id, _w, t) => {
    const { judge, calls } = scoring(0);
    const last = t.turns[t.turns.length - 1]!;
    const before = t.turns.slice(0, -1);
    const verdict = await check(
      {
        text: last.text,
        earlier: before.filter((x) => x.from === last.from).map((x) => x.text),
        context: before.map((x) => ({ sender: x.from === last.from, text: x.text })),
      },
      base(judge),
    );
    if (t.window) {
      expect(verdict).toMatchObject({ action: "refuse", decidedBy: "rules-window", kind: t.window, reason: WINDOW_REASONS[t.window], p: 1 });
      expect(calls).toEqual([]);
    } else {
      expect(verdict.action).toBe("send");
      expect(calls).toHaveLength(1);
    }
  });

  it("is off with window: false", async () => {
    const { judge } = scoring(0);
    const input = { text: "0142", earlier: ["it's 312", "555"] };
    expect((await check(input, base(judge))).action).toBe("refuse");
    expect((await check(input, base(judge, { window: false }))).action).toBe("send");
  });
});

describe("the bands", () => {
  it.each([
    [0.85, "refuse"],
    [0.97, "refuse"],
    [0.8499, "appealable"],
    [0.5, "appealable"],
    [0.4999, "send"],
    [0, "send"],
  ] as const)("p = %s → %s", async (p, action) => {
    const verdict = await check({ text: "I'm free Tuesdays." }, base(scoring(p).judge));
    expect(verdict).toMatchObject({ action, decidedBy: "contact", policy: "contact", p, checkedBy: "rules+fake-1", scores: { contact: p } });
    expect(verdict.reason).toBe(action === "send" ? null : CONTACT.reason);
    expect(verdict.usage).toEqual({ inputTokens: 40, outputTokens: 1 });
  });

  it("can hold instead: a block band for a moderator, a review band held or sent", async () => {
    expect(await check({ text: "Hmm." }, base(scoring(0.9).judge, { bands: { block: "hold" } }))).toMatchObject({
      action: "hold",
      holdReason: "flagged",
      reason: HOLD_REASON,
    });
    expect(await check({ text: "Hmm." }, base(scoring(0.6).judge, { bands: { review: "hold" } }))).toMatchObject({
      action: "hold",
      holdReason: "flagged",
    });
    expect((await check({ text: "Hmm." }, base(scoring(0.6).judge, { bands: { review: "send" } }))).action).toBe("send");
  });

  it("refuses the review band without an appeal when appeals are off", async () => {
    expect((await check({ text: "Hmm." }, base(scoring(0.6).judge, { appeals: false }))).action).toBe("refuse");
    expect((await check({ text: "Hmm.", appeal: true }, base(scoring(0.6).judge, { appeals: false }))).action).toBe("refuse");
  });
});

describe("what the judge reads", () => {
  it("the last 8 delivered messages, both sides, in order, the new one last and the sender's", async () => {
    const context = Array.from({ length: 12 }, (_, i) => ({ sender: i % 2 === 0, text: `m${i}` }));
    const { judge, calls } = scoring(0);
    await check({ text: "the new one", context }, base(judge));
    expect(calls[0]!.turns).toEqual([...context.slice(-8), { sender: true, text: "the new one" }]);
    await check({ text: "again", context }, base(judge, { contextTurns: 2 }));
    expect(calls[1]!.turns).toEqual([...context.slice(-2), { sender: true, text: "again" }]);
    await check({ text: "alone", context }, base(judge, { contextTurns: 0 }));
    expect(calls[2]!.turns).toEqual([{ sender: true, text: "alone" }]);
  });
});

describe("an appeal", () => {
  it("stays refused at or above block", async () => {
    expect((await check({ text: "Hmm.", appeal: true }, base(scoring(0.9).judge))).action).toBe("refuse");
  });

  it("holds the review band for review", async () => {
    expect(await check({ text: "Hmm.", appeal: true }, base(scoring(0.6).judge))).toMatchObject({
      action: "hold",
      holdReason: "appeal",
      reason: HOLD_REASON,
      p: 0.6,
      checkedBy: "rules+fake-1",
    });
  });

  it("sends when scored below review now", async () => {
    expect((await check({ text: "Hmm.", appeal: true }, base(scoring(0.2).judge))).action).toBe("send");
  });
});

describe("the fallback", () => {
  const cases: [string, Judge | null, Policy, string][] = [
    ["nothing to call (the cap, no key)", judgeOf({ contact: { ok: false, failure: "unavailable" } }).judge, CONTACT, "unavailable"],
    ["a failed call", judgeOf({ contact: { ok: false, failure: "error" } }).judge, CONTACT, "error"],
    ["a judge that throws", judgeOf({ contact: () => { throw new Error("down"); } }).judge, CONTACT, "error"],
    ["an answer that can't be trusted", judgeOf({ contact: { ok: false, failure: "invalid" } }).judge, CONTACT, "invalid"],
    ["NaN", judgeOf({ contact: { ok: true, p: Number.NaN } }).judge, CONTACT, "invalid"],
    ["above 1", judgeOf({ contact: { ok: true, p: 1.2 } }).judge, CONTACT, "invalid"],
    ["cutoffs for another model", judgeOf({ contact: { ok: true, p: 0 } }, "fake-2").judge, CONTACT, "uncalibrated"],
    ["an uncalibrated policy", judgeOf({ contact: { ok: true, p: 0 } }).judge, contactLeak({ cutoffs: null }), "uncalibrated"],
    ["cutoffs that make no sense", judgeOf({ contact: { ok: true, p: 0 } }).judge, { ...CONTACT, cutoffs: { ...CONTACT.cutoffs!, review: 0.95 } }, "invalid"],
  ];

  it.each(cases)("holds by default: %s", async (_name, judge, policy, judgeFailure) => {
    expect(await check({ text: "Tuesdays at 4?" }, { judge, policies: [policy] })).toEqual({
      action: "hold",
      decidedBy: "fallback",
      policy: "contact",
      reason: HOLD_REASON,
      checkedBy: "rules",
      holdReason: "unchecked",
      judgeFailure,
    });
  });

  it.each(cases)("sends with fallback 'send': %s", async (_name, judge, policy, judgeFailure) => {
    expect(await check({ text: "Tuesdays at 4?" }, { judge, policies: [policy], fallback: "send" })).toMatchObject({
      action: "send",
      decidedBy: "fallback",
      reason: null,
      checkedBy: "rules",
      judgeFailure,
    });
  });

  it.each(cases)("refuses with fallback 'refuse': %s", async (_name, judge, policy, judgeFailure) => {
    expect(await check({ text: "Tuesdays at 4?" }, { judge, policies: [policy], fallback: "refuse" })).toMatchObject({
      action: "refuse",
      decidedBy: "fallback",
      reason: FALLBACK_REASON,
      judgeFailure,
    });
  });

  it("never asks the judge about a policy its cutoffs don't fit", async () => {
    const { judge, calls } = judgeOf({ contact: { ok: true, p: 0 } }, "fake-2");
    await check({ text: "Tuesdays at 4?" }, { judge, policies: [CONTACT] });
    expect(calls).toEqual([]);
  });

  it("takes the fallback for the built-in policy while it is uncalibrated", async () => {
    const { judge, calls } = judgeOf({ contact: { ok: true, p: 0 } }, "jev-1.13.0");
    const builtIn = contactLeak();
    const verdict = await check({ text: "Tuesdays at 4?" }, { judge });
    if (builtIn.cutoffs === null) {
      expect(verdict).toMatchObject({ action: "hold", judgeFailure: "uncalibrated" });
      expect(calls).toEqual([]);
    } else {
      expect(verdict).toMatchObject({ action: "send", checkedBy: "rules+jev-1.13.0" });
    }
  });
});

describe("several policies", () => {
  it("asks each once, in parallel, and the most severe outcome wins", async () => {
    const { judge, calls } = judgeOf({ contact: { ok: true, p: 0.6 }, civil: { ok: true, p: 0.95 } });
    const verdict = await check({ text: "Hmm." }, { judge, policies: [CONTACT, CIVIL] });
    expect(calls.map((c) => c.policy).sort()).toEqual(["civil", "contact"]);
    expect(verdict).toMatchObject({ action: "refuse", decidedBy: "civil", reason: "Please keep it civil.", p: 0.95, scores: { contact: 0.6, civil: 0.95 } });
  });

  it("puts a judgment above a failure, and a failure's hold above sending", async () => {
    const failing = { ok: false as const, failure: "error" as const };
    expect(
      await check({ text: "Hmm." }, { judge: judgeOf({ contact: { ok: true, p: 0.6 }, civil: failing }).judge, policies: [CONTACT, CIVIL] }),
    ).toMatchObject({ action: "appealable", decidedBy: "contact", judgeFailure: "error" });
    expect(
      await check({ text: "Hmm." }, { judge: judgeOf({ contact: { ok: true, p: 0.1 }, civil: failing }).judge, policies: [CONTACT, CIVIL] }),
    ).toMatchObject({ action: "hold", decidedBy: "fallback", policy: "civil", holdReason: "unchecked", checkedBy: "rules+fake-1" });
  });

  it("sends on the rules alone with no judge, by intent", async () => {
    expect(await check({ text: "Tuesdays at 4?" }, { judge: null })).toEqual({
      action: "send",
      decidedBy: "rules",
      reason: null,
      checkedBy: "rules",
    });
  });
});

describe("observe mode", () => {
  it("delivers everything and reports what enforcing would have done", async () => {
    const rules = await check({ text: "text me" }, base(scoring(0).judge, { mode: "observe" }));
    expect(rules).toMatchObject({ action: "send", reason: null, observed: { action: "refuse", kind: "ask", reason: KIND_REASONS.ask } });
    const judged = await check({ text: "Hmm." }, base(scoring(0.6).judge, { mode: "observe" }));
    expect(judged).toMatchObject({ action: "send", p: 0.6, scores: { contact: 0.6 }, observed: { action: "appealable" } });
    expect(await check({ text: "Fine." }, base(scoring(0.1).judge, { mode: "observe" }))).not.toHaveProperty("observed");
  });
});
