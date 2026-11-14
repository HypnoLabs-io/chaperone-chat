/**
 * How a conversation ends. An outcome names who may choose it and whether one vote closes or every one must agree
 * (`outcomes`). Closing is two steps around the host's `beforeClose` hook: the close is claimed (open → closing, so
 * of two racing closes one wins), the hook runs, then the close finishes (closed) or, when the hook refuses, the
 * conversation opens again. A hook that throws leaves it closing, and the sweep finishes it later. Past its deadline a
 * conversation closes with `expiredOutcome`, by "system".
 */
import type { Resolved } from "./config";
import type { ChatContext } from "./context";
import { EVENT } from "./event-types";
import { participantView, type ParticipantView } from "./views";

export type ResolveResult =
  | {
      ok: true;
      /** `closed`; `closing` (the host's side will finish it); `waiting` for others to choose the same. */
      state: "closed" | "closing" | "waiting";
      outcome: string;
      /** For `waiting`: who hasn't chosen it yet. */
      waitingFor?: ParticipantView[];
    }
  | {
      ok: false;
      reason: "not_found" | "closed" | "unknown_outcome" | "not_allowed" | "refused";
      /** For `refused`: the host's words, if it gave any. */
      message?: string;
    };

export type CloseResult =
  | { ok: true; state: "closed" | "closing"; outcome: string }
  | { ok: false; reason: "not_found" | "closed" | "unknown_outcome" | "refused"; message?: string };

/** The outcomes a role may choose. */
export function outcomesFor(r: Resolved, role: string): string[] {
  return Object.entries(r.outcomes)
    .filter(([, rule]) => rule.by === "*" || rule.by.includes(role))
    .map(([name]) => name);
}

type Settled = "closed" | "closing" | { refused: string | null };

export function createLifecycle(c: ChatContext) {
  const { r, store } = c;

  /** After a claimed close: the host's hook, then finish, or open again on a refusal. */
  async function settle(conversationId: string, outcome: string, by: string): Promise<Settled> {
    const ctx = await store.getConversation(conversationId);
    if (!ctx) return "closed";
    if (r.hooks.beforeClose) {
      let answer: Awaited<ReturnType<NonNullable<typeof r.hooks.beforeClose>>>;
      try {
        const votes = await store.listVotes(conversationId);
        answer = await r.hooks.beforeClose({
          conversation: {
            id: ctx.conversation.id,
            key: ctx.conversation.key,
            context: ctx.conversation.context,
            deadline: ctx.conversation.deadline,
            createdAt: ctx.conversation.createdAt,
          },
          outcome,
          by,
          participants: ctx.participants.map((p) => ({ id: p.id, role: p.role, alias: p.alias, externalRef: p.externalRef })),
          votes: votes.map((v) => ({ participantId: v.participantId, outcome: v.outcome })),
        });
      } catch {
        await c.event(EVENT.closeFailed, conversationId, null, { outcome, by });
        return "closing";
      }
      if (answer === false || (answer && typeof answer === "object" && "refuse" in answer)) {
        await store.revertClose({ conversationId, outcome });
        await c.event(EVENT.conversationReopened, conversationId, null, { outcome, by });
        return { refused: answer && typeof answer === "object" && typeof answer.refuse === "string" ? answer.refuse : null };
      }
    }
    if (await store.finishClose({ conversationId, outcome })) {
      await c.event(EVENT.conversationClosed, conversationId, null, { outcome, by });
      return "closed";
    }
    // Finished, or opened again, by someone else in between.
    const now = await store.getConversation(conversationId);
    return now?.conversation.state === "closing" ? "closing" : "closed";
  }

  /** Claims a close and settles it; null when it couldn't be claimed. `participantId` when a participant closed it. */
  async function closeNow(
    conversationId: string,
    outcome: string,
    by: string,
    requireBeforeDeadline: boolean,
    participantId: string | null = null,
  ): Promise<Settled | null> {
    const claimed = await store.claimClose({ conversationId, outcome, by, requireBeforeDeadline });
    if (!claimed) return null;
    await c.event(EVENT.conversationClosing, conversationId, participantId, { outcome, by });
    return settle(conversationId, outcome, by);
  }

  /** What a close that couldn't be claimed means: another close of the same outcome under way, or none. */
  async function afterLostClaim(conversationId: string, outcome: string): Promise<"closed" | "closing" | null> {
    const now = await store.getConversation(conversationId);
    if (!now || now.conversation.outcome !== outcome) return null;
    return now.conversation.state === "closed" ? "closed" : now.conversation.state === "closing" ? "closing" : null;
  }

  return {
    /** A participant chooses an outcome; the conversation closes once the outcome's rule is met. */
    async resolve(participantId: string, outcome: string): Promise<ResolveResult> {
      const ctx = await store.getParticipantContext(participantId);
      if (!ctx) return { ok: false, reason: "not_found" };
      const rule = r.outcomes[outcome];
      if (!rule) return { ok: false, reason: "unknown_outcome" };
      const allowed = (role: string) => rule.by === "*" || rule.by.includes(role);
      if (!allowed(ctx.participant.role)) return { ok: false, reason: "not_allowed" };
      const cid = ctx.conversation.id;
      if (!ctx.open) {
        const lost = await afterLostClaim(cid, outcome);
        return lost ? { ok: true, state: lost, outcome } : { ok: false, reason: "closed" };
      }
      if (await store.castVote({ conversationId: cid, participantId, outcome })) {
        await c.event(EVENT.voteCast, cid, participantId, { outcome });
      }
      if (rule.requires === "all") {
        const votes = await store.listVotes(cid);
        const chose = new Set(votes.filter((v) => v.outcome === outcome).map((v) => v.participantId));
        const waiting = ctx.participants.filter((p) => allowed(p.role) && !chose.has(p.id));
        if (waiting.length > 0) return { ok: true, state: "waiting", outcome, waitingFor: waiting.map(participantView) };
      }
      const settled = await closeNow(cid, outcome, participantId, true, participantId);
      if (settled === null) {
        const lost = await afterLostClaim(cid, outcome);
        return lost ? { ok: true, state: lost, outcome } : { ok: false, reason: "closed" };
      }
      if (typeof settled === "object") return { ok: false, reason: "refused", ...(settled.refused ? { message: settled.refused } : {}) };
      return { ok: true, state: settled, outcome };
    },

    /** The host or a moderator closes a conversation with any outcome it knows, deadline or not. */
    async close(conversationId: string, outcome: string, options: { by?: string } = {}): Promise<CloseResult> {
      if (!r.outcomes[outcome] && outcome !== r.expiredOutcome) return { ok: false, reason: "unknown_outcome" };
      const ctx = await store.getConversation(conversationId);
      if (!ctx) return { ok: false, reason: "not_found" };
      const settled = await closeNow(conversationId, outcome, options.by ?? "moderator", false);
      if (settled === null) {
        const lost = await afterLostClaim(conversationId, outcome);
        return lost ? { ok: true, state: lost, outcome } : { ok: false, reason: "closed" };
      }
      if (typeof settled === "object") return { ok: false, reason: "refused", ...(settled.refused ? { message: settled.refused } : {}) };
      return { ok: true, state: settled, outcome };
    },

    /** The sweep's part: close what is past its deadline. How many closed. */
    async expireDue(limit: number): Promise<number> {
      let closed = 0;
      for (const id of await store.findExpired(limit)) {
        if ((await closeNow(id, r.expiredOutcome, "system", false)) === "closed") closed++;
      }
      return closed;
    },

    /** The sweep's part: finish closes whose hook failed, asking it again. How many finished. */
    async finishStale(input: { olderThanMs: number; limit: number }): Promise<number> {
      let closed = 0;
      for (const s of await store.findStaleClosing(input)) {
        if ((await settle(s.id, s.outcome, s.by)) === "closed") closed++;
      }
      return closed;
    },
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
