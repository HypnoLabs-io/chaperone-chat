/**
 * The engine with Jev: TypeSafe's network is mocked at `fetch`; the client, the judge, the check, the cap and the store
 * run for real. A message's score is set by its text.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createChat, EVENT, memoryStore, type Chat, type ChatConfig, type Store } from "../../src";
import { contactLeak, policyFingerprint, type Policy } from "../../src/guard";
import { DEFAULT_JEV_MODEL } from "../../src/jev";

const SECRET = "test-secret-0123456789-0123456789";
const DAY = 86_400_000;
const CONTACT: Policy = calibrated(contactLeak());

function calibrated(policy: Policy, block = 0.8, review = 0.5): Policy {
  return {
    ...policy,
    cutoffs: { model: DEFAULT_JEV_MODEL, fingerprint: policyFingerprint(policy, DEFAULT_JEV_MODEL), block, review },
  };
}

let now: number;
let store: Store;
let events: { type: string; participantId?: string | null; meta?: unknown; id: string }[];
let requests: { state: { conversation: { from: string; text: string }[]; latest_from: string }; questions: Record<string, unknown> }[];
/** Scores by the judged message's text; anything else scores 0.05. A thrown string fails the call. */
let scores: Record<string, number | "fail">;

/** Jev's network, answered from `scores`. */
async function fakeJev(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body));
  requests.push(body);
  const latest = body.state.conversation.at(-1).text as string;
  const score = scores[latest] ?? 0.05;
  if (score === "fail") return new Response("", { status: 500 });
  const answers = Object.fromEntries(Object.keys(body.questions).map((name) => [name, { type: "noul", noul: score }]));
  return new Response(JSON.stringify({ model: DEFAULT_JEV_MODEL, answers, usage: { input_tokens: 120, output_tokens: 1 } }));
}

beforeEach(() => {
  now = new Date("2026-03-01T12:00:00.000Z").getTime();
  const inner = memoryStore({ clock: () => new Date(now) });
  events = [];
  requests = [];
  scores = {};
  store = {
    ...inner,
    async appendEvent(e) {
      events.push(e as never);
      return inner.appendEvent(e);
    },
    async claimEventUnderCap(e, cap) {
      const ok = await inner.claimEventUnderCap(e, cap);
      if (ok) events.push(e as never);
      return ok;
    },
  };
});

function chatWith(extra: Partial<ChatConfig> = {}): Chat {
  return createChat({
    secret: SECRET,
    store,
    jev: { apiKey: "test-key", fetch: fakeJev as typeof fetch },
    policies: [CONTACT],
    ...extra,
  });
}

async function pair(chat: Chat) {
  const opened = await chat.open({ participants: [{ role: "buyer", alias: "Buyer" }, { role: "seller", alias: "Seller" }] });
  return { a: opened.links[0]!.participantId, b: opened.links[1]!.participantId };
}

describe("send, with Jev", () => {
  it("delivers what Jev scores low, recording the call's score and never the text", async () => {
    const chat = chatWith();
    const { a, b } = await pair(chat);
    const sent = await chat.send(a, "Is the bike still for sale?");
    expect(sent).toMatchObject({ ok: true, held: false });
    expect((await chat.load(b))!.messages.map((m) => m.body)).toEqual(["Is the bike still for sale?"]);
    const call = events.find((e) => e.type === EVENT.jevCall)!;
    expect(call).toMatchObject({ participantId: a, meta: { policy: "contact" } });
    expect(await store.judgeHealth({ type: EVENT.jevCall, windowMs: DAY, streak: 1, settleMs: -1 })).toEqual({ calls: 1, recent: 1, failed: 0 });
    expect(events.at(-1)).toMatchObject({ type: EVENT.messageSent, meta: { checkedBy: "rules+jev-1.13.0", p: 0.05 } });
    expect(JSON.stringify(events)).not.toContain("bike");
  });

  it("refuses what Jev scores at block, and stores nothing", async () => {
    const chat = chatWith();
    const { a, b } = await pair(chat);
    scores["Find me where the birds tweet, same name"] = 0.93;
    expect(await chat.send(a, "Find me where the birds tweet, same name")).toEqual({
      ok: false,
      reason: "blocked",
      message: CONTACT.reason,
      appealable: false,
    });
    expect((await chat.load(b))!.messages).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: EVENT.messageBlocked, meta: { action: "refuse", decidedBy: "contact", p: 0.93 } });
  });

  it("lets the sender appeal the review band: held for review, shown only to them", async () => {
    const chat = chatWith();
    const { a, b } = await pair(chat);
    scores["We could chat on the green app?"] = 0.6;
    expect(await chat.send(a, "We could chat on the green app?")).toMatchObject({ ok: false, reason: "blocked", appealable: true });
    const appealed = await chat.send(a, "We could chat on the green app?", { appeal: true });
    expect(appealed).toMatchObject({ ok: true, held: true, message: { status: "held", note: "Waiting for a quick check before it's sent." } });
    expect((await chat.load(a))!.messages.map((m) => m.status)).toEqual(["held"]);
    expect((await chat.load(b))!.messages).toEqual([]);
    const [held] = await store.listHeld({ limit: 10 });
    expect(held).toMatchObject({ holdReason: "appeal", policy: "contact", score: expect.closeTo(0.6, 5) });
  });

  it("holds a message when Jev fails, by the default fallback", async () => {
    const chat = chatWith();
    const { a } = await pair(chat);
    scores["Tuesday works."] = "fail";
    expect(await chat.send(a, "Tuesday works.")).toMatchObject({ ok: true, held: true });
    expect(events.at(-1)).toMatchObject({ type: EVENT.messageHeld, meta: { decidedBy: "fallback", judgeFailure: "error", checkedBy: "rules" } });
    expect((await store.listHeld({ holdReason: "unchecked", limit: 10 })).map((m) => m.body)).toEqual(["Tuesday works."]);
  });

  it("records a spent cap as unavailable, not an error, and calls nothing", async () => {
    const chat = chatWith({ jev: { apiKey: "test-key", fetch: fakeJev as typeof fetch, dailyCap: 1 } });
    const { a } = await pair(chat);
    expect(await chat.send(a, "First.")).toMatchObject({ ok: true, held: false });
    expect(await chat.send(a, "Second.")).toMatchObject({ ok: true, held: true });
    expect(requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: EVENT.messageHeld, meta: { judgeFailure: "unavailable" } });
    now += DAY;
    expect(await chat.send(a, "Third, a day later.")).toMatchObject({ ok: true, held: false });
  });

  it("sends on the rules alone past a failure with fallback 'send', tagged as rules-checked", async () => {
    const chat = chatWith({ fallback: "send" });
    const { a } = await pair(chat);
    scores["Tuesday works."] = "fail";
    expect(await chat.send(a, "Tuesday works.")).toMatchObject({ ok: true, held: false, message: { status: "sent" } });
  });

  it("never calls Jev for a rules hit", async () => {
    const chat = chatWith();
    const { a } = await pair(chat);
    expect(await chat.send(a, "text me at 312 555 0142")).toMatchObject({ reason: "blocked", kind: "phone" });
    expect(requests).toEqual([]);
  });

  it("holds every message while the built-in policy is uncalibrated, asking Jev nothing", async () => {
    const builtIn = contactLeak();
    const chat = chatWith({ policies: undefined });
    const { a } = await pair(chat);
    const result = await chat.send(a, "Tuesday works.");
    if (builtIn.cutoffs === null) {
      expect(result).toMatchObject({ ok: true, held: true });
      expect(events.at(-1)).toMatchObject({ meta: { judgeFailure: "uncalibrated" } });
      expect(requests).toEqual([]);
    } else {
      expect(result).toMatchObject({ ok: true, held: false });
    }
  });
});

describe("what Jev reads", () => {
  it("the last few delivered messages as sender and other, the host's names as 'this platform', no ids or aliases", async () => {
    const chat = chatWith({ contextTurns: 3, rules: { platformNames: ["Acme"] } });
    const { a, b } = await pair(chat);
    for (const [who, text] of [
      [a, "one"],
      [b, "two"],
      [a, "three"],
      [b, "Welcome to Acme!"],
    ] as const) {
      await chat.send(who, text);
      now += 1000;
    }
    await chat.send(a, "Thanks, Acme is nice.");
    const last = requests.at(-1)!;
    expect(last.state).toEqual({
      conversation: [
        { from: "other", text: "two" },
        { from: "sender", text: "three" },
        { from: "other", text: "Welcome to this platform!" },
        { from: "sender", text: "Thanks, this platform is nice." },
      ],
      latest_from: "sender",
    });
    expect(Object.keys(last.questions)).toEqual(["contact"]);
    expect(JSON.stringify(requests)).not.toMatch(/Buyer|Seller|buyer|seller|p_[\w-]{10}/);
  });

  it("one request per policy", async () => {
    const civil = calibrated({ ...contactLeak(), id: "civil", question: "Is it abusive?" });
    const chat = chatWith({ policies: [CONTACT, civil] });
    const { a } = await pair(chat);
    await chat.send(a, "Hello there.");
    expect(requests.map((r) => Object.keys(r.questions))).toEqual([["contact"], ["civil"]]);
  });
});

describe("observe mode", () => {
  it("delivers everything and records what enforcing would have stopped", async () => {
    const chat = chatWith({ mode: "observe" });
    const { a, b } = await pair(chat);
    expect(await chat.send(a, "text me at 312 555 0142")).toMatchObject({ ok: true, held: false });
    expect((await chat.load(b))!.messages.map((m) => m.body)).toEqual(["text me at 312 555 0142"]);
    expect(events.at(-1)).toMatchObject({ type: EVENT.messageObserved, meta: { action: "refuse", kind: "phone", observed: true } });
  });
});

describe("the details-only scope", () => {
  it("lets the rules pass asks and app names, and sends them to Jev", async () => {
    const chat = chatWith({ policies: [calibrated(contactLeak({ scope: "details-only" }))] });
    const { a } = await pair(chat);
    expect(await chat.send(a, "text me")).toMatchObject({ ok: true });
    expect(requests).toHaveLength(1);
    expect(await chat.send(a, "dana@gmail.com")).toMatchObject({ reason: "blocked", kind: "email" });
  });
});
