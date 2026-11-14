import { beforeEach, describe, expect, it } from "vitest";
import {
  createChat,
  EVENT,
  isChaperoneError,
  memoryStore,
  type Chat,
  type ChatConfig,
  type ChatEvent,
  type CloseContext,
  type Store,
} from "../../src";

const SECRET = "test-secret-0123456789-0123456789";
const HOUR = 3_600_000;
const DAY = 86_400_000;

let now: number;
let store: Store;
let events: ChatEvent[];

beforeEach(() => {
  now = new Date("2026-03-01T12:00:00.000Z").getTime();
  store = memoryStore({ clock: () => new Date(now) });
  events = [];
});

function chatWith(extra: Partial<ChatConfig> = {}): Chat {
  return createChat({
    secret: SECRET,
    store,
    jev: false,
    ...extra,
    hooks: { onEvent: (e) => void events.push(e), ...extra.hooks },
  });
}

async function people(chat: Chat, roles = ["buyer", "seller"], durationMs?: number) {
  const opened = await chat.open({
    participants: roles.map((role, i) => ({ role, alias: `${role} ${i}`, externalRef: `user-${i}` })),
    context: { listing: 42 },
    ...(durationMs ? { durationMs } : {}),
  });
  return { cid: opened.conversation.id, ids: opened.links.map((l) => l.participantId) };
}

describe("outcomes", () => {
  it("by default, either side may end it, and after that nothing sends", async () => {
    const chat = chatWith();
    const { cid, ids } = await people(chat);
    expect((await chat.load(ids[1]!))!.outcomes).toEqual(["end"]);
    expect(await chat.resolve(ids[1]!, "end")).toEqual({ ok: true, state: "closed", outcome: "end" });
    expect(await chat.send(ids[0]!, "still there?")).toEqual({ ok: false, reason: "closed" });
    const view = await chat.load(ids[0]!);
    expect(view!.conversation).toMatchObject({ id: cid, state: "closed", open: false, outcome: "end" });
    expect(view!.outcomes).toEqual([]);
    expect(await chat.resolve(ids[0]!, "end")).toEqual({ ok: true, state: "closed", outcome: "end" });
  });

  it("lets only the deciding role choose, as when one side keeps or lets the other go", async () => {
    const chat = chatWith({ outcomes: { keep: { by: ["buyer"] }, let_go: { by: ["buyer"] }, end: { by: ["seller"] } } });
    const [buyer, seller] = (await people(chat)).ids as [string, string];
    expect((await chat.load(buyer))!.outcomes).toEqual(["keep", "let_go"]);
    expect((await chat.load(seller))!.outcomes).toEqual(["end"]);
    expect(await chat.resolve(seller, "keep")).toEqual({ ok: false, reason: "not_allowed" });
    expect(await chat.resolve(seller, "maybe")).toEqual({ ok: false, reason: "unknown_outcome" });
    expect(await chat.resolve(buyer, "keep")).toEqual({ ok: true, state: "closed", outcome: "keep" });
  });

  it("waits for everyone in a double opt-in, saying who is left", async () => {
    const chat = chatWith({ outcomes: { match: { by: "*", requires: "all" }, pass: { by: "*" } } });
    const { ids } = await people(chat, ["a", "b", "c"]);
    const first = await chat.resolve(ids[0]!, "match");
    expect(first).toMatchObject({ ok: true, state: "waiting", outcome: "match" });
    expect(first.ok && first.waitingFor!.map((p) => p.id)).toEqual([ids[1], ids[2]]);
    expect((await chat.load(ids[0]!))!.voted).toEqual(["match"]);
    // Choosing twice changes nothing.
    expect((await chat.resolve(ids[0]!, "match")).ok && (await chat.load(ids[0]!))!.voted).toEqual(["match"]);
    expect(await chat.resolve(ids[1]!, "match")).toMatchObject({ state: "waiting" });
    expect(await chat.resolve(ids[2]!, "match")).toEqual({ ok: true, state: "closed", outcome: "match" });
  });

  it("closes with the expired outcome once the deadline passes, by system", async () => {
    const closes: CloseContext[] = [];
    const chat = chatWith({ hooks: { beforeClose: (ctx) => void closes.push(ctx) } });
    const { cid, ids } = await people(chat, ["a", "b"], HOUR);
    now += HOUR;
    expect(await chat.resolve(ids[0]!, "end")).toEqual({ ok: false, reason: "closed" });
    expect(await chat.lifecycle.expireDue(10)).toBe(1);
    expect(await chat.lifecycle.expireDue(10)).toBe(0);
    expect((await store.getConversation(cid))!.conversation).toMatchObject({ state: "closed", outcome: "expired", closedBy: "system" });
    expect(closes.map((c) => [c.outcome, c.by])).toEqual([["expired", "system"]]);
  });

  it("refuses unknown outcome names and rules in the options", () => {
    for (const config of [{ outcomes: { "Not Ok": { by: "*" } } }, { outcomes: { ok: { by: [] } } }, { outcomes: {} }, { expiredOutcome: "X" }]) {
      let error: unknown;
      try {
        chatWith(config as Partial<ChatConfig>);
      } catch (e) {
        error = e;
      }
      expect(isChaperoneError(error, "invalid_option")).toBe(true);
    }
  });
});

describe("the host's hook", () => {
  it("is told the outcome, who closed it, the participants with their own ids, the votes and the context", async () => {
    const seen: CloseContext[] = [];
    const chat = chatWith({ hooks: { beforeClose: (ctx) => void seen.push(ctx) } });
    const { cid, ids } = await people(chat);
    await chat.resolve(ids[0]!, "end");
    expect(seen).toEqual([
      {
        conversation: { id: cid, key: null, context: { listing: 42 }, deadline: expect.any(Date), createdAt: expect.any(Date) },
        outcome: "end",
        by: ids[0],
        participants: [
          { id: ids[0], role: "buyer", alias: "buyer 0", externalRef: "user-0" },
          { id: ids[1], role: "seller", alias: "seller 1", externalRef: "user-1" },
        ],
        votes: [{ participantId: ids[0], outcome: "end" }],
      },
    ]);
  });

  it("can refuse a close: the conversation opens again and the participant is told why", async () => {
    let refuse = true;
    const chat = chatWith({ hooks: { beforeClose: () => (refuse ? { refuse: "Payment is still pending." } : undefined) } });
    const { cid, ids } = await people(chat);
    expect(await chat.resolve(ids[0]!, "end")).toEqual({ ok: false, reason: "refused", message: "Payment is still pending." });
    expect((await store.getConversation(cid))!).toMatchObject({ open: true, conversation: { state: "open", outcome: null } });
    expect(await chat.send(ids[1]!, "still here")).toMatchObject({ ok: true });
    refuse = false;
    expect(await chat.resolve(ids[0]!, "end")).toMatchObject({ ok: true, state: "closed" });
    expect(events.filter((e) => e.type === EVENT.conversationReopened)).toHaveLength(1);
  });

  it("refuses with false too, without words", async () => {
    const chat = chatWith({ hooks: { beforeClose: () => false } });
    const { ids } = await people(chat);
    expect(await chat.resolve(ids[0]!, "end")).toEqual({ ok: false, reason: "refused" });
  });

  it("that throws leaves it closing; nothing sends; the sweep finishes it once the hook works", async () => {
    let broken = true;
    let calls = 0;
    const chat = chatWith({
      hooks: {
        beforeClose: () => {
          calls++;
          if (broken) throw new Error("payment service down");
        },
      },
    });
    const { cid, ids } = await people(chat);
    expect(await chat.resolve(ids[0]!, "end")).toEqual({ ok: true, state: "closing", outcome: "end" });
    expect((await store.getConversation(cid))!.conversation.state).toBe("closing");
    expect(await chat.send(ids[1]!, "hello?")).toEqual({ ok: false, reason: "closed" });
    expect(await chat.resolve(ids[1]!, "end")).toEqual({ ok: true, state: "closing", outcome: "end" });
    expect(await chat.lifecycle.finishStale({ olderThanMs: 60_000, limit: 10 })).toBe(0);
    now += 60_000;
    expect(await chat.lifecycle.finishStale({ olderThanMs: 60_000, limit: 10 })).toBe(0);
    broken = false;
    expect(await chat.lifecycle.finishStale({ olderThanMs: 60_000, limit: 10 })).toBe(1);
    expect((await store.getConversation(cid))!.conversation).toMatchObject({ state: "closed", outcome: "end", closedBy: ids[0] });
    expect(calls).toBe(3);
    expect(events.filter((e) => e.type === EVENT.closeFailed)).toHaveLength(2);
  });
});

describe("closing by the host or a moderator", () => {
  it("closes with any known outcome, deadline or not, and says what it couldn't", async () => {
    const chat = chatWith({ outcomes: { keep: { by: ["buyer"] } } });
    const { cid } = await people(chat, ["buyer", "seller"], HOUR);
    expect(await chat.close(cid, "nope")).toEqual({ ok: false, reason: "unknown_outcome" });
    expect(await chat.close("c_none", "keep")).toEqual({ ok: false, reason: "not_found" });
    now += 2 * HOUR;
    expect(await chat.close(cid, "keep")).toEqual({ ok: true, state: "closed", outcome: "keep" });
    expect((await store.getConversation(cid))!.conversation.closedBy).toBe("moderator");
    expect(await chat.close(cid, "expired")).toEqual({ ok: false, reason: "closed" });
  });
});

describe("racing closes", () => {
  it("of the same outcome: one claim wins and finishes; the other hears it closing or closed, never an error", async () => {
    const chat = chatWith();
    const { cid, ids } = await people(chat);
    const [first, second] = await Promise.all([chat.resolve(ids[0]!, "end"), chat.resolve(ids[1]!, "end")]);
    expect(first).toEqual({ ok: true, state: "closed", outcome: "end" });
    expect(second).toMatchObject({ ok: true, outcome: "end" });
    expect(["closing", "closed"]).toContain(second.ok && second.state);
    expect((await store.getConversation(cid))!.conversation.state).toBe("closed");
    expect(events.filter((e) => e.type === EVENT.conversationClosed)).toHaveLength(1);
  });
});

describe("events", () => {
  it("record votes and each step of a close, with no text", async () => {
    const chat = chatWith();
    const { ids } = await people(chat);
    await chat.send(ids[0]!, "a private sentence");
    await chat.resolve(ids[0]!, "end");
    expect(events.map((e) => e.type)).toEqual([
      EVENT.conversationOpened,
      EVENT.messageSent,
      EVENT.voteCast,
      EVENT.conversationClosing,
      EVENT.conversationClosed,
    ]);
    expect(JSON.stringify(events)).not.toContain("private sentence");
  });

  it("go on when a listener throws", async () => {
    const chat = chatWith({ hooks: { onEvent: () => { throw new Error("listener down"); } } });
    const { ids } = await people(chat);
    expect(await chat.send(ids[0]!, "hello")).toMatchObject({ ok: true });
  });
});

it("past a day, a conversation without a deadline stays open", async () => {
  const chat = chatWith({ durationMs: null });
  const { ids } = await people(chat);
  now += 30 * DAY;
  expect(await chat.lifecycle.expireDue(10)).toBe(0);
  expect(await chat.send(ids[0]!, "still open")).toMatchObject({ ok: true });
});
