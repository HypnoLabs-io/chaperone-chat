/**
 * What a participant reads: aliases and roles only (never an `externalRef`, never the host's `context`), everyone's
 * delivered messages, and their own in every status with a note on the ones that weren't delivered. A message held
 * or refused is never shown to the others, so they never learn it existed.
 */
import type { ContactKind } from "../guard/types";
import type { ConversationState, MessageRow, MessageStatus, ParticipantContext, ParticipantRow } from "../store/types";
import type { Notes } from "./config";

export interface ParticipantView {
  id: string;
  role: string;
  alias: string;
}

export interface MessageView {
  id: string;
  /** The sender's participant id. */
  from: string;
  alias: string;
  role: string;
  /** Sent by the participant reading. */
  mine: boolean;
  /** Null on the reader's own refused or hidden message. */
  body: string | null;
  status: MessageStatus;
  /** On the reader's own message that wasn't delivered: what happened to it. */
  note: string | null;
  /** When it was delivered, or written when it wasn't (ISO). */
  at: string;
}

export interface ConversationView {
  id: string;
  state: ConversationState;
  /** Open and before its deadline: sending works. */
  open: boolean;
  outcome: string | null;
  /** ISO, or null with no deadline. */
  deadline: string | null;
  msLeft: number | null;
}

export interface ThreadView {
  conversation: ConversationView;
  you: ParticipantView;
  participants: ParticipantView[];
  /** Oldest first. With `since`, only what changed. */
  messages: MessageView[];
  /** Ids of messages to drop from the screen (hidden by a moderator after delivery). */
  removed: string[];
  /** Pass back as `since` to get only what changed. */
  cursor: string;
  /** More changes are waiting: load again now with `cursor`. */
  more: boolean;
  /** A first load: older messages exist than the ones returned. */
  hasOlder: boolean;
  maxChars: number;
}

export type SendRefusal =
  /** No such participant. */
  | "not_found"
  /** The conversation isn't open: closed, closing, or past its deadline. */
  | "closed"
  /** Nothing left after cleaning. */
  | "empty"
  /** Over the length limit. */
  | "too_long"
  /** Over the participant's daily message limit. */
  | "too_many"
  /** The screen refused it; `appealable` says whether the sender may send it again for review. */
  | "blocked";

export type SendResult =
  | { ok: true; message: MessageView; held: boolean }
  | { ok: false; reason: SendRefusal; message?: string; kind?: ContactKind; appealable?: boolean };

export function participantView(p: ParticipantRow): ParticipantView {
  return { id: p.id, role: p.role, alias: p.alias };
}

export function conversationView(ctx: Pick<ParticipantContext, "conversation" | "open" | "msLeft">): ConversationView {
  const c = ctx.conversation;
  return {
    id: c.id,
    state: c.state,
    open: ctx.open,
    outcome: c.outcome,
    deadline: c.deadline ? c.deadline.toISOString() : null,
    msLeft: ctx.msLeft,
  };
}

export function messageView(
  m: MessageRow,
  viewerId: string,
  people: ReadonlyMap<string, ParticipantRow>,
  notes: Notes,
): MessageView {
  const mine = m.participantId === viewerId;
  const sender = people.get(m.participantId);
  const delivered = m.status === "sent";
  return {
    id: m.id,
    from: m.participantId,
    alias: sender?.alias ?? "",
    role: sender?.role ?? "",
    mine,
    body: m.status === "refused" || m.status === "hidden" ? null : m.body,
    status: m.status,
    note: !mine || delivered ? null : notes[m.status as keyof Notes] ?? null,
    at: (m.sentAt ?? m.createdAt).toISOString(),
  };
}

/** Oldest first by when it reached the thread. Stable: ties keep the store's order (its insertion order). */
export function byPosition(a: MessageView, b: MessageView): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}
