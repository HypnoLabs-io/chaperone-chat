/**
 * The storage contract. Two implementations ship: `memoryStore()` and `postgresStore(query)`. Each method is one
 * statement on Postgres (no transactions, so HTTP drivers work) and synchronous on the memory store, and the store's
 * own clock is the one clock: deadlines, stamps, limits, caps, the poll cursor and retention all read `now()`.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ConversationState = "open" | "closing" | "closed";
/** `sent` delivered; `held` waiting for a check or a moderator; `refused` by a moderator before delivery; `hidden` by a moderator after. */
export type MessageStatus = "sent" | "held" | "refused" | "hidden";
/** Why a message waits: the sender appealed a refusal, Jev couldn't answer, or a policy holds it for a moderator. */
export type HoldReason = "appeal" | "unchecked" | "flagged";

export interface ConversationRow {
  id: string;
  /** The host's idempotency key: opening twice with one key returns the first conversation. */
  key: string | null;
  state: ConversationState;
  outcome: string | null;
  /** The participant who closed it, or "system" (expiry) or "moderator". */
  closedBy: string | null;
  deadline: Date | null;
  /** The host's own data, never shown to participants. */
  context: Json;
  createdAt: Date;
  closingAt: Date | null;
  closedAt: Date | null;
}

export interface ParticipantRow {
  id: string;
  conversationId: string;
  role: string;
  alias: string;
  /** The host's own id for this person; never shown to the others. */
  externalRef: string | null;
  /** Order of joining, from 0. */
  position: number;
  readAt: Date | null;
  notifiedAt: Date | null;
  remindedAt: Date | null;
  closedNotifiedAt: Date | null;
  createdAt: Date;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  participantId: string;
  /** Null once cleared (a refused message, retention). */
  body: string | null;
  status: MessageStatus;
  holdReason: HoldReason | null;
  /** The policy whose score decided, if one did. */
  policy: string | null;
  score: number | null;
  /** `rules`, or `rules+jev-1.13.0` when Jev answered. */
  checkedBy: string;
  createdAt: Date;
  /** When it was delivered; null while held, and for one never delivered. */
  sentAt: Date | null;
  /** Every change moves it: the poll cursor reads it. */
  updatedAt: Date;
  /** Insertion order: breaks ties between messages stamped in the same instant. */
  seq: number;
}

export interface EventInput {
  id: string;
  type: string;
  conversationId?: string | null;
  participantId?: string | null;
  /** Never message text. */
  meta?: Json;
}

export interface EventRow extends Required<Omit<EventInput, "meta">> {
  meta: Json;
  dedupeKey: string | null;
  createdAt: Date;
}

export interface NewParticipant {
  id: string;
  role: string;
  alias: string;
  externalRef?: string | null;
}

export interface ConversationWithParticipants {
  conversation: ConversationRow;
  participants: ParticipantRow[];
  /** Open and before its deadline, by the store's clock. */
  open: boolean;
  /** Milliseconds to the deadline (0 once passed); null with no deadline. */
  msLeft: number | null;
  now: Date;
}

export interface ParticipantContext extends ConversationWithParticipants {
  participant: ParticipantRow;
}

export interface Store {
  /** Creates the tables when the store owns them (Postgres); a no-op where there's nothing to create. */
  migrate?(): Promise<void>;
  /** The store's clock. */
  now(): Promise<Date>;

  // --- conversations and participants ---
  /** With a `key` already used, nothing is created and the existing one comes back with `created: false`. */
  createConversation(input: {
    id: string;
    key?: string | null;
    /** From now, by the store's clock; null for no deadline. */
    deadlineInMs?: number | null;
    context: Json;
    participants: NewParticipant[];
  }): Promise<{ created: boolean; conversation: ConversationRow; participants: ParticipantRow[] }>;
  getConversation(id: string): Promise<ConversationWithParticipants | null>;
  /** One participant with their conversation; `markRead` stamps their read mark in the same statement. */
  getParticipantContext(participantId: string, options?: { markRead?: boolean }): Promise<ParticipantContext | null>;

  // --- messages ---
  /** Stored only while the conversation is open and before its deadline; null otherwise. A `sent` one is stamped now. */
  insertMessage(input: {
    id: string;
    conversationId: string;
    participantId: string;
    body: string;
    status: "sent" | "held";
    holdReason: HoldReason | null;
    policy: string | null;
    score: number | null;
    checkedBy: string;
  }): Promise<MessageRow | null>;
  /**
   * What `viewerId` may see, oldest first (by time, then `seq`): everyone's delivered messages and the viewer's own in every status; with
   * `changedSince`, only rows changed after it, plus `removed` tombstones for others' messages hidden after delivery.
   * Without it, the newest `limit` (`hasMore`: older ones exist). `now` is the store's clock at the read.
   */
  listMessages(input: {
    conversationId: string;
    viewerId: string;
    changedSince?: Date | null;
    limit: number;
  }): Promise<{ messages: (MessageRow & { removed: boolean })[]; hasMore: boolean; now: Date }>;
  /**
   * The delivered messages a check reads, oldest first (by `sentAt`, then `seq`): the conversation's last `contextTurns`, and the sender's own
   * last `windowMax` within `windowMs`. With `before`, only those delivered at or before it.
   */
  recentTurns(input: {
    conversationId: string;
    senderId: string;
    contextTurns: number;
    windowMax: number;
    windowMs: number;
    before?: Date | null;
  }): Promise<{ turns: { participantId: string; body: string; sentAt: Date }[]; now: Date }>;
  /** Messages the participant stored, and sends refused, within `windowMs`: the daily limit's count. */
  countActivity(input: { participantId: string; windowMs: number }): Promise<number>;

  // --- events ---
  /** False when `dedupeKey` was already used: a one-shot claim. */
  appendEvent(event: EventInput & { dedupeKey?: string | null }): Promise<boolean>;
}
