/**
 * The storage contract, as tests every store must pass: the memory store, and the Postgres store on PGlite (and on a
 * real server with `npm run test:pg`). A harness gives a fresh store and moves its clock.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { EVENT } from "../../src/chat/event-types";
import type { Store } from "../../src/store/types";

export interface Harness {
  store: Store;
  /** Moves the store's clock forward. */
  advance(ms: number): Promise<void>;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

let seq = 0;
const id = (prefix: string) => `${prefix}_${(++seq).toString(36).padStart(6, "0")}`;

export function storeConformance(name: string, make: () => Promise<Harness>) {
  describe(`${name}: the storage contract`, () => {
    let h: Harness;
    let s: Store;
    beforeEach(async () => {
      h = await make();
      s = h.store;
    });

    async function conversation(opts: { deadlineInMs?: number | null; key?: string | null; people?: number } = {}) {
      const people = Array.from({ length: opts.people ?? 2 }, (_, i) => ({
        id: id("p"),
        role: i === 0 ? "buyer" : "seller",
        alias: `Person ${i + 1}`,
        externalRef: i === 0 ? "user-1" : null,
      }));
      const made = await s.createConversation({
        id: id("c"),
        key: opts.key ?? null,
        deadlineInMs: opts.deadlineInMs === undefined ? 7 * DAY : opts.deadlineInMs,
        context: { listing: 42, tags: ["a"] },
        participants: people,
      });
      return { ...made, a: made.participants[0]!, b: made.participants[1]! };
    }

    async function message(c: { conversation: { id: string } }, from: { id: string }, body: string, status: "sent" | "held" = "sent") {
      const row = await s.insertMessage({
        id: id("m"),
        conversationId: c.conversation.id,
        participantId: from.id,
        body,
        status,
        holdReason: status === "held" ? "unchecked" : null,
        policy: null,
        score: null,
        checkedBy: "rules",
      });
      if (!row) throw new Error("not stored");
      return row;
    }

    describe("conversations", () => {
      it("creates one with its participants in order, its deadline on the store's clock", async () => {
        const t0 = await s.now();
        const c = await conversation({ people: 3 });
        expect(c.created).toBe(true);
        expect(c.conversation).toMatchObject({ state: "open", outcome: null, closedBy: null, context: { listing: 42, tags: ["a"] } });
        expect(c.conversation.deadline!.getTime()).toBe(t0.getTime() + 7 * DAY);
        expect(c.participants.map((p) => [p.position, p.role, p.alias, p.externalRef])).toEqual([
          [0, "buyer", "Person 1", "user-1"],
          [1, "seller", "Person 2", null],
          [2, "seller", "Person 3", null],
        ]);
      });

      it("returns the first conversation for a key used again, creating nothing", async () => {
        const first = await conversation({ key: "order-7" });
        const again = await conversation({ key: "order-7" });
        expect(again.created).toBe(false);
        expect(again.conversation.id).toBe(first.conversation.id);
        expect(again.participants.map((p) => p.id)).toEqual(first.participants.map((p) => p.id));
      });

      it("reads one back with whether it is open and the time left", async () => {
        const c = await conversation({ deadlineInMs: 2 * HOUR });
        const read = await s.getConversation(c.conversation.id);
        expect(read).toMatchObject({ open: true, msLeft: 2 * HOUR });
        expect(read!.participants).toHaveLength(2);
        await h.advance(2 * HOUR);
        expect(await s.getConversation(c.conversation.id)).toMatchObject({ open: false, msLeft: 0 });
        expect(await s.getConversation("c_none")).toBeNull();
      });

      it("has no deadline when given none", async () => {
        const c = await conversation({ deadlineInMs: null });
        expect(c.conversation.deadline).toBeNull();
        await h.advance(365 * DAY);
        expect(await s.getConversation(c.conversation.id)).toMatchObject({ open: true, msLeft: null });
      });

      it("reads a participant with their conversation, and stamps their read mark only when asked", async () => {
        const c = await conversation();
        const plain = await s.getParticipantContext(c.a.id);
        expect(plain).toMatchObject({ participant: { id: c.a.id, readAt: null }, open: true });
        expect(plain!.conversation.id).toBe(c.conversation.id);
        await h.advance(MIN);
        const marked = await s.getParticipantContext(c.a.id, { markRead: true });
        expect(marked!.participant.readAt!.getTime()).toBe((await s.now()).getTime());
        expect((await s.getParticipantContext(c.b.id))!.participant.readAt).toBeNull();
        expect(await s.getParticipantContext("p_none")).toBeNull();
      });
    });

    describe("messages", () => {
      it("stamps a sent message delivered now, and a held one not at all", async () => {
        const c = await conversation();
        const sent = await message(c, c.a, "hello");
        expect(sent).toMatchObject({ status: "sent", body: "hello", holdReason: null, checkedBy: "rules" });
        expect(sent.sentAt!.getTime()).toBe(sent.createdAt.getTime());
        const held = await message(c, c.a, "wait", "held");
        expect(held).toMatchObject({ status: "held", holdReason: "unchecked", sentAt: null });
      });

      it("stores nothing once the deadline has passed", async () => {
        const c = await conversation({ deadlineInMs: HOUR });
        await h.advance(HOUR);
        expect(
          await s.insertMessage({
            id: id("m"),
            conversationId: c.conversation.id,
            participantId: c.a.id,
            body: "late",
            status: "sent",
            holdReason: null,
            policy: null,
            score: null,
            checkedBy: "rules",
          }),
        ).toBeNull();
      });

      it("shows everyone's delivered messages and only the viewer's own held ones, oldest first", async () => {
        const c = await conversation();
        const m1 = await message(c, c.a, "one");
        await h.advance(1000);
        const held = await message(c, c.b, "b waits", "held");
        await h.advance(1000);
        const m3 = await message(c, c.b, "three");
        const forA = await s.listMessages({ conversationId: c.conversation.id, viewerId: c.a.id, limit: 50 });
        expect(forA.messages.map((m) => m.id)).toEqual([m1.id, m3.id]);
        const forB = await s.listMessages({ conversationId: c.conversation.id, viewerId: c.b.id, limit: 50 });
        expect(forB.messages.map((m) => m.id)).toEqual([m1.id, held.id, m3.id]);
        expect(forB.messages.every((m) => m.removed === false)).toBe(true);
        expect(forB.hasMore).toBe(false);
      });

      it("keeps insertion order for messages stamped in the same instant", async () => {
        const c = await conversation();
        const t0 = await s.now();
        const ids: string[] = [];
        for (let i = 0; i < 6; i++) ids.push((await message(c, i % 2 ? c.b : c.a, `m${i}`)).id);
        const list = await s.listMessages({ conversationId: c.conversation.id, viewerId: c.a.id, limit: 50 });
        expect(list.messages.map((m) => m.id)).toEqual(ids);
        const changed = await s.listMessages({
          conversationId: c.conversation.id,
          viewerId: c.a.id,
          changedSince: new Date(t0.getTime() - 1),
          limit: 50,
        });
        expect(changed.messages.map((m) => m.id)).toEqual(ids);
        const turns = await s.recentTurns({ conversationId: c.conversation.id, senderId: c.a.id, contextTurns: 10, windowMax: 10, windowMs: DAY });
        expect(turns.turns.map((t) => t.body)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
        const seqs = list.messages.map((m) => m.seq);
        expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
      });

      it("returns the newest page first time, saying older ones exist", async () => {
        const c = await conversation();
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          ids.push((await message(c, c.a, `m${i}`)).id);
          await h.advance(1000);
        }
        const page = await s.listMessages({ conversationId: c.conversation.id, viewerId: c.b.id, limit: 3 });
        expect(page.messages.map((m) => m.id)).toEqual(ids.slice(2));
        expect(page.hasMore).toBe(true);
      });

      it("returns only what changed after a cursor, and the store's clock", async () => {
        const c = await conversation();
        await message(c, c.a, "old");
        await h.advance(1000);
        const cursor = await s.now();
        await h.advance(1000);
        const fresh = await message(c, c.b, "new");
        const changed = await s.listMessages({ conversationId: c.conversation.id, viewerId: c.a.id, changedSince: cursor, limit: 50 });
        expect(changed.messages.map((m) => m.id)).toEqual([fresh.id]);
        expect(changed.now.getTime()).toBe((await s.now()).getTime());
        const none = await s.listMessages({ conversationId: c.conversation.id, viewerId: c.a.id, changedSince: changed.now, limit: 50 });
        expect(none.messages).toEqual([]);
      });

      it("pages changes after a cursor by when they changed", async () => {
        const c = await conversation();
        const cursor = await s.now();
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) {
          await h.advance(1000);
          ids.push((await message(c, c.a, `m${i}`)).id);
        }
        const page = await s.listMessages({ conversationId: c.conversation.id, viewerId: c.b.id, changedSince: cursor, limit: 3 });
        expect(page.messages.map((m) => m.id)).toEqual(ids.slice(0, 3));
        expect(page.hasMore).toBe(true);
        const rest = await s.listMessages({
          conversationId: c.conversation.id,
          viewerId: c.b.id,
          changedSince: page.messages[2]!.updatedAt,
          limit: 3,
        });
        expect(rest.messages.map((m) => m.id)).toEqual(ids.slice(3));
      });
    });

    describe("the turns a check reads", () => {
      it("gives the last few delivered messages, both sides, and the sender's own within the window", async () => {
        const c = await conversation();
        const a1 = await message(c, c.a, "a1");
        await h.advance(2 * HOUR);
        const a2 = await message(c, c.a, "a2");
        await h.advance(MIN);
        await message(c, c.a, "held", "held");
        for (let i = 0; i < 3; i++) {
          await h.advance(MIN);
          await message(c, c.b, `b${i}`);
        }
        const turns = await s.recentTurns({
          conversationId: c.conversation.id,
          senderId: c.a.id,
          contextTurns: 2,
          windowMax: 5,
          windowMs: HOUR,
        });
        // Context: the last two delivered (b1, b2). Window: a's own within the hour (a2; a1 is two hours back).
        expect(turns.turns.map((t) => t.body)).toEqual(["a2", "b1", "b2"]);
        expect(turns.turns[0]).toMatchObject({ participantId: c.a.id, sentAt: a2.sentAt });
        const wide = await s.recentTurns({ conversationId: c.conversation.id, senderId: c.a.id, contextTurns: 0, windowMax: 1, windowMs: DAY });
        expect(wide.turns.map((t) => t.body)).toEqual(["a2"]);
        const before = await s.recentTurns({
          conversationId: c.conversation.id,
          senderId: c.a.id,
          contextTurns: 10,
          windowMax: 5,
          windowMs: DAY,
          before: a2.sentAt,
        });
        expect(before.turns.map((t) => t.body)).toEqual([a1.body, a2.body]);
      });
    });

    describe("activity and events", () => {
      it("counts a participant's stored messages and refused sends within the window", async () => {
        const c = await conversation();
        await message(c, c.a, "1");
        await message(c, c.a, "2", "held");
        await message(c, c.b, "theirs");
        expect(
          await s.appendEvent({ id: id("e"), type: EVENT.messageBlocked, conversationId: c.conversation.id, participantId: c.a.id }),
        ).toBe(true);
        await s.appendEvent({ id: id("e"), type: EVENT.messageSent, conversationId: c.conversation.id, participantId: c.a.id });
        expect(await s.countActivity({ participantId: c.a.id, windowMs: DAY })).toBe(3);
        await h.advance(DAY);
        expect(await s.countActivity({ participantId: c.a.id, windowMs: DAY })).toBe(0);
      });

      it("claims a dedupe key once", async () => {
        expect(await s.appendEvent({ id: id("e"), type: "x", dedupeKey: "once" })).toBe(true);
        expect(await s.appendEvent({ id: id("e"), type: "x", dedupeKey: "once" })).toBe(false);
        expect(await s.appendEvent({ id: id("e"), type: "x" })).toBe(true);
        expect(await s.appendEvent({ id: id("e"), type: "x" })).toBe(true);
      });
    });

    it("has a clock that moves when the harness moves it", async () => {
      const t0 = await s.now();
      await h.advance(90_000);
      expect((await s.now()).getTime()).toBe(t0.getTime() + 90_000);
    });
  });
}
