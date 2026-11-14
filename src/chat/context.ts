/**
 * What every part of the engine shares: the resolved options, events (recorded, then handed to `onEvent`), links,
 * and the screen (the rules, the split-message pass, then Jev under its daily cap).
 */
import { check, type Judge, type Verdict } from "../guard/check";
import type { Json, ParticipantRow } from "../store/types";
import type { ChatEvent, Resolved } from "./config";
import { EVENT } from "./event-types";
import { newId, round3 } from "./util";

/** The link kind a participant's token carries. */
export const LINK_KIND = "chat";
export const DAY = 86_400_000;

export interface LinkInfo {
  participantId: string;
  role: string;
  alias: string;
  externalRef: string | null;
  /** The signed token. Put it in a URL fragment: `${page}#t=${token}`. */
  token: string;
  expiresAt: Date;
}

/** What a send's event records: what decided and how, never the text. */
export function verdictMeta(verdict: Verdict, appeal: boolean): { [key: string]: Json } {
  return {
    action: verdict.observed?.action ?? verdict.action,
    decidedBy: verdict.observed?.decidedBy ?? verdict.decidedBy,
    kind: verdict.observed?.kind ?? verdict.kind ?? null,
    policy: verdict.observed?.policy ?? verdict.policy ?? null,
    p: round3(verdict.observed?.p ?? verdict.p),
    checkedBy: verdict.checkedBy,
    appeal,
    judgeFailure: verdict.observed?.judgeFailure ?? verdict.judgeFailure ?? null,
    ...(verdict.observed ? { observed: true } : {}),
  };
}

export function createContext(r: Resolved) {
  const { store, links } = r;

  async function event(type: string, conversationId: string | null, participantId: string | null, meta: Json = {}): Promise<void> {
    const id = newId("e");
    await store.appendEvent({ id, type, conversationId, participantId, meta });
    if (r.hooks.onEvent) {
      const e: ChatEvent = { id, type, conversationId, participantId, meta, at: new Date() };
      try {
        await r.hooks.onEvent(e);
      } catch {
        // The action has happened; a failing listener doesn't undo it.
      }
    }
  }

  function linkExpiry(deadline: Date | null, now: Date): Date {
    return deadline ? new Date(deadline.getTime() + r.linkGraceMs) : new Date(now.getTime() + r.linkTtlMs);
  }

  async function mint(p: ParticipantRow, deadline: Date | null, now: Date): Promise<LinkInfo> {
    const expiresAt = linkExpiry(deadline, now);
    const token = await links.sign({ kind: LINK_KIND, subject: p.id, expiresAt, now });
    return { participantId: p.id, role: p.role, alias: p.alias, externalRef: p.externalRef, token, expiresAt };
  }

  /** Jev, claiming one call under the daily cap before each request and recording its score (never the text). */
  function cappedJudge(conversationId: string, participantId: string): Judge | null {
    const base = r.judge;
    if (!base) return null;
    return {
      model: base.model,
      async judge(policy, turns) {
        const call = { id: newId("e"), type: EVENT.jevCall, conversationId, participantId, meta: { policy: policy.id } };
        let claimed = false;
        try {
          claimed =
            r.dailyCap === null
              ? await store.appendEvent(call)
              : await store.claimEventUnderCap(call, { type: EVENT.jevCall, max: r.dailyCap, windowMs: DAY });
        } catch {
          claimed = false;
        }
        // A spent or unreadable cap: no call, and the fallback decides.
        if (!claimed) return { ok: false, failure: "unavailable" };
        const result = await base.judge(policy, turns);
        const recorded: { [key: string]: Json } = result.ok
          ? { p: round3(result.p), model: base.model, ...(result.usage ? { usage: { ...result.usage } } : {}) }
          : { failure: result.failure };
        await store.setEventMeta(call.id, recorded).catch(() => undefined);
        return result;
      },
    };
  }

  /**
   * The check on one message: the rules, the split-message pass over the sender's recent messages, then Jev. With
   * `before` (a held message checked again), the conversation as it stood then: what was delivered by that time, and
   * that time as the window's clock.
   */
  async function screen(
    conversationId: string,
    participantId: string,
    text: string,
    options: { appeal?: boolean; before?: Date } = {},
  ): Promise<Verdict> {
    const contextTurns = r.judge ? r.contextTurns : 0;
    let earlier: string[] = [];
    let context: { sender: boolean; text: string }[] = [];
    if (r.window || contextTurns > 0) {
      const recent = await store.recentTurns({
        conversationId,
        senderId: participantId,
        contextTurns,
        windowMax: r.window?.maxEarlier ?? 0,
        windowMs: r.window?.windowMs ?? 0,
        before: options.before ?? null,
      });
      if (r.window) {
        const since = (options.before ?? recent.now).getTime() - r.window.windowMs;
        earlier = recent.turns
          .filter((t) => t.participantId === participantId && t.sentAt.getTime() >= since)
          .map((t) => t.body)
          .slice(-r.window.maxEarlier);
      }
      if (contextTurns > 0) {
        context = recent.turns.slice(-contextTurns).map((t) => ({ sender: t.participantId === participantId, text: t.body }));
      }
    }
    return check(
      { text, earlier, context, appeal: options.appeal === true },
      {
        guard: r.guard,
        judge: cappedJudge(conversationId, participantId),
        policies: r.policies,
        window: r.window ? { maxEarlier: r.window.maxEarlier } : false,
        contextTurns,
        bands: r.bands,
        appeals: r.appeals,
        fallback: r.fallback,
        mode: r.mode,
        reasons: { window: r.windowReasons, hold: r.notes.held },
      },
    );
  }

  return { r, store, guard: r.guard, links, event, mint, screen };
}

export type ChatContext = ReturnType<typeof createContext>;
