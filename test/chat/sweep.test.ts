/**
 * The sweep and its notices, with the clock moved forward, on the memory store and on PGlite (real Postgres). Jev's
 * network is mocked at `fetch`; the host's `notify.send` is a list.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChat,
  EVENT,
  listNames,
  memoryStore,
  renderNotice,
  timeLeft,
  type Chat,
  type ChatConfig,
  type ChatEvent,
  type Notice,
  type ParticipantNotice,
  type Store,
} from "../../src";
import { postgresStore } from "../../src/postgres";

const SECRET = "test-secret-0123456789-0123456789";
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = new Date("2026-03-01T12:00:00.000Z").getTime();

interface Harness {
  store: Store;
  advance(ms: number): Promise<void>;
}

let pg: PGlite | null = null;
let tables = 0;
const STORES: [string, () => Promise<Harness>][] = [
  [
    "memory",
    async () => {
      let now = T0;
      return { store: memoryStore({ clock: () => new Date(now) }), advance: async (ms) => void (now += ms) };
    },
  ],
  [
    "PGlite",
    async () => {
      pg ??= new PGlite();
      let now = T0;
      const set = () => pg!.query(`SET chaperone.now = '${new Date(now).toISOString()}'`);
      await set();
      const store = postgresStore((t, p) => pg!.query(t, p), { prefix: `s${++tables}_`, clock: "current_setting('chaperone.now')::timestamptz" });
      await store.migrate!();
      return { store, advance: async (ms) => { now += ms; await set(); } };
    },
  ],
];

describe.each(STORES)("the sweep on the %s store", (_name, make) => {
  let h: Harness;
  let notices: Notice[];
  let events: ChatEvent[];
  /** Jev answers 0.05, or fails while down. */
  let jevDown: boolean;
  const fakeJev = (async (_url: string, init?: RequestInit) => {
    if (jevDown) return new Response("", { status: 503 });
    const body = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(Object.keys(body.questions).map((n) => [n, { type: "noul", noul: 0.05 }]));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }));
  }) as typeof fetch;

  beforeEach(async () => {
    h = await make();
    notices = [];
    events = [];
    jevDown = false;
  });

  function chatWith(extra: Partial<ChatConfig> = {}): Chat {
    return createChat({
      secret: SECRET,
      store: h.store,
      jev: false,
      notify: { send: (n) => void notices.push(n) },
      ...extra,
      hooks: { onEvent: (e) => void events.push(e), ...extra.hooks },
    });
  }

  async function pair(chat: Chat, durationMs: number | null = 7 * DAY) {
    const opened = await chat.open({
      participants: [
        { role: "buyer", alias: "Buyer", externalRef: "u-buyer" },
        { role: "seller", alias: "Seller", externalRef: "u-seller" },
      ],
      durationMs,
    });
    return { cid: opened.conversation.id, a: opened.links[0]!.participantId, b: opened.links[1]!.participantId };
  }

  const kinds = () => notices.map((n) => (n.kind === "trouble" ? `trouble:${n.why}` : `${n.kind}:${n.participant.alias}`));

  describe("expiry and stuck closes", () => {
    it("closes what is past its deadline, once, even when two sweeps overlap", async () => {
      const chat = chatWith({ notify: undefined });
      const { cid } = await pair(chat, HOUR);
      await pair(chat, 2 * HOUR);
      await h.advance(HOUR);
      const [one, two] = await Promise.all([chat.sweep(), chat.sweep()]);
      expect(one.expired + two.expired).toBe(1);
      expect((await h.store.getConversation(cid))!.conversation).toMatchObject({ state: "closed", outcome: "expired", closedBy: "system" });
      expect((await chat.sweep()).expired).toBe(0);
    });

    it("finishes a close whose hook failed, once the hook works", async () => {
      let broken = true;
      const chat = chatWith({
        notify: undefined,
        hooks: { beforeClose: () => { if (broken) throw new Error("down"); } },
      });
      const { cid, a } = await pair(chat);
      expect(await chat.resolve(a, "end")).toMatchObject({ state: "closing" });
      await h.advance(5 * MIN);
      broken = false;
      expect((await chat.sweep()).finished).toBe(1);
      expect((await h.store.getConversation(cid))!.conversation.state).toBe("closed");
    });
  });

  describe("held messages", () => {
    it("are checked again once Jev answers, and left while it can't", async () => {
      const chat = chatWith({ notify: undefined, jev: { apiKey: "k", fetch: fakeJev } });
      const { a, b } = await pair(chat);
      jevDown = true;
      expect(await chat.send(a, "One.")).toMatchObject({ held: true });
      expect(await chat.send(a, "Two.")).toMatchObject({ held: true });
      // Still down: one try, then the rest of the queue waits.
      expect((await chat.sweep()).retried).toEqual({ sent: 0, flagged: 0, stillHeld: 1 });
      jevDown = false;
      await h.advance(MIN);
      expect((await chat.sweep()).retried).toEqual({ sent: 2, flagged: 0, stillHeld: 0 });
      expect((await chat.load(b))!.messages.map((m) => m.body)).toEqual(["One.", "Two."]);
    });
  });

  describe("retention", () => {
    it("deletes a conversation's messages long enough after it closes, and prunes old events when asked", async () => {
      const chat = chatWith({ notify: undefined, retention: { deleteMessagesAfterCloseDays: 30, pruneEventsAfterDays: 60 } });
      const { cid, a } = await pair(chat);
      await chat.send(a, "Hello.");
      await chat.resolve(a, "end");
      await h.advance(29 * DAY);
      expect((await chat.sweep()).deleted).toBe(0);
      await h.advance(DAY);
      expect((await chat.sweep()).deleted).toBe(1);
      expect((await chat.moderation.thread(cid))!.messages).toEqual([]);
      await h.advance(30 * DAY);
      expect((await chat.sweep()).pruned).toBeGreaterThan(0);
    });

    it("keeps everything with retention off", async () => {
      const chat = chatWith({ notify: undefined, retention: { deleteMessagesAfterCloseDays: null } });
      const { cid, a } = await pair(chat);
      await chat.send(a, "Hello.");
      await chat.resolve(a, "end");
      await h.advance(400 * DAY);
      expect(await chat.sweep()).toMatchObject({ deleted: 0, pruned: 0 });
      expect((await chat.moderation.thread(cid))!.messages).toHaveLength(1);
    });
  });

  describe("notices", () => {
    it("tell a participant about a new message after the grace period, with a working link and no words", async () => {
      const chat = chatWith();
      const { cid, a, b } = await pair(chat);
      await chat.send(a, "A private sentence.");
      await chat.sweep();
      expect(notices).toEqual([]);
      await h.advance(2 * MIN);
      await chat.sweep();
      expect(kinds()).toEqual(["message:Seller"]);
      const n = notices[0] as ParticipantNotice;
      expect(n).toMatchObject({
        kind: "message",
        conversationId: cid,
        participant: { id: b, role: "seller", alias: "Seller", externalRef: "u-seller" },
        others: [{ role: "buyer", alias: "Buyer" }],
        outcome: null,
      });
      expect(await chat.verify(n.link.token)).toEqual({ ok: true, participantId: b });
      expect(JSON.stringify(notices)).not.toContain("private sentence");
    });

    it("skip what the participant already read, and come at most once an hour", async () => {
      const chat = chatWith();
      const { a, b } = await pair(chat);
      await chat.send(a, "First.");
      await chat.load(b);
      await h.advance(5 * MIN);
      await chat.sweep();
      expect(notices).toEqual([]);
      await chat.send(a, "Second.");
      await h.advance(5 * MIN);
      await chat.sweep();
      await chat.send(a, "Third.");
      await h.advance(5 * MIN);
      await chat.sweep();
      expect(kinds()).toEqual(["message:Seller"]);
      await h.advance(HOUR);
      await chat.sweep();
      expect(kinds()).toEqual(["message:Seller", "message:Seller"]);
    });

    it("remind each participant once before the deadline, and tell each once when it closes", async () => {
      const chat = chatWith();
      const { b } = await pair(chat, 3 * DAY);
      await chat.sweep();
      expect(notices).toEqual([]);
      await h.advance(DAY + HOUR);
      await chat.sweep();
      await chat.sweep();
      expect(kinds()).toEqual(["reminder:Buyer", "reminder:Seller"]);
      expect((notices[0] as ParticipantNotice).msLeft).toBe(2 * DAY - HOUR);
      notices = [];
      await chat.resolve(b, "end");
      await chat.sweep();
      await chat.sweep();
      expect(kinds()).toEqual(["closed:Buyer", "closed:Seller"]);
    });

    it("send nothing twice when two sweeps overlap", async () => {
      const chat = chatWith();
      const { a } = await pair(chat);
      await chat.send(a, "Hello.");
      await h.advance(3 * MIN);
      await Promise.all([chat.sweep(), chat.sweep(), chat.sweep()]);
      expect(kinds()).toEqual(["message:Seller"]);
    });

    it("hold a daily budget across everyone", async () => {
      const chat = chatWith({ notify: { send: (n) => void notices.push(n), maxPerDay: 1 } });
      const one = await pair(chat);
      const two = await pair(chat);
      await chat.send(one.a, "Hello.");
      await chat.send(two.a, "Hello.");
      await h.advance(3 * MIN);
      await chat.sweep();
      await chat.sweep();
      expect(notices).toHaveLength(1);
      await h.advance(DAY);
      await chat.sweep();
      expect(notices).toHaveLength(2);
    });

    it("drop a notice whose sending failed, counting it, and don't send it again", async () => {
      const send = vi.fn(() => {
        throw new Error("mail down");
      });
      const chat = chatWith({ notify: { send } });
      const { a } = await pair(chat);
      await chat.send(a, "Hello.");
      await h.advance(3 * MIN);
      expect((await chat.sweep()).notices.failed).toBe(1);
      await chat.sweep();
      expect(send).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.type === EVENT.noticeFailed)).toHaveLength(1);
    });

    it("can be turned off by kind", async () => {
      const chat = chatWith({ notify: { send: (n) => void notices.push(n), kinds: { message: false }, reminderBeforeMs: null } });
      const { a } = await pair(chat, DAY);
      await chat.send(a, "Hello.");
      await h.advance(3 * HOUR);
      await chat.sweep();
      expect(notices).toEqual([]);
    });

    it("tell the host once a day when Jev keeps failing", async () => {
      const chat = chatWith({ jev: { apiKey: "k", fetch: fakeJev } });
      const { a } = await pair(chat);
      jevDown = true;
      for (let i = 0; i < 5; i++) await chat.send(a, `Message ${i}.`);
      await chat.sweep();
      expect(kinds()).toEqual([]);
      // A minute on, the calls have settled and read as failed. Each sweep's retry is a call too: 5 sends, 2 retries.
      await h.advance(MIN + 1000);
      await chat.sweep();
      expect(notices.filter((n) => n.kind === "trouble")).toEqual([{ kind: "trouble", why: "failing", calls: 7, cap: 2_000, failedInARow: 5 }]);
      await h.advance(HOUR);
      await chat.sweep();
      expect(notices.filter((n) => n.kind === "trouble")).toHaveLength(1);
      await h.advance(DAY);
      await chat.sweep();
      expect(notices.filter((n) => n.kind === "trouble")).toHaveLength(2);
    });

    it("tell the host when Jev's cap is spent", async () => {
      const chat = chatWith({ jev: { apiKey: "k", fetch: fakeJev, dailyCap: 1 } });
      const { a } = await pair(chat);
      await chat.send(a, "Fine.");
      await chat.sweep();
      expect(notices.filter((n) => n.kind === "trouble")).toEqual([{ kind: "trouble", why: "cap", calls: 1, cap: 1, failedInARow: 0 }]);
    });
  });
});

describe("startSweeper", () => {
  afterEach(() => vi.useRealTimers());

  /** A store whose expiry read takes 2.5 seconds, as a slow database would. */
  function slowStore(fail = false) {
    const inner = memoryStore();
    const seen = { runs: 0, inFlight: 0, most: 0 };
    const store: Store = {
      ...inner,
      async findExpired(limit) {
        seen.runs++;
        seen.inFlight++;
        seen.most = Math.max(seen.most, seen.inFlight);
        await new Promise((r) => setTimeout(r, 2_500));
        seen.inFlight--;
        if (fail) throw new Error("database down");
        return inner.findExpired(limit);
      },
    };
    return { store, seen };
  }

  it("sweeps on its interval, never two at once, and stops when told", async () => {
    vi.useFakeTimers({ now: T0 });
    const { store, seen } = slowStore();
    const sweeper = createChat({ secret: SECRET, store, jev: false }).startSweeper({ everyMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    sweeper.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    const runs = seen.runs;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen.most).toBe(1);
    expect(runs).toBe(4);
    expect(seen.runs).toBe(runs);
  });

  it("reports a sweep that threw, and keeps going", async () => {
    vi.useFakeTimers({ now: T0 });
    const { store } = slowStore(true);
    const errors: unknown[] = [];
    const sweeper = createChat({ secret: SECRET, store, jev: false }).startSweeper({ everyMs: 1_000, onError: (e) => void errors.push(e) });
    await vi.advanceTimersByTimeAsync(8_000);
    sweeper.stop();
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(String(errors[0])).toContain("database down");
  });
});

describe("renderNotice", () => {
  const base = {
    conversationId: "c1",
    participant: { id: "p1", role: "seller", alias: "Seller", externalRef: "u1" },
    others: [{ role: "buyer", alias: "Sam <b>" }],
    link: { token: "t", expiresAt: new Date(T0) },
    msLeft: 30 * HOUR,
    outcome: null,
  };

  it("words each kind plainly, never quoting a message, and escapes HTML", () => {
    const message = renderNotice({ ...base, kind: "message" }, { url: "https://example.test/chat#t=abc", appName: "Acme" });
    expect(message.subject).toBe("New message from Sam <b>");
    expect(message.text).toBe(
      "Sam <b> sent you a message on Acme.\nMessages stay in the conversation: read it and reply there.\n\nRead and reply: https://example.test/chat#t=abc",
    );
    expect(message.html).toContain("Sam &lt;b&gt; sent you a message on Acme.");
    expect(message.html).toContain('<a href="https://example.test/chat#t=abc">Read and reply</a>');
    expect(renderNotice({ ...base, kind: "reminder" }).subject).toBe("30 hours left in your conversation");
    expect(renderNotice({ ...base, kind: "closed" }).text).toBe("Your conversation with Sam <b> has ended.");
    expect(renderNotice({ kind: "trouble", why: "cap", calls: 2000, cap: 2000, failedInARow: 0 }).subject).toBe(
      "Message screening needs attention",
    );
    expect(renderNotice({ kind: "trouble", why: "failing", calls: 9, cap: null, failedInARow: 5 }).text).toMatch(/last 5 calls all failed/);
  });

  it("names people and time the way a person would", () => {
    expect([listNames([]), listNames(["A"]), listNames(["A", "B"]), listNames(["A", "B", "C"])]).toEqual([
      "the others",
      "A",
      "A and B",
      "A, B and C",
    ]);
    expect([timeLeft(30 * MIN), timeLeft(HOUR), timeLeft(5 * HOUR), timeLeft(3 * DAY + HOUR)]).toEqual([
      "less than an hour",
      "1 hour",
      "5 hours",
      "3 days",
    ]);
  });
});
