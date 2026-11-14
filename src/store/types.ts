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
  /** One message with whether its conversation is open (open and before its deadline). */
  getMessage(id: string): Promise<(MessageRow & { conversationOpen: boolean }) | null>;
  /** Every message of a conversation in every status, oldest first (a moderator's view). */
  listThread(input: { conversationId: string; limit: number }): Promise<MessageRow[]>;
  /**
   * Moves one message from a status (and, when given, a hold reason) to another, stamping `updatedAt`: one
   * conditional write, so of two racing moves only one lands. Null when it wasn't in `from` (or, with
   * `requireOpen`, its conversation wasn't open).
   */
  transitionMessage(input: TransitionInput): Promise<MessageRow | null>;
  /** Held messages, oldest first. */
  listHeld(filter: {
    holdReason?: HoldReason | null;
    /** Only in conversations still open and before their deadline. */
    onlyOpen?: boolean;
    conversationId?: string | null;
    limit: number;
  }): Promise<MessageRow[]>;
  /** Deletes the messages of conversations closed more than `olderThanMs` ago, up to `limit`; how many went. */
  deleteMessagesAfterClose(input: { olderThanMs: number; limit: number }): Promise<number>;

  // --- lifecycle ---
  /** Conversations a host's user takes part in (`externalRef`), and/or in a state, newest first. */
  listConversations(filter: {
    externalRef?: string | null;
    state?: ConversationState | null;
    limit: number;
  }): Promise<ConversationWithParticipants[]>;
  /** Deletes a conversation with its participants, messages and votes (events stay, holding no text). */
  deleteConversation(id: string): Promise<boolean>;
  /** Records a participant's vote for an outcome, only while the conversation is open: false when not recorded. */
  castVote(input: { conversationId: string; participantId: string; outcome: string }): Promise<boolean>;
  listVotes(conversationId: string): Promise<{ participantId: string; outcome: string; createdAt: Date }[]>;
  /**
   * The first step of closing: open → closing with the outcome and who closed it, only from open (and, with
   * `requireBeforeDeadline`, before the deadline). Of racing claims exactly one wins; the row, or null.
   */
  claimClose(input: {
    conversationId: string;
    outcome: string;
    by: string;
    requireBeforeDeadline: boolean;
  }): Promise<ConversationRow | null>;
  /** closing → closed, only for that outcome. */
  finishClose(input: { conversationId: string; outcome: string }): Promise<ConversationRow | null>;
  /** closing → open again (the host refused the close), only for that outcome. */
  revertClose(input: { conversationId: string; outcome: string }): Promise<boolean>;
  /** Open conversations past their deadline, the longest past first. */
  findExpired(limit: number): Promise<string[]>;
  /** Conversations left closing for longer than `olderThanMs` (a close whose host hook failed), oldest first. */
  findStaleClosing(input: { olderThanMs: number; limit: number }): Promise<{ id: string; outcome: string; by: string }[]>;

  // --- notices ---
  /**
   * Participants due a notice of `kind`, by the rules in `NoticeParams`, oldest conversation first. `message`: open,
   * past the throttle, with a delivered message from someone else that is older than the grace period, newer than
   * their read mark, and newer than what their last notice covered (its stamp less the grace period).
   */
  findNoticeTargets(
    kind: NoticeKind,
    params: NoticeParams & { limit: number },
  ): Promise<{ participantId: string; conversationId: string }[]>;
  /** Stamps the participant's notice of `kind` when it is still due: of racing claims exactly one wins. */
  claimNotice(kind: NoticeKind, participantId: string, params: NoticeParams): Promise<boolean>;

  // --- events ---
  /** False when `dedupeKey` was already used: a one-shot claim. */
  appendEvent(event: EventInput & { dedupeKey?: string | null }): Promise<boolean>;
  /**
   * Appends the event only while fewer than `max` events of `cap.type` (for `cap.participantId`, when given) were
   * written within `windowMs`: the count and the write are one statement. Under concurrency a cap may overshoot by
   * at most the number of racing claims.
   */
  claimEventUnderCap(
    event: EventInput,
    cap: { type: string; participantId?: string | null; max: number; windowMs: number },
  ): Promise<boolean>;
  /** Merges keys into an event's meta. */
  setEventMeta(id: string, meta: { [key: string]: Json }): Promise<void>;
  /**
   * Jev's health from its call events (`type`): calls within `windowMs`, and of the last `streak` calls older than
   * `settleMs` (a call in flight doesn't count), how many there are and how many never recorded a score (`meta.p`).
   */
  judgeHealth(input: { type: string; windowMs: number; streak: number; settleMs: number }): Promise<{
    calls: number;
    recent: number;
    failed: number;
  }>;
  /** Deletes events older than `olderThanMs`, up to `limit`; how many went. */
  pruneEvents(input: { olderThanMs: number; limit: number }): Promise<number>;
}

export interface TransitionInput {
  id: string;
  /** `holdReason` left out: any. */
  from: { status: MessageStatus; holdReason?: HoldReason | null };
  to: {
    status: MessageStatus;
    /** Left out: kept. */
    holdReason?: HoldReason | null;
    /** Delivered now: `sentAt` set to the store's clock. */
    stampSent?: boolean;
    /** The body cleared. */
    clearBody?: boolean;
    score?: number | null;
    policy?: string | null;
    checkedBy?: string;
  };
  requireOpen?: boolean;
}

/** `message`: new messages a participant hasn't read. `reminder`: the deadline is near. `closed`: it has closed. */
export type NoticeKind = "message" | "reminder" | "closed";

export interface NoticeParams {
  /** `message`: at most one notice per participant in this long. */
  everyMs: number;
  /** `message`: a message this new isn't noticed yet (a page that's open reads it within seconds). */
  graceMs: number;
  /** `reminder`: once the deadline is this close… */
  reminderBeforeMs: number;
  /** …and not with less than this left. */
  reminderMinLeftMs: number;
  /** `closed`: only conversations closed this recently. */
  closedWithinMs: number;
}
