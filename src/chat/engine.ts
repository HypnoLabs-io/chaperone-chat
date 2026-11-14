/**
 * The conversation engine: open a conversation, load a participant's view of it, send a message through the screen.
 * Every message is checked before it is stored or shown: the rules, the split-message pass over the sender's recent
 * messages, then Jev (`../guard/check.ts`). A refused message is never stored; a held one is stored and only its sender
 * sees it until it is checked again or a moderator decides. Every outcome records an event with ids and numbers,
 * never the text.
 */
import { ChaperoneError } from "../errors";
import type { Json } from "../store/types";
import { DAY, LINK_KIND, verdictMeta, type ChatContext, type LinkInfo } from "./context";
import { EVENT } from "./event-types";
import { outcomesFor } from "./lifecycle";
import { cleanText, newId, round3 } from "./util";
import {
  byPosition,
  conversationView,
  messageView,
  participantView,
  type ConversationView,
  type MessageView,
  type SendResult,
  type ThreadView,
} from "./views";

export { LINK_KIND, type LinkInfo } from "./context";

/** How far behind the store's clock a cursor starts, so a write that lands as a read runs is seen next time. */
export const CURSOR_OVERLAP_MS = 5_000;
const MAX_PARTICIPANTS = 50;

export interface OpenInput {
  /** Two or more. The package stores no contact details: `externalRef` is your own id for the person. */
  participants: readonly { role: string; alias: string; externalRef?: string | null }[];
  /** Overrides the chat's `durationMs` for this conversation; null for no deadline. */
  durationMs?: number | null;
  /** Your own data about the conversation. Stored, never shown to participants. */
  context?: Json;
  /** An idempotency key: opening twice with one key returns the first conversation (`created: false`). */
  key?: string | null;
}

export interface OpenResult {
  created: boolean;
  conversation: ConversationView;
  /** One per participant, in the order given. */
  links: LinkInfo[];
}

export type VerifyLink = { ok: true; participantId: string } | { ok: false; reason: "invalid_link" | "link_expired" };

function text(value: unknown, max: number, name: string, optional = false): string | null {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new ChaperoneError("invalid_input", `${name} must be text of 1-${max} characters`);
  }
  return value.trim();
}

export function createEngine(c: ChatContext) {
  const { r, store, guard, links } = c;

  return {
    async open(input: OpenInput): Promise<OpenResult> {
      if (!input || !Array.isArray(input.participants)) throw new ChaperoneError("invalid_input", "open needs participants");
      if (input.participants.length < 2 || input.participants.length > MAX_PARTICIPANTS) {
        throw new ChaperoneError("invalid_input", `a conversation has 2-${MAX_PARTICIPANTS} participants`);
      }
      const people = input.participants.map((p, i) => {
        const alias = text(p?.alias, 64, `participants[${i}].alias`) as string;
        // An alias is shown to everyone: it may not carry a way to get in touch.
        if (guard.rules.find(alias).length > 0) {
          throw new ChaperoneError("invalid_input", `participants[${i}].alias holds a contact detail`);
        }
        return {
          id: newId("p"),
          role: text(p?.role, 64, `participants[${i}].role`) as string,
          alias,
          externalRef: text(p?.externalRef, 256, `participants[${i}].externalRef`, true),
        };
      });
      const durationMs = input.durationMs === undefined ? r.durationMs : input.durationMs;
      if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0)) {
        throw new ChaperoneError("invalid_input", "durationMs must be above 0, or null for no deadline");
      }
      const key = text(input.key, 256, "key", true);
      let context: Json = input.context ?? {};
      try {
        context = JSON.parse(JSON.stringify(context)) as Json;
      } catch {
        throw new ChaperoneError("invalid_input", "context must be JSON");
      }

      const made = await store.createConversation({ id: newId("c"), key, deadlineInMs: durationMs, context, participants: people });
      const at = await store.now();
      if (made.created) {
        await c.event(EVENT.conversationOpened, made.conversation.id, null, { participants: made.participants.length });
      }
      const ctx = await store.getConversation(made.conversation.id);
      if (!ctx) throw new ChaperoneError("store_error", "the conversation just opened can't be read back");
      return {
        created: made.created,
        conversation: conversationView(ctx),
        links: await Promise.all(made.participants.map((p) => c.mint(p, made.conversation.deadline, at))),
      };
    },

    /** A fresh link for a participant (to send again); null when there is no such participant. */
    async link(participantId: string): Promise<LinkInfo | null> {
      const ctx = await store.getParticipantContext(participantId);
      if (!ctx) return null;
      return c.mint(ctx.participant, ctx.conversation.deadline, ctx.now);
    },

    /** The participant a link's token stands for. */
    async verify(token: unknown): Promise<VerifyLink> {
      const checked = await links.verify(token, LINK_KIND, await store.now());
      if (checked.ok) return { ok: true, participantId: checked.subject };
      return { ok: false, reason: checked.reason === "expired" ? "link_expired" : "invalid_link" };
    },

    /**
     * One participant's view. With `since` (a previous view's `cursor`), only what changed since. Marks the
     * participant's read unless `markRead` is false. Null when there is no such participant.
     */
    async load(participantId: string, options: { since?: string | null; markRead?: boolean } = {}): Promise<ThreadView | null> {
      const since = options.since ? new Date(options.since) : null;
      if (since && !Number.isFinite(since.getTime())) throw new ChaperoneError("invalid_input", "since must be a cursor from a view");
      const ctx = await store.getParticipantContext(participantId, { markRead: options.markRead !== false });
      if (!ctx) return null;
      const [list, votes] = await Promise.all([
        store.listMessages({ conversationId: ctx.conversation.id, viewerId: participantId, changedSince: since, limit: r.pageSize }),
        store.listVotes(ctx.conversation.id),
      ]);
      const people = new Map(ctx.participants.map((p) => [p.id, p]));
      const messages: MessageView[] = [];
      const removed: string[] = [];
      for (const m of list.messages) {
        if (m.removed) removed.push(m.id);
        else messages.push(messageView(m, participantId, people, r.notes));
      }
      messages.sort(byPosition);
      const last = list.messages[list.messages.length - 1];
      const more = Boolean(since && list.hasMore && last);
      // More changes waiting: carry on from the last one read (a millisecond back, so ties at its instant come again;
      // the client merges by id). Otherwise from the store's clock, a few seconds back.
      const cursor = more && last ? new Date(last.updatedAt.getTime() - 1) : new Date(list.now.getTime() - CURSOR_OVERLAP_MS);
      return {
        conversation: conversationView(ctx),
        you: participantView(ctx.participant),
        participants: ctx.participants.map(participantView),
        messages,
        removed,
        cursor: cursor.toISOString(),
        more,
        hasOlder: !since && list.hasMore,
        maxChars: r.maxChars,
        outcomes: ctx.open ? outcomesFor(r, ctx.participant.role) : [],
        voted: votes.filter((v) => v.participantId === participantId).map((v) => v.outcome),
      };
    },

    /** Send one message through the screen; with `appeal`, send a refused one again for review. */
    async send(participantId: string, raw: string, options: { appeal?: boolean } = {}): Promise<SendResult> {
      const body = cleanText(typeof raw === "string" ? raw : "");
      if (!body) return { ok: false, reason: "empty" };
      if (body.length > r.maxChars) return { ok: false, reason: "too_long" };

      const ctx = await store.getParticipantContext(participantId);
      if (!ctx) return { ok: false, reason: "not_found" };
      if (!ctx.open) return { ok: false, reason: "closed" };
      const conversationId = ctx.conversation.id;
      if (r.perParticipantPerDay !== null) {
        if ((await store.countActivity({ participantId, windowMs: DAY })) >= r.perParticipantPerDay) {
          return { ok: false, reason: "too_many" };
        }
      }
      const appeal = options.appeal === true;
      const verdict = await c.screen(conversationId, participantId, body, { appeal });
      const meta = verdictMeta(verdict, appeal);

      if (verdict.action === "refuse" || verdict.action === "appealable") {
        await c.event(EVENT.messageBlocked, conversationId, participantId, meta);
        return {
          ok: false,
          reason: "blocked",
          message: verdict.reason ?? guard.reasons.ask,
          ...(verdict.kind ? { kind: verdict.kind } : {}),
          appealable: verdict.action === "appealable",
        };
      }

      const held = verdict.action === "hold";
      const stored = await store.insertMessage({
        id: newId("m"),
        conversationId,
        participantId,
        body,
        status: held ? "held" : "sent",
        holdReason: held ? (verdict.holdReason ?? "unchecked") : null,
        policy: verdict.policy ?? null,
        score: round3(verdict.p),
        checkedBy: verdict.checkedBy,
      });
      if (!stored) return { ok: false, reason: "closed" };
      const type = held ? EVENT.messageHeld : verdict.observed ? EVENT.messageObserved : EVENT.messageSent;
      await c.event(type, conversationId, participantId, { ...meta, messageId: stored.id });
      const people = new Map(ctx.participants.map((p) => [p.id, p]));
      return { ok: true, message: messageView(stored, participantId, people, r.notes), held };
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
