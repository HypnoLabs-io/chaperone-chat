/**
 * Moderation: the held queue, a whole conversation in every status, and four moves on one message. Each move is one
 * conditional write, so a moderator and the sweep racing on one message move it once.
 *
 * - **approve** a held message: delivered now (it lands at the end of the thread, where it arrives), only while the
 *   conversation is open.
 * - **refuse** a held message: not delivered, its text cleared; the sender reads that it was stopped.
 * - **hide** a delivered message: gone from the others' screens at their next poll; a miss worth calibrating against.
 * - **retry** a message held because Jev couldn't answer: checked again as the conversation stood when it was written.
 *   Passed, it is delivered; scored high, it waits for a moderator (`flagged`); still no answer, it waits for the next try.
 *
 * Moderators are trusted: these views carry every participant's `externalRef` and the host's context.
 */
import type { HoldReason, MessageRow, MessageStatus, ParticipantRow } from "../store/types";
import { verdictMeta, type ChatContext } from "./context";
import { EVENT } from "./event-types";
import { round3 } from "./util";

export interface ModeratorMessage {
  id: string;
  conversationId: string;
  from: string;
  alias: string;
  role: string;
  externalRef: string | null;
  body: string | null;
  status: MessageStatus;
  holdReason: HoldReason | null;
  policy: string | null;
  score: number | null;
  checkedBy: string;
  createdAt: string;
  sentAt: string | null;
}

export interface ModeratorThread {
  conversation: {
    id: string;
    key: string | null;
    state: string;
    open: boolean;
    outcome: string | null;
    closedBy: string | null;
    deadline: string | null;
    context: unknown;
  };
  participants: { id: string; role: string; alias: string; externalRef: string | null }[];
  votes: { participantId: string; outcome: string }[];
  messages: ModeratorMessage[];
}

export type ModerationResult =
  | { ok: true; message: ModeratorMessage }
  | {
      ok: false;
      /** No such message; not held (approve, refuse) or not delivered (hide); its conversation closed (approve). */
      reason: "not_found" | "not_held" | "not_sent" | "closed";
    };

export type RetryOutcome = "sent" | "flagged" | "still_held" | "closed" | "gone";

function view(m: MessageRow, people: ReadonlyMap<string, ParticipantRow>): ModeratorMessage {
  const p = people.get(m.participantId);
  return {
    id: m.id,
    conversationId: m.conversationId,
    from: m.participantId,
    alias: p?.alias ?? "",
    role: p?.role ?? "",
    externalRef: p?.externalRef ?? null,
    body: m.body,
    status: m.status,
    holdReason: m.holdReason,
    policy: m.policy,
    score: m.score,
    checkedBy: m.checkedBy,
    createdAt: m.createdAt.toISOString(),
    sentAt: m.sentAt ? m.sentAt.toISOString() : null,
  };
}

export function createModeration(c: ChatContext) {
  const { store } = c;

  async function peopleOf(conversationId: string): Promise<Map<string, ParticipantRow>> {
    const ctx = await store.getConversation(conversationId);
    return new Map((ctx?.participants ?? []).map((p) => [p.id, p]));
  }

  async function moved(row: MessageRow, type: string, meta: { [key: string]: string | number | boolean | null }) {
    await c.event(type, row.conversationId, row.participantId, { messageId: row.id, ...meta });
    return { ok: true as const, message: view(row, await peopleOf(row.conversationId)) };
  }

  return {
    /** Held messages, oldest first: what waits for a moderator (and for a retry). */
    async listHeld(filter: { holdReason?: HoldReason; conversationId?: string; onlyOpen?: boolean; limit?: number } = {}): Promise<ModeratorMessage[]> {
      const rows = await store.listHeld({
        holdReason: filter.holdReason ?? null,
        conversationId: filter.conversationId ?? null,
        onlyOpen: filter.onlyOpen === true,
        limit: filter.limit ?? 50,
      });
      const people = new Map<string, Map<string, ParticipantRow>>();
      const out: ModeratorMessage[] = [];
      for (const m of rows) {
        if (!people.has(m.conversationId)) people.set(m.conversationId, await peopleOf(m.conversationId));
        out.push(view(m, people.get(m.conversationId)!));
      }
      return out;
    },

    /** A whole conversation as a moderator reads it: every message in every status, the votes, the context. */
    async thread(conversationId: string, options: { limit?: number } = {}): Promise<ModeratorThread | null> {
      const ctx = await store.getConversation(conversationId);
      if (!ctx) return null;
      const [rows, votes] = await Promise.all([
        store.listThread({ conversationId, limit: options.limit ?? 1_000 }),
        store.listVotes(conversationId),
      ]);
      const people = new Map(ctx.participants.map((p) => [p.id, p]));
      const conv = ctx.conversation;
      return {
        conversation: {
          id: conv.id,
          key: conv.key,
          state: conv.state,
          open: ctx.open,
          outcome: conv.outcome,
          closedBy: conv.closedBy,
          deadline: conv.deadline ? conv.deadline.toISOString() : null,
          context: conv.context,
        },
        participants: ctx.participants.map((p) => ({ id: p.id, role: p.role, alias: p.alias, externalRef: p.externalRef })),
        votes: votes.map((v) => ({ participantId: v.participantId, outcome: v.outcome })),
        messages: rows.map((m) => view(m, people)),
      };
    },

    async approve(messageId: string): Promise<ModerationResult> {
      const m = await store.getMessage(messageId);
      if (!m) return { ok: false, reason: "not_found" };
      if (m.status !== "held") return { ok: false, reason: "not_held" };
      if (!m.conversationOpen) return { ok: false, reason: "closed" };
      const row = await store.transitionMessage({
        id: messageId,
        from: { status: "held" },
        // Delivered: no longer waiting for anything (the event keeps why it waited).
        to: { status: "sent", holdReason: null, stampSent: true },
        requireOpen: true,
      });
      if (!row) return { ok: false, reason: "not_held" };
      return moved(row, EVENT.messageApproved, { holdReason: m.holdReason, p: round3(m.score), policy: m.policy });
    },

    async refuse(messageId: string): Promise<ModerationResult> {
      const m = await store.getMessage(messageId);
      if (!m) return { ok: false, reason: "not_found" };
      const row = await store.transitionMessage({ id: messageId, from: { status: "held" }, to: { status: "refused", clearBody: true } });
      if (!row) return { ok: false, reason: "not_held" };
      return moved(row, EVENT.messageRefused, { holdReason: m.holdReason, p: round3(m.score), policy: m.policy });
    },

    async hide(messageId: string): Promise<ModerationResult> {
      const m = await store.getMessage(messageId);
      if (!m) return { ok: false, reason: "not_found" };
      const row = await store.transitionMessage({ id: messageId, from: { status: "sent" }, to: { status: "hidden" } });
      if (!row) return { ok: false, reason: "not_sent" };
      return moved(row, EVENT.messageHidden, { p: round3(m.score), policy: m.policy, checkedBy: m.checkedBy });
    },

    /** Checks a message held because Jev couldn't answer again, as the conversation stood when it was written. */
    async retry(messageId: string): Promise<RetryOutcome> {
      const m = await store.getMessage(messageId);
      if (!m || m.status !== "held" || m.holdReason !== "unchecked" || m.body === null) return "gone";
      if (!m.conversationOpen) return "closed";
      const verdict = await c.screen(m.conversationId, m.participantId, m.body, { before: m.createdAt });
      if (verdict.action === "hold" && verdict.holdReason === "unchecked") return "still_held";
      const send = verdict.action === "send";
      const row = await store.transitionMessage({
        id: messageId,
        from: { status: "held", holdReason: "unchecked" },
        to: send
          ? { status: "sent", holdReason: null, stampSent: true, score: round3(verdict.p), policy: verdict.policy ?? null, checkedBy: verdict.checkedBy }
          : { status: "held", holdReason: "flagged", score: round3(verdict.p), policy: verdict.policy ?? null, checkedBy: verdict.checkedBy },
        requireOpen: true,
      });
      if (!row) return "gone";
      await c.event(send ? EVENT.messageSent : EVENT.messageHeld, row.conversationId, row.participantId, {
        ...verdictMeta(verdict, false),
        messageId,
        retry: true,
      });
      return send ? "sent" : "flagged";
    },
  };
}

export type Moderation = ReturnType<typeof createModeration>;
