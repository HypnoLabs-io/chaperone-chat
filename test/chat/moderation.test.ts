/**
 * Moderation and held messages. Jev's network is mocked at `fetch` where a test needs it to fail or answer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createChat, EVENT, memoryStore, type Chat, type ChatConfig, type ChatEvent, type Store } from "../../src";
import { contactLeak, policyFingerprint, type Policy } from "../../src/guard";
import { DEFAULT_JEV_MODEL } from "../../src/jev";

const SECRET = "test-secret-0123456789-0123456789";
const CONTACT: Policy = (() => {
  const p = contactLeak();
  return { ...p, cutoffs: { model: DEFAULT_JEV_MODEL, fingerprint: policyFingerprint(p, DEFAULT_JEV_MODEL), block: 0.8, review: 0.5 } };
})();

let now: number;
let store: Store;
let events: ChatEvent[];
/** Jev answers this for every message; "down" fails the call. */
let jev: number | "down";

async function fakeJev(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (jev === "down") return new Response("", { status: 503 });
  const body = JSON.parse(String(init?.body));
  const answers = Object.fromEntries(Object.keys(body.questions).map((name) => [name, { type: "noul", noul: jev }]));
  return new Response(JSON.stringify({ model: DEFAULT_JEV_MODEL, answers }));
}

beforeEach(() => {
  now = new Date("2026-03-01T12:00:00.000Z").getTime();
  store = memoryStore({ clock: () => new Date(now) });
  events = [];
  jev = 0.05;
});

function chatWith(extra: Partial<ChatConfig> = {}): Chat {
  return createChat({
    secret: SECRET,
    store,
    jev: { apiKey: "k", fetch: fakeJev as typeof fetch },
    policies: [CONTACT],
    hooks: { onEvent: (e) => void events.push(e) },
    ...extra,
  });
}

async function pair(chat: Chat) {
  const opened = await chat.open({
    participants: [
      { role: "buyer", alias: "Buyer", externalRef: "u-buyer" },
      { role: "seller", alias: "Seller", externalRef: "u-seller" },
    ],
    context: { order: 7 },
  });
  return { cid: opened.conversation.id, a: opened.links[0]!.participantId, b: opened.links[1]!.participantId };
}

/** A message held because Jev couldn't answer. */
async function heldWhileDown(chat: Chat, from: string, text: string) {
  jev = "down";
  const sent = await chat.send(from, text);
  jev = 0.05;
  if (!sent.ok || !sent.held) throw new Error("not held");
  return sent.message.id;
}

describe("the held queue", () => {
  it("lists held messages oldest first, with who wrote them, for a moderator", async () => {
    const chat = chatWith();
    const { cid, a, b } = await pair(chat);
    const first = await heldWhileDown(chat, a, "First, held.");
    now += 1000;
    jev = 0.6;
    await chat.send(b, "Appealed one.");
    await chat.send(b, "Appealed one.", { appeal: true });
    expect(await chat.moderation.listHeld()).toEqual([
      expect.objectContaining({ id: first, conversationId: cid, from: a, alias: "Buyer", role: "buyer", externalRef: "u-buyer", body: "First, held.", status: "held", holdReason: "unchecked" }),
      expect.objectContaining({ from: b, body: "Appealed one.", holdReason: "appeal", score: expect.closeTo(0.6, 5) }),
    ]);
    expect((await chat.moderation.listHeld({ holdReason: "appeal" })).map((m) => m.body)).toEqual(["Appealed one."]);
  });
});

describe("approve", () => {
  it("delivers a held message at the end of the thread, where it arrives, once", async () => {
    const chat = chatWith();
    const { a, b } = await pair(chat);
    const held = await heldWhileDown(chat, a, "Held first.");
    now += 1000;
    await chat.send(b, "Then this one.");
    now += 1000;
    const approved = await chat.moderation.approve(held);
    expect(approved).toMatchObject({ ok: true, message: { id: held, status: "sent", holdReason: null, sentAt: new Date(now).toISOString() } });
    expect((await chat.load(b))!.messages.map((m) => m.body)).toEqual(["Then this one.", "Held first."]);
    expect(await chat.moderation.approve(held)).toEqual({ ok: false, reason: "not_held" });
    expect(await chat.moderation.approve("m_none")).toEqual({ ok: false, reason: "not_found" });
    expect(events.at(-1)).toMatchObject({ type: EVENT.messageApproved, meta: { messageId: held, holdReason: "unchecked" } });
  });

  it("won't deliver into a conversation that has closed", async () => {
    const chat = chatWith();
    const { a, b } = await pair(chat);
    const held = await heldWhileDown(chat, a, "Late.");
    await chat.resolve(b, "end");
    expect(await chat.moderation.approve(held)).toEqual({ ok: false, reason: "closed" });
  });
});

describe("refuse", () => {
  it("keeps a held message from ever being delivered, clears it, and tells its sender", async () => {
    const chat = chatWith();
    const { a, b } = await pair(chat);
    const held = await heldWhileDown(chat, a, "Not this one.");
    expect(await chat.moderation.refuse(held)).toMatchObject({ ok: true, message: { status: "refused", body: null } });
    expect((await chat.load(a))!.messages).toEqual([
      expect.objectContaining({ id: held, mine: true, status: "refused", body: null, note: "Not sent: a moderator stopped it." }),
    ]);
    expect((await chat.load(b))!.messages).toEqual([]);
    expect(await chat.moderation.refuse(held)).toEqual({ ok: false, reason: "not_held" });
  });
});

describe("hide", () => {
  it("takes a delivered message off the other side's open screen at their next poll", async () => {
    const chat = chatWith();
    const { a, b } = await pair(chat);
    const sent = await chat.send(a, "Something to take back.");
    const open = await chat.load(b);
    expect(open!.messages.map((m) => m.body)).toEqual(["Something to take back."]);
    now += 10_000;
    expect(await chat.moderation.hide(sent.ok ? sent.message.id : "")).toMatchObject({ ok: true, message: { status: "hidden" } });
    const next = await chat.load(b, { since: open!.cursor });
    expect(next!.removed).toEqual([sent.ok && sent.message.id]);
    expect(next!.messages).toEqual([]);
    expect((await chat.load(b))!.messages).toEqual([]);
    expect((await chat.load(a))!.messages).toEqual([
      expect.objectContaining({ mine: true, status: "hidden", body: null, note: "Removed by a moderator." }),
    ]);
    expect(await chat.moderation.hide(sent.ok ? sent.message.id : "")).toEqual({ ok: false, reason: "not_sent" });
    expect(events.at(-1)).toMatchObject({ type: EVENT.messageHidden, meta: { checkedBy: "rules+jev-1.13.0", p: 0.05 } });
  });

  it("never tells the other side a held message existed, not even as a removal", async () => {
    const chat = chatWith();
    const { a, b } = await pair(chat);
    const open = await chat.load(b);
    now += 10_000;
    const held = await heldWhileDown(chat, a, "Held.");
    await chat.moderation.refuse(held);
    const next = await chat.load(b, { since: open!.cursor });
    expect(next!.messages).toEqual([]);
    expect(next!.removed).toEqual([]);
  });
});

describe("retry", () => {
  it("delivers a held message once Jev answers, checked as the thread stood when it was written", async () => {
    const chat = chatWith();
    const { a, b } = await pair(chat);
    const held = await heldWhileDown(chat, a, "Tuesday works.");
    now += 5000;
    await chat.send(b, "Later message.");
    now += 1000;
    expect(await chat.moderation.retry(held)).toBe("sent");
    expect((await chat.load(b))!.messages.map((m) => m.body)).toEqual(["Later message.", "Tuesday works."]);
    expect(await chat.moderation.retry(held)).toBe("gone");
    expect(events.at(-1)).toMatchObject({ type: EVENT.messageSent, meta: { messageId: held, retry: true, checkedBy: "rules+jev-1.13.0" } });
  });

  it("leaves one Jev scores high for a moderator, and one it still can't check for the next try", async () => {
    const chat = chatWith();
    const { a } = await pair(chat);
    const high = await heldWhileDown(chat, a, "One.");
    const later = await heldWhileDown(chat, a, "Two.");
    jev = 0.9;
    expect(await chat.moderation.retry(high)).toBe("flagged");
    expect((await chat.moderation.listHeld({ holdReason: "flagged" })).map((m) => m.id)).toEqual([high]);
    jev = "down";
    expect(await chat.moderation.retry(later)).toBe("still_held");
    expect(await chat.moderation.retry(high)).toBe("gone");
  });

  it("does nothing for a closed conversation", async () => {
    const chat = chatWith();
    const { a, b } = await pair(chat);
    const held = await heldWhileDown(chat, a, "Late.");
    await chat.resolve(b, "end");
    expect(await chat.moderation.retry(held)).toBe("closed");
  });
});

describe("a whole conversation", () => {
  it("reads every message in every status, with the votes and the host's context", async () => {
    const chat = chatWith({ outcomes: { keep: { by: "*", requires: "all" } } });
    const { cid, a, b } = await pair(chat);
    await chat.send(a, "Delivered.");
    await heldWhileDown(chat, b, "Held.");
    await chat.resolve(a, "keep");
    const thread = await chat.moderation.thread(cid);
    expect(thread).toMatchObject({
      conversation: { id: cid, state: "open", open: true, context: { order: 7 } },
      participants: [
        { id: a, role: "buyer", alias: "Buyer", externalRef: "u-buyer" },
        { id: b, role: "seller", alias: "Seller", externalRef: "u-seller" },
      ],
      votes: [{ participantId: a, outcome: "keep" }],
    });
    expect(thread!.messages.map((m) => [m.body, m.status])).toEqual([
      ["Delivered.", "sent"],
      ["Held.", "held"],
    ]);
    expect(await chat.moderation.thread("c_none")).toBeNull();
  });
});
