/**
 * The in-memory store: everything in maps, for tests, demos and single-process prototypes. Nothing survives a
 * restart. Rows are copied in and out, so nothing outside can change them. `clock` sets its time (tests move it).
 * It is the reference the conformance suite holds every store to.
 */
import { EVENT } from "../chat/event-types";
import type {
  ConversationRow,
  ConversationWithParticipants,
  EventRow,
  Json,
  MessageRow,
  NoticeKind,
  NoticeParams,
  ParticipantContext,
  ParticipantRow,
  Store,
} from "./types";

export interface MemoryStoreOptions {
  /** The store's clock. Default: the system clock. */
  clock?: () => Date;
}

const copy = <T>(value: T): T => structuredClone(value);
const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
/** Oldest first by when it reached the thread, then by insertion. */
const byPosition = (a: MessageRow, b: MessageRow) =>
  (ms(a.sentAt) ?? a.createdAt.getTime()) - (ms(b.sentAt) ?? b.createdAt.getTime()) || a.seq - b.seq;

interface Vote {
  participantId: string;
  outcome: string;
  createdAt: Date;
}

export function memoryStore(options: MemoryStoreOptions = {}): Store {
  const clock = options.clock ?? (() => new Date());
  const now = () => new Date(clock().getTime());

  const conversations = new Map<string, ConversationRow>();
  const keys = new Map<string, string>();
  const participants = new Map<string, ParticipantRow>();
  const participantsOf = new Map<string, string[]>();
  const messages = new Map<string, MessageRow>();
  const messagesOf = new Map<string, string[]>();
  const votes = new Map<string, Vote[]>();
  const events: (EventRow & { seq: number })[] = [];
  const dedupeKeys = new Set<string>();
  let messageSeq = 0;
  let eventSeq = 0;

  const isOpen = (c: ConversationRow, at: Date) => c.state === "open" && (c.deadline === null || c.deadline > at);
  const conversationOf = (id: string) => conversations.get(id) as ConversationRow;
  const messagesIn = (conversationId: string) =>
    (messagesOf.get(conversationId) ?? []).map((id) => messages.get(id) as MessageRow);
  const peopleIn = (conversationId: string) =>
    (participantsOf.get(conversationId) ?? []).map((id) => participants.get(id) as ParticipantRow);

  function withParticipants(c: ConversationRow): ConversationWithParticipants {
    const at = now();
    return {
      conversation: copy(c),
      participants: copy(peopleIn(c.id)),
      open: isOpen(c, at),
      msLeft: c.deadline ? Math.max(0, c.deadline.getTime() - at.getTime()) : null,
      now: at,
    };
  }

  const delivered = (conversationId: string) =>
    messagesIn(conversationId)
      .filter((m) => m.status === "sent" && m.body !== null && m.sentAt !== null)
      .sort((a, b) => (a.sentAt as Date).getTime() - (b.sentAt as Date).getTime() || a.seq - b.seq);

  /** Whether a participant is due a notice of `kind` now. */
  function due(kind: NoticeKind, p: ParticipantRow, params: NoticeParams, at: Date): boolean {
    const c = conversationOf(p.conversationId);
    const t = at.getTime();
    if (kind === "message") {
      if (!isOpen(c, at)) return false;
      if (p.notifiedAt && p.notifiedAt.getTime() > t - params.everyMs) return false;
      // The last notice covered what was old enough then: a message from the grace period before it still counts.
      const covered = p.notifiedAt ? p.notifiedAt.getTime() - params.graceMs : -Infinity;
      const after = Math.max(ms(p.readAt) ?? -Infinity, covered);
      return messagesIn(c.id).some(
        (m) =>
          m.participantId !== p.id &&
          m.status === "sent" &&
          m.sentAt !== null &&
          m.sentAt.getTime() > after &&
          m.sentAt.getTime() <= t - params.graceMs,
      );
    }
    if (kind === "reminder") {
      return (
        c.state === "open" &&
        c.deadline !== null &&
        c.deadline.getTime() > t + params.reminderMinLeftMs &&
        c.deadline.getTime() <= t + params.reminderBeforeMs &&
        p.remindedAt === null
      );
    }
    return (
      c.state === "closed" && c.closedAt !== null && c.closedAt.getTime() >= t - params.closedWithinMs && p.closedNotifiedAt === null
    );
  }

  return {
    async now() {
      return now();
    },

    async createConversation(input) {
      if (input.key) {
        const existing = keys.get(input.key);
        if (existing) {
          const found = withParticipants(conversationOf(existing));
          return { created: false, conversation: found.conversation, participants: found.participants };
        }
      }
      const at = now();
      const conversation: ConversationRow = {
        id: input.id,
        key: input.key ?? null,
        state: "open",
        outcome: null,
        closedBy: null,
        deadline: input.deadlineInMs == null ? null : new Date(at.getTime() + input.deadlineInMs),
        context: copy(input.context),
        createdAt: at,
        closingAt: null,
        closedAt: null,
      };
      conversations.set(conversation.id, conversation);
      if (conversation.key) keys.set(conversation.key, conversation.id);
      const rows = input.participants.map(
        (p, position): ParticipantRow => ({
          id: p.id,
          conversationId: conversation.id,
          role: p.role,
          alias: p.alias,
          externalRef: p.externalRef ?? null,
          position,
          readAt: null,
          notifiedAt: null,
          remindedAt: null,
          closedNotifiedAt: null,
          createdAt: at,
        }),
      );
      for (const row of rows) participants.set(row.id, row);
      participantsOf.set(conversation.id, rows.map((r) => r.id));
      messagesOf.set(conversation.id, []);
      votes.set(conversation.id, []);
      return { created: true, conversation: copy(conversation), participants: copy(rows) };
    },

    async getConversation(id) {
      const c = conversations.get(id);
      return c ? withParticipants(c) : null;
    },

    async getParticipantContext(participantId, opts = {}) {
      const p = participants.get(participantId);
      if (!p) return null;
      if (opts.markRead) p.readAt = now();
      const context: ParticipantContext = { ...withParticipants(conversationOf(p.conversationId)), participant: copy(p) };
      return context;
    },

    async listConversations({ externalRef, state, limit }) {
      return [...conversations.values()]
        .filter((c) => (state ? c.state === state : true))
        .filter((c) => (externalRef ? peopleIn(c.id).some((p) => p.externalRef === externalRef) : true))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(withParticipants);
    },

    async deleteConversation(id) {
      const c = conversations.get(id);
      if (!c) return false;
      for (const pid of participantsOf.get(id) ?? []) participants.delete(pid);
      for (const mid of messagesOf.get(id) ?? []) messages.delete(mid);
      participantsOf.delete(id);
      messagesOf.delete(id);
      votes.delete(id);
      if (c.key) keys.delete(c.key);
      conversations.delete(id);
      return true;
    },

    async insertMessage(input) {
      const c = conversations.get(input.conversationId);
      const p = participants.get(input.participantId);
      const at = now();
      if (!c || !isOpen(c, at) || !p || p.conversationId !== c.id) return null;
      const row: MessageRow = {
        id: input.id,
        conversationId: input.conversationId,
        participantId: input.participantId,
        body: input.body,
        status: input.status,
        holdReason: input.holdReason,
        policy: input.policy,
        score: input.score,
        checkedBy: input.checkedBy,
        createdAt: at,
        sentAt: input.status === "sent" ? at : null,
        updatedAt: at,
        seq: ++messageSeq,
      };
      messages.set(row.id, row);
      messagesOf.get(c.id)?.push(row.id);
      return copy(row);
    },

    async listMessages({ conversationId, viewerId, changedSince, limit }) {
      const at = now();
      const all = messagesIn(conversationId);
      const visible = (m: MessageRow) => m.status === "sent" || m.participantId === viewerId;
      if (changedSince) {
        const changed = all
          .filter((m) => m.updatedAt > changedSince)
          .filter((m) => visible(m) || (m.status === "hidden" && m.sentAt !== null))
          .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.seq - b.seq);
        const page = changed
          .slice(0, limit)
          .map((m) => (visible(m) ? { ...copy(m), removed: false } : { ...copy(m), body: null, removed: true }));
        return { messages: page, hasMore: changed.length > limit, now: at };
      }
      const shown = all.filter(visible).sort(byPosition);
      const page = shown.slice(Math.max(0, shown.length - limit)).map((m) => ({ ...copy(m), removed: false }));
      return { messages: page, hasMore: shown.length > limit, now: at };
    },

    async recentTurns({ conversationId, senderId, contextTurns, windowMax, windowMs, before }) {
      const at = now();
      const ref = before ?? at;
      const list = delivered(conversationId).filter((m) => (m.sentAt as Date) <= ref);
      const context = contextTurns > 0 ? list.slice(-contextTurns) : [];
      const since = ref.getTime() - windowMs;
      const own = list.filter((m) => m.participantId === senderId && (m.sentAt as Date).getTime() >= since);
      const window = windowMax > 0 ? own.slice(-windowMax) : [];
      const ids = new Set([...context, ...window].map((m) => m.id));
      const turns = list
        .filter((m) => ids.has(m.id))
        .map((m) => ({ participantId: m.participantId, body: m.body as string, sentAt: new Date((m.sentAt as Date).getTime()) }));
      return { turns, now: at };
    },

    async countActivity({ participantId, windowMs }) {
      const since = now().getTime() - windowMs;
      const p = participants.get(participantId);
      if (!p) return 0;
      const stored = messagesIn(p.conversationId).filter(
        (m) => m.participantId === participantId && m.createdAt.getTime() > since,
      ).length;
      const blocked = events.filter(
        (e) => e.type === EVENT.messageBlocked && e.participantId === participantId && e.createdAt.getTime() > since,
      ).length;
      return stored + blocked;
    },

    async getMessage(id) {
      const m = messages.get(id);
      if (!m) return null;
      return { ...copy(m), conversationOpen: isOpen(conversationOf(m.conversationId), now()) };
    },

    async listThread({ conversationId, limit }) {
      const all = messagesIn(conversationId).sort(byPosition);
      return copy(all.slice(Math.max(0, all.length - limit)));
    },

    async transitionMessage({ id, from, to, requireOpen }) {
      const m = messages.get(id);
      if (!m || m.status !== from.status) return null;
      if (from.holdReason !== undefined && m.holdReason !== from.holdReason) return null;
      const at = now();
      if (requireOpen && !isOpen(conversationOf(m.conversationId), at)) return null;
      m.status = to.status;
      if (to.holdReason !== undefined) m.holdReason = to.holdReason;
      if (to.stampSent) m.sentAt = at;
      if (to.clearBody) m.body = null;
      if (to.score !== undefined) m.score = to.score;
      if (to.policy !== undefined) m.policy = to.policy;
      if (to.checkedBy !== undefined) m.checkedBy = to.checkedBy;
      m.updatedAt = at;
      return copy(m);
    },

    async listHeld({ holdReason, onlyOpen, conversationId, limit }) {
      const at = now();
      return copy(
        [...messages.values()]
          .filter((m) => m.status === "held")
          .filter((m) => (holdReason ? m.holdReason === holdReason : true))
          .filter((m) => (conversationId ? m.conversationId === conversationId : true))
          .filter((m) => (onlyOpen ? isOpen(conversationOf(m.conversationId), at) : true))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq)
          .slice(0, limit),
      );
    },

    async deleteMessagesAfterClose({ olderThanMs, limit }) {
      const before = now().getTime() - olderThanMs;
      const gone = [...messages.values()]
        .filter((m) => {
          const c = conversationOf(m.conversationId);
          return c.state === "closed" && c.closedAt !== null && c.closedAt.getTime() <= before;
        })
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq)
        .slice(0, limit);
      for (const m of gone) {
        messages.delete(m.id);
        const list = messagesOf.get(m.conversationId) ?? [];
        messagesOf.set(
          m.conversationId,
          list.filter((id) => id !== m.id),
        );
      }
      return gone.length;
    },

    async castVote({ conversationId, participantId, outcome }) {
      const c = conversations.get(conversationId);
      const p = participants.get(participantId);
      if (!c || !isOpen(c, now()) || !p || p.conversationId !== conversationId) return false;
      const list = votes.get(conversationId) ?? [];
      if (list.some((v) => v.participantId === participantId && v.outcome === outcome)) return false;
      list.push({ participantId, outcome, createdAt: now() });
      votes.set(conversationId, list);
      return true;
    },

    async listVotes(conversationId) {
      return copy(votes.get(conversationId) ?? []);
    },

    async claimClose({ conversationId, outcome, by, requireBeforeDeadline }) {
      const c = conversations.get(conversationId);
      const at = now();
      if (!c || c.state !== "open") return null;
      if (requireBeforeDeadline && c.deadline !== null && c.deadline <= at) return null;
      c.state = "closing";
      c.outcome = outcome;
      c.closedBy = by;
      c.closingAt = at;
      return copy(c);
    },

    async finishClose({ conversationId, outcome }) {
      const c = conversations.get(conversationId);
      if (!c || c.state !== "closing" || c.outcome !== outcome) return null;
      c.state = "closed";
      c.closedAt = now();
      return copy(c);
    },

    async revertClose({ conversationId, outcome }) {
      const c = conversations.get(conversationId);
      if (!c || c.state !== "closing" || c.outcome !== outcome) return false;
      c.state = "open";
      c.outcome = null;
      c.closedBy = null;
      c.closingAt = null;
      return true;
    },

    async findExpired(limit) {
      const at = now();
      return [...conversations.values()]
        .filter((c) => c.state === "open" && c.deadline !== null && c.deadline <= at)
        .sort((a, b) => (a.deadline as Date).getTime() - (b.deadline as Date).getTime() || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((c) => c.id);
    },

    async findStaleClosing({ olderThanMs, limit }) {
      const before = now().getTime() - olderThanMs;
      return [...conversations.values()]
        .filter((c) => c.state === "closing" && c.closingAt !== null && c.closingAt.getTime() <= before)
        .sort((a, b) => (a.closingAt as Date).getTime() - (b.closingAt as Date).getTime() || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((c) => ({ id: c.id, outcome: c.outcome as string, by: c.closedBy as string }));
    },

    async findNoticeTargets(kind, params) {
      const at = now();
      return [...participants.values()]
        .filter((p) => due(kind, p, params, at))
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : a.position - b.position),
        )
        .slice(0, params.limit)
        .map((p) => ({ participantId: p.id, conversationId: p.conversationId }));
    },

    async claimNotice(kind, participantId, params) {
      const p = participants.get(participantId);
      const at = now();
      if (!p || !due(kind, p, params, at)) return false;
      if (kind === "message") p.notifiedAt = at;
      else if (kind === "reminder") p.remindedAt = at;
      else p.closedNotifiedAt = at;
      return true;
    },

    async appendEvent(event) {
      const dedupeKey = event.dedupeKey ?? null;
      if (dedupeKey !== null) {
        if (dedupeKeys.has(dedupeKey)) return false;
        dedupeKeys.add(dedupeKey);
      }
      events.push({
        id: event.id,
        type: event.type,
        conversationId: event.conversationId ?? null,
        participantId: event.participantId ?? null,
        meta: copy(event.meta ?? {}),
        dedupeKey,
        createdAt: now(),
        seq: ++eventSeq,
      });
      return true;
    },

    async claimEventUnderCap(event, cap) {
      const since = now().getTime() - cap.windowMs;
      const count = events.filter(
        (e) =>
          e.type === cap.type &&
          (cap.participantId ? e.participantId === cap.participantId : true) &&
          e.createdAt.getTime() > since,
      ).length;
      if (count >= cap.max) return false;
      events.push({
        id: event.id,
        type: event.type,
        conversationId: event.conversationId ?? null,
        participantId: event.participantId ?? null,
        meta: copy(event.meta ?? {}),
        dedupeKey: null,
        createdAt: now(),
        seq: ++eventSeq,
      });
      return true;
    },

    async setEventMeta(id, meta) {
      const e = events.find((x) => x.id === id);
      if (!e) return;
      const base = e.meta && typeof e.meta === "object" && !Array.isArray(e.meta) ? (e.meta as { [key: string]: Json }) : {};
      e.meta = { ...base, ...copy(meta) };
    },

    async judgeHealth({ type, windowMs, streak, settleMs }) {
      const t = now().getTime();
      const calls = events.filter((e) => e.type === type && e.createdAt.getTime() > t - windowMs).length;
      const last = events
        .filter((e) => e.type === type && e.createdAt.getTime() < t - settleMs)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.seq - a.seq)
        .slice(0, streak);
      const failed = last.filter((e) => {
        const meta = e.meta as { p?: unknown } | null;
        return !meta || typeof meta !== "object" || meta.p === undefined || meta.p === null;
      }).length;
      return { calls, recent: last.length, failed };
    },

    async pruneEvents({ olderThanMs, limit }) {
      const before = now().getTime() - olderThanMs;
      const gone = events
        .filter((e) => e.createdAt.getTime() <= before)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq)
        .slice(0, limit);
      const ids = new Set(gone.map((e) => e.id));
      for (const e of gone) if (e.dedupeKey) dedupeKeys.delete(e.dedupeKey);
      for (let i = events.length - 1; i >= 0; i--) if (ids.has((events[i] as EventRow).id)) events.splice(i, 1);
      return gone.length;
    },
  };
}
