import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_LINES,
  calibrationOf,
  CONTACT_CUTOFFS,
  CONTACT_QUESTIONS,
  contactLeak,
  definePolicy,
  DETAIL_LINES,
  isChaperoneError,
  jevJudge,
  jevQuestionOf,
  jevState,
  MOVE_LINES,
  platformSwapper,
  policyFingerprint,
  type Policy,
} from "../../src/guard";
import { createJevClient, DEFAULT_JEV_MODEL } from "../../src/jev";

const MODEL = DEFAULT_JEV_MODEL;

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

const harassment = () =>
  definePolicy({
    id: "harassment",
    question: "Does the latest message insult or threaten the other person?",
    counts: [{ id: "insult", text: "An insult or a slur." }],
    doesntCount: [{ id: "disagree", text: "Disagreeing politely." }],
    reason: "Please keep it civil.",
  });

describe("contactLeak", () => {
  it("off-platform counts contact details and moving elsewhere, and keeps every rule kind", () => {
    const p = contactLeak();
    expect(p.id).toBe("contact");
    expect(p.question).toBe(CONTACT_QUESTIONS["off-platform"]);
    expect(p.counts.map((l) => l.id)).toEqual([...DETAIL_LINES, ...MOVE_LINES].map((l) => l.id));
    expect(p.doesntCount.map((l) => l.id)).toEqual(ALLOWED_LINES.map((l) => l.id));
    expect(p.ruleKinds).toEqual({});
    expect(p.question).toMatch(/this platform/);
  });

  it("details-only counts actual details only, and turns the app and ask kinds off", () => {
    const p = contactLeak({ scope: "details-only" });
    expect(p.counts.map((l) => l.id)).toEqual(DETAIL_LINES.map((l) => l.id));
    expect(p.doesntCount.map((l) => l.id)).toEqual([...MOVE_LINES, ...ALLOWED_LINES].map((l) => l.id));
    expect(p.ruleKinds).toEqual({ app: false, ask: false });
    expect(policyFingerprint(p, MODEL)).not.toBe(policyFingerprint(contactLeak(), MODEL));
  });

  it("carries the measured cutoffs for each scope it ships, with the fingerprint they were measured under", () => {
    for (const scope of ["off-platform", "details-only"] as const) {
      const measured = CONTACT_CUTOFFS[scope];
      const p = contactLeak({ scope });
      expect(p.cutoffs).toEqual(measured ?? null);
      if (measured) {
        // A change to the question or its lines without calibrating again fails here.
        expect(measured.fingerprint).toBe(policyFingerprint(p, MODEL));
        expect(calibrationOf(p, MODEL)).toBe("calibrated");
      } else {
        expect(calibrationOf(p, MODEL)).toBe("uncalibrated");
      }
    }
  });

  it("takes a reason and cutoffs of its own", () => {
    const p = contactLeak({ reason: "Keep it here, please.", cutoffs: null });
    expect(p.reason).toBe("Keep it here, please.");
    expect(p.cutoffs).toBeNull();
  });
});

describe("definePolicy", () => {
  it("makes a policy of your own, uncalibrated until given cutoffs", () => {
    const p = harassment();
    expect(p).toMatchObject({ id: "harassment", cutoffs: null, reason: "Please keep it civil." });
    expect(calibrationOf(p, MODEL)).toBe("uncalibrated");
    const cutoffs = { model: MODEL, fingerprint: policyFingerprint(p, MODEL), block: 0.8, review: 0.5 };
    expect(calibrationOf({ ...p, cutoffs }, MODEL)).toBe("calibrated");
  });

  it("reads as uncalibrated for another model or a changed question, and invalid for cutoffs that make no sense", () => {
    const p = harassment();
    const cutoffs = { model: MODEL, fingerprint: policyFingerprint(p, MODEL), block: 0.8, review: 0.5 };
    expect(calibrationOf({ ...p, cutoffs }, "jev-2.0.0")).toBe("uncalibrated");
    expect(calibrationOf({ ...p, question: `${p.question} Or both?`, cutoffs }, MODEL)).toBe("uncalibrated");
    expect(calibrationOf({ ...p, cutoffs: { ...cutoffs, review: 0.9 } }, MODEL)).toBe("invalid");
    expect(calibrationOf({ ...p, cutoffs: { ...cutoffs, block: 1.2, review: 0.5 } }, MODEL)).toBe("invalid");
  });

  it.each([
    [{ id: "Bad Id" }],
    [{ question: " " }],
    [{ reason: "" }],
    [{ counts: [] }],
    [{ doesntCount: [{ id: "insult", text: "dup" }] }],
  ])("refuses %j", (change) => {
    const input = {
      id: "harassment",
      question: "Q?",
      counts: [{ id: "insult", text: "An insult." }],
      doesntCount: [{ id: "ok", text: "Fine." }],
      reason: "No.",
      ...change,
    };
    expect(isChaperoneError(errorOf(() => definePolicy(input as never)), "invalid_option")).toBe(true);
  });

  it("asks Jev the question with its two lists as criteria", () => {
    expect(jevQuestionOf(harassment())).toEqual({
      type: "noul",
      instructions: "Does the latest message insult or threaten the other person?",
      criteria: { true: "- An insult or a slur.", false: "- Disagreeing politely." },
    });
  });
});

describe("what Jev is sent", () => {
  it("labels turns sender and other, the latest from the sender, and nothing else", () => {
    expect(
      jevState([
        { sender: false, text: "Is the bike still for sale?" },
        { sender: true, text: "Yes!" },
      ]),
    ).toEqual({
      conversation: [
        { from: "other", text: "Is the bike still for sale?" },
        { from: "sender", text: "Yes!" },
      ],
      latest_from: "sender",
    });
  });

  it("replaces the host's own names with 'this platform', whole words, any case", () => {
    const swap = platformSwapper(["Acme Market", "Acme"]);
    expect(swap("Let's keep it on acme  market, not off Acme. Acmeville is fine.")).toBe(
      "Let's keep it on this platform, not off this platform. Acmeville is fine.",
    );
    expect(platformSwapper()("Acme")).toBe("Acme");
  });

  it("is exactly that, one request per policy, from jevJudge over the client", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = Object.keys(body.questions)[0];
      return new Response(JSON.stringify({ model: MODEL, answers: { [name]: { type: "noul", noul: 0.42 } }, usage: { input_tokens: 9, output_tokens: 1 } }));
    });
    const judge = jevJudge(createJevClient({ apiKey: "k", fetch: fetchMock as typeof fetch }), { platformNames: ["Acme"] });
    const policy = contactLeak();
    const result = await judge.judge(policy, [
      { sender: false, text: "Hi, I'm Sam from Acme support." },
      { sender: true, text: "Can we talk off Acme?" },
    ]);
    expect(result).toEqual({ ok: true, p: 0.42, usage: { inputTokens: 9, outputTokens: 1 } });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body).toEqual({
      model: MODEL,
      state: {
        conversation: [
          { from: "other", text: "Hi, I'm Sam from this platform support." },
          { from: "sender", text: "Can we talk off this platform?" },
        ],
        latest_from: "sender",
      },
      questions: { contact: jevQuestionOf(policy) },
    });
  });

  it.each([
    ["no key", () => new Response(""), "", "unavailable"],
    ["a server error", () => new Response("", { status: 500 }), "k", "error"],
    ["nonsense", () => new Response(JSON.stringify({ model: MODEL, answers: {} })), "k", "invalid"],
    ["another model", () => new Response(JSON.stringify({ model: "jev-9", answers: { contact: { type: "noul", noul: 0.1 } } })), "k", "invalid"],
  ])("turns %s into a failure, never a throw", async (_label, reply, key, failure) => {
    const judge = jevJudge(createJevClient({ apiKey: key, fetch: (async () => reply()) as typeof fetch }));
    expect(await judge.judge(contactLeak() as Policy, [{ sender: true, text: "hi" }])).toEqual({ ok: false, failure });
  });
});
