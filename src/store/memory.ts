/**
 * The in-memory store: everything in maps, for tests, demos and single-process prototypes. Nothing survives a
 * restart. Rows are copied in and out, so nothing outside can change them. `clock` sets its time (tests move it).
 */
import { EVENT } from "../chat/event-types";
import type {
  ConversationRow,
  ConversationWithParticipants,
  EventRow,
  MessageRow,
  ParticipantContext,
  ParticipantRow,
  Store,
} from "./types";

export interface MemoryStoreOptions {
  /** The store's clock. Default: the system clock. */
  clock?: () => Date;
}

const copy = <T>(value: T): T => structuredClone(value);
const time = (d: Date | null) => (d ? d.getTime() : null);
/** Oldest first by when it reached the thread, then by insertion. */
const byPosition = (a: MessageRow, b: MessageRow) =>
  (time(a.sentAt) ?? a.createdAt.getTime()) - (time(b.sentAt) ?? b.createdAt.getTime()) || a.seq - b.seq;

export function memoryStore(options: MemoryStoreOptions = {}): Store {
  const clock = options.clock ?? (() => new Date());
  const now = () => new Date(clock().getTime());

  const conversations = new Map<string, ConversationRow>();
  const keys = new Map<string, string>();
  const participants = new Map<string, ParticipantRow>();
  const participantsOf = new Map<string, string[]>();
  const messages = new Map<string, MessageRow>();
  const messagesOf = new Map<string, string[]>();
  const events: EventRow[] = [];
  const dedupeKeys = new Set<string>();
  let seq = 0;

  const isOpen = (c: ConversationRow, at: Date) => c.state === "open" && (c.deadline === null || c.deadline > at);

  function withParticipants(c: ConversationRow): ConversationWithParticipants {
    const at = now();
    const list = (participantsOf.get(c.id) ?? []).map((id) => participants.get(id) as ParticipantRow);
    return {
      conversation: copy(c),
      participants: copy(list),
      open: isOpen(c, at),
      msLeft: c.deadline ? Math.max(0, c.deadline.getTime() - at.getTime()) : null,
      now: at,
    };
  }

  const delivered = (conversationId: string) =>
    (messagesOf.get(conversationId) ?? [])
      .map((id) => messages.get(id) as MessageRow)
      .filter((m) => m.status === "sent" && m.body !== null && m.sentAt !== null)
      .sort((a, b) => (a.sentAt as Date).getTime() - (b.sentAt as Date).getTime() || a.seq - b.seq);

  return {
    async now() {
      return now();
    },

    async createConversation(input) {
      if (input.key) {
        const existing = keys.get(input.key);
        if (existing) {
          const found = withParticipants(conversations.get(existing) as ConversationRow);
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
      const base = withParticipants(conversations.get(p.conversationId) as ConversationRow);
      const context: ParticipantContext = { ...base, participant: copy(p) };
      return context;
    },

    async insertMessage(input) {
      const c = conversations.get(input.conversationId);
      const at = now();
      if (!c || !isOpen(c, at)) return null;
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
        seq: ++seq,
      };
      messages.set(row.id, row);
      messagesOf.get(c.id)?.push(row.id);
      return copy(row);
    },

    async listMessages({ conversationId, viewerId, changedSince, limit }) {
      const at = now();
      const all = (messagesOf.get(conversationId) ?? []).map((id) => messages.get(id) as MessageRow);
      const visible = (m: MessageRow) => m.status === "sent" || m.participantId === viewerId;
      if (changedSince) {
        const changed = all
          .filter((m) => m.updatedAt > changedSince)
          .filter((m) => visible(m) || (m.status === "hidden" && m.sentAt !== null))
          .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.seq - b.seq);
        const page = changed.slice(0, limit).map((m) =>
          visible(m) ? { ...copy(m), removed: false } : { ...copy(m), body: null, removed: true },
        );
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
      const stored = (messagesOf.get(p.conversationId) ?? [])
        .map((id) => messages.get(id) as MessageRow)
        .filter((m) => m.participantId === participantId && m.createdAt.getTime() > since).length;
      const blocked = events.filter(
        (e) => e.type === EVENT.messageBlocked && e.participantId === participantId && e.createdAt.getTime() > since,
      ).length;
      return stored + blocked;
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
      });
      return true;
    },
  };
}
