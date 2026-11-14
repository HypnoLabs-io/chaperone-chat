import { beforeEach, describe, expect, it } from "vitest";
import { createChat, EVENT, isChaperoneError, KIND_REASONS, memoryStore, type Chat, type Store } from "../../src";
import { WINDOW_REASONS } from "../../src/guard/window";

const SECRET = "test-secret-0123456789-0123456789";
const HOUR = 3_600_000;
const DAY = 86_400_000;

let now: number;
let store: Store;
let chat: Chat;

/** Every event the store recorded, by spying on appendEvent (the store is ours, so this reads its effect). */
let events: { type: string; participantId?: string | null; meta?: unknown }[];

beforeEach(() => {
  now = new Date("2026-03-01T12:00:00.000Z").getTime();
  const inner = memoryStore({ clock: () => new Date(now) });
  events = [];
  store = {
    ...inner,
    async appendEvent(e) {
      events.push(e);
      return inner.appendEvent(e);
    },
  };
  chat = createChat({ secret: SECRET, store, jev: false });
});

async function pair(extra: Partial<Parameters<Chat["open"]>[0]> = {}) {
  const opened = await chat.open({
    participants: [
      { role: "buyer", alias: "Buyer", externalRef: "u1" },
      { role: "seller", alias: "Seller", externalRef: "u2" },
    ],
    ...extra,
  });
  return { ...opened, a: opened.links[0]!.participantId, b: opened.links[1]!.participantId };
}

async function errorOf(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("open", () => {
  it("opens a conversation with one signed link per participant, in order", async () => {
    const c = await pair();
    expect(c.created).toBe(true);
    expect(c.conversation).toMatchObject({ state: "open", open: true, outcome: null, msLeft: 7 * DAY });
    expect(c.links.map((l) => [l.role, l.alias, l.externalRef])).toEqual([
      ["buyer", "Buyer", "u1"],
      ["seller", "Seller", "u2"],
    ]);
    for (const link of c.links) {
      expect(await chat.verify(link.token)).toEqual({ ok: true, participantId: link.participantId });
      // A link outlives the deadline by the grace period.
      expect(link.expiresAt.getTime()).toBe(now + 7 * DAY + 3 * DAY);
    }
    expect(events.map((e) => e.type)).toEqual([EVENT.conversationOpened]);
  });

  it("returns the first conversation for a key used again", async () => {
    const first = await pair({ key: "order-1" });
    const again = await pair({ key: "order-1" });
    expect(again.created).toBe(false);
    expect(again.conversation.id).toBe(first.conversation.id);
    expect(again.links.map((l) => l.participantId)).toEqual(first.links.map((l) => l.participantId));
    expect(events.filter((e) => e.type === EVENT.conversationOpened)).toHaveLength(1);
  });

  it("takes a duration of its own, or none, with links that last their own time", async () => {
    const short = await pair({ durationMs: 2 * HOUR });
    expect(short.conversation.msLeft).toBe(2 * HOUR);
    const open = await pair({ durationMs: null });
    expect(open.conversation).toMatchObject({ deadline: null, msLeft: null });
    expect(open.links[0]!.expiresAt.getTime()).toBe(now + 30 * DAY);
  });

  it.each([
    [{ participants: [{ role: "a", alias: "A" }] }],
    [{ participants: [{ role: "a", alias: "A" }, { role: "", alias: "B" }] }],
    [{ participants: [{ role: "a", alias: "A" }, { role: "b", alias: "text me at 312 555 0142" }] }],
    [{ participants: [{ role: "a", alias: "A" }, { role: "b", alias: "B" }], durationMs: 0 }],
    [{ participants: [{ role: "a", alias: "A" }, { role: "b", alias: "B" }], key: "" }],
  ])("refuses bad input: %j", async (input) => {
    expect(isChaperoneError(await errorOf(() => chat.open(input)), "invalid_input")).toBe(true);
  });
});

describe("links", () => {
  it("refuses a token that isn't a participant link, and says when one has expired", async () => {
    const c = await pair({ durationMs: HOUR });
    expect(await chat.verify("nonsense")).toEqual({ ok: false, reason: "invalid_link" });
    now += HOUR + 3 * DAY;
    expect(await chat.verify(c.links[0]!.token)).toEqual({ ok: false, reason: "link_expired" });
  });

  it("mints a fresh link for a participant, and none for a stranger", async () => {
    const c = await pair();
    const fresh = await chat.link(c.a);
    expect(fresh).toMatchObject({ participantId: c.a, role: "buyer" });
    expect(await chat.verify(fresh!.token)).toEqual({ ok: true, participantId: c.a });
    expect(await chat.link("p_nobody")).toBeNull();
  });
});

describe("send, with the rules alone", () => {
  it("stores a clean message and delivers it to the other side", async () => {
    const c = await pair();
    const sent = await chat.send(c.a, "  Is the bike still available?\r\n\r\n\r\n\u0007 ");
    expect(sent).toMatchObject({
      ok: true,
      held: false,
      message: { from: c.a, alias: "Buyer", mine: true, body: "Is the bike still available?", status: "sent", note: null },
    });
    const forB = await chat.load(c.b);
    expect(forB!.messages).toEqual([
      expect.objectContaining({ from: c.a, alias: "Buyer", role: "buyer", mine: false, body: "Is the bike still available?" }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: EVENT.messageSent, participantId: c.a });
  });

  it("refuses a contact detail, with its kind and sentence, and never stores it", async () => {
    const c = await pair();
    const refused = await chat.send(c.a, "text me at 312 555 0142");
    expect(refused).toEqual({ ok: false, reason: "blocked", kind: "phone", message: KIND_REASONS.phone, appealable: false });
    expect((await chat.load(c.a))!.messages).toEqual([]);
    expect((await chat.load(c.b))!.messages).toEqual([]);
    const blocked = events.at(-1)!;
    expect(blocked).toMatchObject({ type: EVENT.messageBlocked, participantId: c.a, meta: { kind: "phone", decidedBy: "rules" } });
    expect(JSON.stringify(blocked)).not.toContain("555");
  });

  it("refuses a number split across messages, by the split-message pass", async () => {
    const c = await pair();
    expect(await chat.send(c.b, "it's 312")).toMatchObject({ ok: true });
    expect(await chat.send(c.b, "555")).toMatchObject({ ok: true });
    expect(await chat.send(c.b, "0142")).toEqual({
      ok: false,
      reason: "blocked",
      kind: "phone",
      message: WINDOW_REASONS.phone,
      appealable: false,
    });
    expect(events.at(-1)).toMatchObject({ meta: { decidedBy: "rules-window" } });
  });

  it("reads only the sender's own earlier messages in the split-message pass", async () => {
    const c = await pair();
    await chat.send(c.a, "312");
    await chat.send(c.b, "555");
    expect(await chat.send(c.a, "0142")).toMatchObject({ ok: true });
  });

  it("holds the length limit and refuses an empty message", async () => {
    const c = await pair();
    expect(await chat.send(c.a, " \n\t ")).toEqual({ ok: false, reason: "empty" });
    expect(await chat.send(c.a, "x".repeat(1_001))).toEqual({ ok: false, reason: "too_long" });
    expect(await chat.send(c.a, "x".repeat(1_000))).toMatchObject({ ok: true });
  });

  it("holds the daily limit, refused sends included, and frees it after a day", async () => {
    const small = createChat({ secret: SECRET, store, jev: false, messages: { perParticipantPerDay: 3 } });
    const c = await small.open({ participants: [{ role: "a", alias: "A" }, { role: "b", alias: "B" }] });
    const a = c.links[0]!.participantId;
    expect(await small.send(a, "one")).toMatchObject({ ok: true });
    expect(await small.send(a, "dana@gmail.com")).toMatchObject({ reason: "blocked" });
    expect(await small.send(a, "two")).toMatchObject({ ok: true });
    expect(await small.send(a, "three")).toEqual({ ok: false, reason: "too_many" });
    expect(await small.send(c.links[1]!.participantId, "mine are separate")).toMatchObject({ ok: true });
    now += DAY;
    expect(await small.send(a, "a new day")).toMatchObject({ ok: true });
  });

  it("refuses once the conversation is past its deadline, and says so in the view", async () => {
    const c = await pair({ durationMs: HOUR });
    now += HOUR;
    expect(await chat.send(c.a, "still there?")).toEqual({ ok: false, reason: "closed" });
    expect((await chat.load(c.a))!.conversation).toMatchObject({ state: "open", open: false, msLeft: 0 });
  });

  it("knows no stranger", async () => {
    expect(await chat.send("p_nobody", "hello")).toEqual({ ok: false, reason: "not_found" });
    expect(await chat.load("p_nobody")).toBeNull();
  });

  it("runs on the guard's options: a kind turned off passes", async () => {
    const relaxed = createChat({ secret: SECRET, store, jev: false, rules: { kinds: { ask: false } } });
    const c = await relaxed.open({ participants: [{ role: "a", alias: "A" }, { role: "b", alias: "B" }] });
    expect(await relaxed.send(c.links[0]!.participantId, "text me")).toMatchObject({ ok: true });
  });
});

describe("load", () => {
  it("shows aliases and roles only, and marks the reader's read", async () => {
    const c = await pair();
    const view = await chat.load(c.a);
    expect(view!.you).toEqual({ id: c.a, role: "buyer", alias: "Buyer" });
    expect(view!.participants).toEqual([
      { id: c.a, role: "buyer", alias: "Buyer" },
      { id: c.b, role: "seller", alias: "Seller" },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/u1|u2/);
    expect((await store.getParticipantContext(c.a))!.participant.readAt).not.toBeNull();
    await chat.load(c.b, { markRead: false });
    expect((await store.getParticipantContext(c.b))!.participant.readAt).toBeNull();
  });

  it("returns only what changed since a cursor, overlapping a few seconds so nothing is missed", async () => {
    const c = await pair();
    await chat.send(c.a, "first");
    const first = await chat.load(c.b);
    expect(first!.messages.map((m) => m.body)).toEqual(["first"]);
    // Written within the overlap: the next poll brings it again, and the client merges by id.
    expect((await chat.load(c.b, { since: first!.cursor }))!.messages.map((m) => m.body)).toEqual(["first"]);
    now += 10_000;
    const settled = await chat.load(c.b, { since: first!.cursor });
    expect((await chat.load(c.b, { since: settled!.cursor }))!.messages).toEqual([]);
    await chat.send(c.a, "second");
    const next = await chat.load(c.b, { since: settled!.cursor });
    expect(next!.messages.map((m) => m.body)).toEqual(["second"]);
    expect(next!.more).toBe(false);
  });

  it("pages a long run of changes, carrying on from the last one read", async () => {
    const paged = createChat({ secret: SECRET, store, jev: false, messages: { pageSize: 2 } });
    const c = await paged.open({ participants: [{ role: "a", alias: "A" }, { role: "b", alias: "B" }] });
    const [a, b] = c.links.map((l) => l.participantId) as [string, string];
    const start = await paged.load(b);
    now += 10_000;
    for (const t of ["1", "2", "3"]) {
      await paged.send(a, `m${t}`);
      now += 1_000;
    }
    const seen = new Set<string>();
    let view = await paged.load(b, { since: start!.cursor });
    view!.messages.forEach((m) => seen.add(m.body!));
    expect(view!.more).toBe(true);
    while (view!.more) {
      view = await paged.load(b, { since: view!.cursor });
      view!.messages.forEach((m) => seen.add(m.body!));
    }
    expect([...seen].sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("refuses a cursor that isn't one", async () => {
    const c = await pair();
    expect(isChaperoneError(await errorOf(() => chat.load(c.a, { since: "yesterday" })), "invalid_input")).toBe(true);
  });
});

describe("configuration", () => {
  it.each([
    [{ secret: "short", store: memoryStore(), jev: false }, "invalid_secret"],
    [{ secret: undefined, store: memoryStore(), jev: false }, "invalid_secret"],
    [{ secret: SECRET, jev: false }, "invalid_option"],
    [{ secret: SECRET, store: memoryStore(), jev: false, durationMs: -1 }, "invalid_option"],
    [{ secret: SECRET, store: memoryStore(), jev: false, messages: { maxChars: 0 } }, "invalid_option"],
    [{ secret: SECRET, store: memoryStore() }, "invalid_option"],
  ])("refuses %j", (config, code) => {
    let error: unknown;
    try {
      createChat(config as never);
    } catch (e) {
      error = e;
    }
    expect(isChaperoneError(error, code)).toBe(true);
  });
});
