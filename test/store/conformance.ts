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

    describe("moderation", () => {
      it("reads one message with whether its conversation is open, and a whole thread in every status", async () => {
        const c = await conversation({ deadlineInMs: HOUR });
        const sent = await message(c, c.a, "hello");
        await h.advance(1000);
        const held = await message(c, c.b, "wait", "held");
        expect(await s.getMessage(sent.id)).toMatchObject({ id: sent.id, body: "hello", conversationOpen: true });
        expect(await s.getMessage("m_none")).toBeNull();
        const thread = await s.listThread({ conversationId: c.conversation.id, limit: 10 });
        expect(thread.map((m) => [m.id, m.status])).toEqual([
          [sent.id, "sent"],
          [held.id, "held"],
        ]);
        expect((await s.listThread({ conversationId: c.conversation.id, limit: 1 })).map((m) => m.id)).toEqual([held.id]);
        await h.advance(HOUR);
        expect(await s.getMessage(sent.id)).toMatchObject({ conversationOpen: false });
      });

      it("moves a held message to delivered once, stamping it now", async () => {
        const c = await conversation();
        const held = await message(c, c.a, "wait", "held");
        await h.advance(5000);
        const t = await s.now();
        const moved = await s.transitionMessage({
          id: held.id,
          from: { status: "held", holdReason: "unchecked" },
          to: { status: "sent", holdReason: null, stampSent: true, score: 0.12, policy: "contact", checkedBy: "rules+jev" },
          requireOpen: true,
        });
        expect(moved).toMatchObject({ status: "sent", holdReason: null, score: expect.closeTo(0.12, 5), policy: "contact", checkedBy: "rules+jev" });
        expect(moved!.sentAt!.getTime()).toBe(t.getTime());
        expect(moved!.updatedAt.getTime()).toBe(t.getTime());
        // A second, racing move finds it already moved.
        expect(await s.transitionMessage({ id: held.id, from: { status: "held" }, to: { status: "sent", stampSent: true } })).toBeNull();
      });

      it("matches the hold reason when asked, keeps what isn't given, and clears a body", async () => {
        const c = await conversation();
        const held = await message(c, c.a, "wait", "held");
        expect(
          await s.transitionMessage({ id: held.id, from: { status: "held", holdReason: "appeal" }, to: { status: "refused" } }),
        ).toBeNull();
        const refused = await s.transitionMessage({ id: held.id, from: { status: "held" }, to: { status: "refused", clearBody: true } });
        expect(refused).toMatchObject({ status: "refused", body: null, holdReason: "unchecked", checkedBy: "rules", sentAt: null });
      });

      it("won't deliver into a conversation past its deadline when told to check", async () => {
        const c = await conversation({ deadlineInMs: HOUR });
        const held = await message(c, c.a, "late", "held");
        await h.advance(HOUR);
        const to = { status: "sent" as const, stampSent: true };
        expect(await s.transitionMessage({ id: held.id, from: { status: "held" }, to, requireOpen: true })).toBeNull();
        expect(await s.transitionMessage({ id: held.id, from: { status: "held" }, to })).toMatchObject({ status: "sent" });
      });

      it("tells the other side to drop a message hidden after delivery, and shows the sender it was", async () => {
        const c = await conversation();
        const sent = await message(c, c.a, "my number is ...");
        await h.advance(1000);
        const cursor = await s.now();
        await h.advance(1000);
        await s.transitionMessage({ id: sent.id, from: { status: "sent" }, to: { status: "hidden" } });
        const forB = await s.listMessages({ conversationId: c.conversation.id, viewerId: c.b.id, changedSince: cursor, limit: 10 });
        expect(forB.messages).toEqual([expect.objectContaining({ id: sent.id, removed: true, body: null })]);
        const forA = await s.listMessages({ conversationId: c.conversation.id, viewerId: c.a.id, changedSince: cursor, limit: 10 });
        expect(forA.messages).toEqual([expect.objectContaining({ id: sent.id, removed: false, status: "hidden" })]);
        // A first load never shows the other side a hidden message.
        expect((await s.listMessages({ conversationId: c.conversation.id, viewerId: c.b.id, limit: 10 })).messages).toEqual([]);
      });

      it("never shows the other side a held message, nor a tombstone for one never delivered", async () => {
        const c = await conversation();
        const cursor = await s.now();
        await h.advance(1000);
        const held = await message(c, c.a, "held one", "held");
        await s.transitionMessage({ id: held.id, from: { status: "held" }, to: { status: "refused", clearBody: true } });
        const forB = await s.listMessages({ conversationId: c.conversation.id, viewerId: c.b.id, changedSince: cursor, limit: 10 });
        expect(forB.messages).toEqual([]);
      });

      it("lists held messages oldest first, by reason, conversation and openness", async () => {
        const one = await conversation({ deadlineInMs: HOUR });
        const two = await conversation();
        const h1 = await message(one, one.a, "1", "held");
        await h.advance(1000);
        const h2 = await message(two, two.a, "2", "held");
        await s.transitionMessage({ id: h2.id, from: { status: "held" }, to: { status: "held", holdReason: "appeal" } });
        await message(two, two.b, "delivered");
        expect((await s.listHeld({ limit: 10 })).map((m) => m.id)).toEqual([h1.id, h2.id]);
        expect((await s.listHeld({ holdReason: "appeal", limit: 10 })).map((m) => m.id)).toEqual([h2.id]);
        expect((await s.listHeld({ conversationId: one.conversation.id, limit: 10 })).map((m) => m.id)).toEqual([h1.id]);
        await h.advance(HOUR);
        expect((await s.listHeld({ onlyOpen: true, limit: 10 })).map((m) => m.id)).toEqual([h2.id]);
        expect((await s.listHeld({ limit: 1 })).map((m) => m.id)).toEqual([h1.id]);
      });
    });

    describe("lifecycle", () => {
      it("lists a user's conversations newest first, by state", async () => {
        const first = await conversation();
        await h.advance(1000);
        const second = await conversation();
        await h.advance(1000);
        await s.createConversation({
          id: id("c"),
          deadlineInMs: DAY,
          context: {},
          participants: [
            { id: id("p"), role: "x", alias: "X", externalRef: "someone-else" },
            { id: id("p"), role: "y", alias: "Y" },
          ],
        });
        const mine = await s.listConversations({ externalRef: "user-1", limit: 10 });
        expect(mine.map((c) => c.conversation.id)).toEqual([second.conversation.id, first.conversation.id]);
        expect(mine[0]!.participants).toHaveLength(2);
        await s.claimClose({ conversationId: first.conversation.id, outcome: "done", by: first.a.id, requireBeforeDeadline: true });
        expect((await s.listConversations({ externalRef: "user-1", state: "closing", limit: 10 })).map((c) => c.conversation.id)).toEqual([
          first.conversation.id,
        ]);
        expect(await s.listConversations({ state: "open", limit: 1 })).toHaveLength(1);
      });

      it("deletes a conversation with its participants, messages and votes", async () => {
        const c = await conversation();
        const m = await message(c, c.a, "bye");
        await s.castVote({ conversationId: c.conversation.id, participantId: c.a.id, outcome: "done" });
        expect(await s.deleteConversation(c.conversation.id)).toBe(true);
        expect(await s.getConversation(c.conversation.id)).toBeNull();
        expect(await s.getParticipantContext(c.a.id)).toBeNull();
        expect(await s.getMessage(m.id)).toBeNull();
        expect(await s.listVotes(c.conversation.id)).toEqual([]);
        expect(await s.deleteConversation(c.conversation.id)).toBe(false);
      });

      it("records each participant's vote for an outcome once, only while open", async () => {
        const c = await conversation({ deadlineInMs: HOUR });
        const cid = c.conversation.id;
        expect(await s.castVote({ conversationId: cid, participantId: c.a.id, outcome: "keep" })).toBe(true);
        expect(await s.castVote({ conversationId: cid, participantId: c.a.id, outcome: "keep" })).toBe(false);
        await h.advance(1000);
        expect(await s.castVote({ conversationId: cid, participantId: c.b.id, outcome: "keep" })).toBe(true);
        expect(await s.castVote({ conversationId: cid, participantId: "p_stranger", outcome: "keep" })).toBe(false);
        expect((await s.listVotes(cid)).map((v) => [v.participantId, v.outcome])).toEqual([
          [c.a.id, "keep"],
          [c.b.id, "keep"],
        ]);
        await h.advance(HOUR);
        expect(await s.castVote({ conversationId: cid, participantId: c.a.id, outcome: "other" })).toBe(false);
      });

      it("closes in two steps: one claim wins, then finishes or goes back to open", async () => {
        const c = await conversation();
        const cid = c.conversation.id;
        const claimed = await s.claimClose({ conversationId: cid, outcome: "keep", by: c.a.id, requireBeforeDeadline: true });
        expect(claimed).toMatchObject({ state: "closing", outcome: "keep", closedBy: c.a.id });
        expect(claimed!.closingAt!.getTime()).toBe((await s.now()).getTime());
        expect(await s.claimClose({ conversationId: cid, outcome: "end", by: c.b.id, requireBeforeDeadline: true })).toBeNull();
        expect(await s.finishClose({ conversationId: cid, outcome: "end" })).toBeNull();
        expect(await s.revertClose({ conversationId: cid, outcome: "keep" })).toBe(true);
        expect(await s.getConversation(cid)).toMatchObject({ open: true, conversation: { state: "open", outcome: null, closedBy: null, closingAt: null } });
        await s.claimClose({ conversationId: cid, outcome: "end", by: c.b.id, requireBeforeDeadline: true });
        const closed = await s.finishClose({ conversationId: cid, outcome: "end" });
        expect(closed).toMatchObject({ state: "closed", outcome: "end", closedBy: c.b.id });
        expect(await s.revertClose({ conversationId: cid, outcome: "end" })).toBe(false);
        expect(await s.getConversation(cid)).toMatchObject({ open: false });
      });

      it("closes past the deadline only when not told to require it, and finds the expired and the stuck", async () => {
        const due = await conversation({ deadlineInMs: HOUR });
        const later = await conversation({ deadlineInMs: 2 * HOUR });
        await conversation({ deadlineInMs: null });
        await h.advance(2 * HOUR);
        expect(await s.findExpired(10)).toEqual([due.conversation.id, later.conversation.id]);
        expect(await s.findExpired(1)).toEqual([due.conversation.id]);
        const cid = due.conversation.id;
        expect(await s.claimClose({ conversationId: cid, outcome: "x", by: due.a.id, requireBeforeDeadline: true })).toBeNull();
        expect(await s.claimClose({ conversationId: cid, outcome: "expired", by: "system", requireBeforeDeadline: false })).toMatchObject({
          state: "closing",
        });
        expect(await s.findExpired(10)).toEqual([later.conversation.id]);
        expect(await s.findStaleClosing({ olderThanMs: MIN, limit: 10 })).toEqual([]);
        await h.advance(MIN);
        expect(await s.findStaleClosing({ olderThanMs: MIN, limit: 10 })).toEqual([{ id: cid, outcome: "expired", by: "system" }]);
      });
    });

    describe("retention", () => {
      it("deletes messages only of conversations closed long enough ago", async () => {
        const closed = await conversation();
        const open = await conversation();
        await message(closed, closed.a, "1");
        await message(closed, closed.b, "2");
        await message(open, open.a, "3");
        await s.claimClose({ conversationId: closed.conversation.id, outcome: "done", by: "system", requireBeforeDeadline: false });
        await s.finishClose({ conversationId: closed.conversation.id, outcome: "done" });
        expect(await s.deleteMessagesAfterClose({ olderThanMs: DAY, limit: 10 })).toBe(0);
        await h.advance(DAY);
        expect(await s.deleteMessagesAfterClose({ olderThanMs: DAY, limit: 1 })).toBe(1);
        expect(await s.deleteMessagesAfterClose({ olderThanMs: DAY, limit: 10 })).toBe(1);
        expect(await s.listThread({ conversationId: closed.conversation.id, limit: 10 })).toEqual([]);
        expect(await s.listThread({ conversationId: open.conversation.id, limit: 10 })).toHaveLength(1);
      });

      it("prunes old events and frees their dedupe keys", async () => {
        await s.appendEvent({ id: id("e"), type: "x", dedupeKey: "k1" });
        await h.advance(DAY);
        await s.appendEvent({ id: id("e"), type: "x" });
        expect(await s.pruneEvents({ olderThanMs: DAY, limit: 10 })).toBe(1);
        expect(await s.pruneEvents({ olderThanMs: DAY, limit: 10 })).toBe(0);
        expect(await s.appendEvent({ id: id("e"), type: "x", dedupeKey: "k1" })).toBe(true);
      });
    });

    describe("notices", () => {
      const params = { everyMs: HOUR, graceMs: 2 * MIN, reminderBeforeMs: 2 * DAY, reminderMinLeftMs: HOUR, closedWithinMs: 3 * DAY };
      const targets = async (kind: "message" | "reminder" | "closed") =>
        (await s.findNoticeTargets(kind, { ...params, limit: 10 })).map((t) => t.participantId);

      it("finds a participant with an unread message from someone else, once it's a little old", async () => {
        const c = await conversation();
        await message(c, c.a, "hello");
        expect(await targets("message")).toEqual([]);
        await h.advance(2 * MIN);
        expect(await s.findNoticeTargets("message", { ...params, limit: 10 })).toEqual([
          { participantId: c.b.id, conversationId: c.conversation.id },
        ]);
      });

      it("claims a message notice once, then waits out the throttle and needs something new", async () => {
        const c = await conversation();
        await message(c, c.a, "hello");
        await h.advance(2 * MIN);
        expect(await s.claimNotice("message", c.b.id, params)).toBe(true);
        expect(await s.claimNotice("message", c.b.id, params)).toBe(false);
        expect(await targets("message")).toEqual([]);
        await h.advance(HOUR);
        // Nothing new since the last notice.
        expect(await targets("message")).toEqual([]);
        await message(c, c.a, "again");
        await h.advance(2 * MIN);
        expect(await targets("message")).toEqual([c.b.id]);
      });

      it("skips a message the participant already read", async () => {
        const c = await conversation();
        await message(c, c.a, "hello");
        await h.advance(MIN);
        await s.getParticipantContext(c.b.id, { markRead: true });
        await h.advance(5 * MIN);
        expect(await targets("message")).toEqual([]);
        expect(await s.claimNotice("message", c.b.id, params)).toBe(false);
      });

      it("sends no message notice once the conversation has closed", async () => {
        const c = await conversation();
        await message(c, c.a, "hello");
        await h.advance(5 * MIN);
        await s.claimClose({ conversationId: c.conversation.id, outcome: "done", by: "system", requireBeforeDeadline: false });
        expect(await targets("message")).toEqual([]);
      });

      it("reminds each participant once, inside the window before the deadline", async () => {
        const c = await conversation({ deadlineInMs: 3 * DAY });
        expect(await targets("reminder")).toEqual([]);
        await h.advance(DAY);
        expect(await targets("reminder")).toEqual([c.a.id, c.b.id]);
        expect(await s.claimNotice("reminder", c.a.id, params)).toBe(true);
        expect(await s.claimNotice("reminder", c.a.id, params)).toBe(false);
        expect(await targets("reminder")).toEqual([c.b.id]);
        await h.advance(2 * DAY - HOUR);
        // Less than the minimum left: too late to be worth it.
        expect(await targets("reminder")).toEqual([]);
      });

      it("tells each participant once that it closed, only if recent", async () => {
        const c = await conversation();
        await s.claimClose({ conversationId: c.conversation.id, outcome: "done", by: c.a.id, requireBeforeDeadline: true });
        expect(await targets("closed")).toEqual([]);
        await s.finishClose({ conversationId: c.conversation.id, outcome: "done" });
        expect(await targets("closed")).toEqual([c.a.id, c.b.id]);
        expect(await s.claimNotice("closed", c.b.id, params)).toBe(true);
        expect(await s.claimNotice("closed", c.b.id, params)).toBe(false);
        expect(await targets("closed")).toEqual([c.a.id]);
        await h.advance(3 * DAY + 1000);
        expect(await targets("closed")).toEqual([]);
      });
    });

    describe("caps and health", () => {
      it("claims under a cap, per type and per participant, within the window", async () => {
        const cap = { type: "jev_call", max: 2, windowMs: HOUR };
        const claim = (participantId: string | null = null) =>
          s.claimEventUnderCap({ id: id("e"), type: "jev_call", participantId }, participantId ? { ...cap, participantId } : cap);
        expect(await claim()).toBe(true);
        expect(await claim("p1")).toBe(true);
        expect(await claim()).toBe(false);
        expect(await claim("p2")).toBe(true);
        expect(await claim("p1")).toBe(true);
        expect(await claim("p1")).toBe(false);
        await h.advance(HOUR);
        expect(await claim()).toBe(true);
      });

      it("reads Jev's health: calls in the window, and the settled last few that never scored", async () => {
        const call = async (p: number | null) => {
          const eid = id("e");
          await s.appendEvent({ id: eid, type: "jev_call" });
          if (p !== null) await s.setEventMeta(eid, { p, model: "jev" });
          await h.advance(1000);
        };
        await call(0.1);
        await call(null);
        await call(0.2);
        await call(null);
        await call(null);
        const input = { type: "jev_call", windowMs: DAY, streak: 3, settleMs: 0 };
        expect(await s.judgeHealth(input)).toEqual({ calls: 5, recent: 3, failed: 2 });
        await call(null);
        // The newest is in flight within the settle time: the last three settled are null, 0.2... no: null, null, 0.2.
        expect(await s.judgeHealth({ ...input, settleMs: 1500 })).toEqual({ calls: 6, recent: 3, failed: 2 });
        expect(await s.judgeHealth(input)).toEqual({ calls: 6, recent: 3, failed: 3 });
        await h.advance(DAY);
        expect(await s.judgeHealth(input)).toMatchObject({ calls: 0, recent: 3 });
      });

      it("merges an event's meta", async () => {
        const eid = id("e");
        await s.appendEvent({ id: eid, type: "jev_call", meta: { policy: "contact" } });
        await s.setEventMeta(eid, { p: 0.4 });
        await h.advance(1000);
        expect(await s.judgeHealth({ type: "jev_call", windowMs: DAY, streak: 1, settleMs: 0 })).toEqual({
          calls: 1,
          recent: 1,
          failed: 0,
        });
      });
    });

    it("has a clock that moves when the harness moves it", async () => {
      const t0 = await s.now();
      await h.advance(90_000);
      expect((await s.now()).getTime()).toBe(t0.getTime() + 90_000);
    });
  });
}
