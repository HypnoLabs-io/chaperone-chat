/**
 * The sweep: one call, run on a schedule (`startSweeper()`, or a cron calling `sweep()` on an edge runtime), that
 *
 * 1. closes conversations past their deadline (`expiredOutcome`, by "system");
 * 2. finishes closes whose host hook failed, asking it again;
 * 3. checks messages again that were held because Jev couldn't answer;
 * 4. sends notices: a new message (throttled, after a grace period, only if unread), a reminder before the deadline,
 *    a close, and at most once a day the host's alert that Jev's cap is spent or its calls keep failing;
 * 5. deletes messages after the retention period, and prunes old events.
 *
 * Every step is a claim in the store, so two sweeps that overlap (two servers, a slow run) do nothing twice.
 */
import type { NoticeKind, NoticeParams } from "../store/types";
import type { Notice, ParticipantNotice } from "./config";
import { DAY, type ChatContext } from "./context";
import { EVENT } from "./event-types";
import type { Lifecycle } from "./lifecycle";
import type { Moderation } from "./moderate";
import { newId } from "./util";

export interface SweepReport {
  expired: number;
  finished: number;
  retried: { sent: number; flagged: number; stillHeld: number };
  notices: { message: number; reminder: number; closed: number; trouble: number; failed: number };
  deleted: number;
  pruned: number;
}

export interface SweeperOptions {
  /** How often. Default every minute. */
  everyMs?: number;
  /** Told about a sweep that threw (the next one runs anyway). */
  onError?: (error: unknown) => void;
}

/** Jev's last this-many calls all failing is worth an alert. */
export const TROUBLE_STREAK = 5;
/** A call younger than this may still be in flight: it doesn't count as failed yet. */
const SETTLE_MS = 60_000;
/** A reminder isn't sent with less than this left. */
const REMINDER_MIN_LEFT_MS = 3_600_000;
/** Closed conversations older than this aren't told about (when notices are first turned on). */
const CLOSED_WITHIN_MS = 3 * DAY;

export function createSweep(c: ChatContext, lifecycle: Lifecycle, moderation: Moderation) {
  const { r, store } = c;

  /**
   * Records one notice. Under a daily budget it is claimed first (over it, nothing is sent, and the notice is left for
   * a later sweep); with none, it is recorded once the notice itself is claimed.
   */
  async function record(kind: string, conversationId: string | null, participantId: string | null): Promise<boolean> {
    const event = { id: newId("e"), type: EVENT.noticeSent, conversationId, participantId, meta: { kind } };
    const n = r.notify!;
    let recorded = true;
    if (n.maxPerDay === null) await store.appendEvent(event);
    else recorded = await store.claimEventUnderCap(event, { type: EVENT.noticeSent, max: n.maxPerDay, windowMs: DAY });
    if (recorded) await c.announce(event);
    return recorded;
  }
  const budgeted = () => r.notify!.maxPerDay !== null;

  async function deliver(notice: Notice, conversationId: string | null, participantId: string | null): Promise<boolean> {
    try {
      await r.notify!.send(notice);
      return true;
    } catch {
      await c.event(EVENT.noticeFailed, conversationId, participantId, { kind: notice.kind });
      return false;
    }
  }

  async function participantNotices(kind: NoticeKind, params: NoticeParams, limit: number): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const target of await store.findNoticeTargets(kind, { ...params, limit })) {
      if (budgeted() && !(await record(kind, target.conversationId, target.participantId))) break;
      if (!(await store.claimNotice(kind, target.participantId, params))) continue;
      if (!budgeted()) await record(kind, target.conversationId, target.participantId);
      const ctx = await store.getParticipantContext(target.participantId);
      if (!ctx) continue;
      const link = await c.mint(ctx.participant, ctx.conversation.deadline, ctx.now);
      const notice: ParticipantNotice = {
        kind,
        conversationId: ctx.conversation.id,
        participant: {
          id: ctx.participant.id,
          role: ctx.participant.role,
          alias: ctx.participant.alias,
          externalRef: ctx.participant.externalRef,
        },
        others: ctx.participants.filter((p) => p.id !== ctx.participant.id).map((p) => ({ role: p.role, alias: p.alias })),
        link: { token: link.token, expiresAt: link.expiresAt },
        msLeft: ctx.msLeft,
        outcome: ctx.conversation.outcome,
      };
      if (await deliver(notice, ctx.conversation.id, ctx.participant.id)) sent++;
      else failed++;
    }
    return { sent, failed };
  }

  /** The host's alert, at most once a day, when Jev's cap is spent or its last few calls all failed. */
  async function trouble(): Promise<{ sent: number; failed: number }> {
    if (!r.judge) return { sent: 0, failed: 0 };
    const health = await store.judgeHealth({ type: EVENT.jevCall, windowMs: DAY, streak: TROUBLE_STREAK, settleMs: SETTLE_MS });
    const why =
      r.dailyCap !== null && r.dailyCap > 0 && health.calls >= r.dailyCap
        ? "cap"
        : health.recent >= TROUBLE_STREAK && health.failed === health.recent
          ? "failing"
          : null;
    if (!why) return { sent: 0, failed: 0 };
    const alert = { id: newId("e"), type: EVENT.troubleAlert, meta: { why, calls: health.calls } };
    const claimed = await store.claimEventUnderCap(alert, { type: EVENT.troubleAlert, max: 1, windowMs: DAY });
    if (claimed) await c.announce(alert);
    if (!claimed || !(await record("trouble", null, null))) return { sent: 0, failed: 0 };
    const ok = await deliver({ kind: "trouble", why, calls: health.calls, cap: r.dailyCap, failedInARow: health.failed }, null, null);
    return ok ? { sent: 1, failed: 0 } : { sent: 0, failed: 1 };
  }

  async function sweep(options: { limit?: number } = {}): Promise<SweepReport> {
    const limit = options.limit ?? 100;
    const report: SweepReport = {
      expired: 0,
      finished: 0,
      retried: { sent: 0, flagged: 0, stillHeld: 0 },
      notices: { message: 0, reminder: 0, closed: 0, trouble: 0, failed: 0 },
      deleted: 0,
      pruned: 0,
    };

    report.expired = await lifecycle.expireDue(limit);
    report.finished = await lifecycle.finishStale({ olderThanMs: r.staleClosingMs, limit });

    if (r.judge) {
      for (const m of await store.listHeld({ holdReason: "unchecked", onlyOpen: true, limit })) {
        const outcome = await moderation.retry(m.id);
        if (outcome === "sent") report.retried.sent++;
        else if (outcome === "flagged") report.retried.flagged++;
        else if (outcome === "still_held") {
          report.retried.stillHeld++;
          // Jev is still down: the rest of the queue would fail the same way.
          break;
        }
      }
    }

    const n = r.notify;
    if (n) {
      const params: NoticeParams = {
        everyMs: n.everyMs,
        graceMs: n.graceMs,
        reminderBeforeMs: n.reminderBeforeMs ?? 0,
        reminderMinLeftMs: REMINDER_MIN_LEFT_MS,
        closedWithinMs: CLOSED_WITHIN_MS,
      };
      const kinds: NoticeKind[] = [];
      if (n.kinds.message) kinds.push("message");
      if (n.kinds.reminder && n.reminderBeforeMs !== null) kinds.push("reminder");
      if (n.kinds.closed) kinds.push("closed");
      for (const kind of kinds) {
        const done = await participantNotices(kind, params, limit);
        report.notices[kind] += done.sent;
        report.notices.failed += done.failed;
      }
      if (n.kinds.trouble) {
        const done = await trouble();
        report.notices.trouble += done.sent;
        report.notices.failed += done.failed;
      }
    }

    if (r.deleteMessagesAfterMs !== null) {
      report.deleted = await store.deleteMessagesAfterClose({ olderThanMs: r.deleteMessagesAfterMs, limit: limit * 10 });
    }
    if (r.pruneEventsAfterMs !== null) {
      report.pruned = await store.pruneEvents({ olderThanMs: r.pruneEventsAfterMs, limit: limit * 10 });
    }
    return report;
  }

  return {
    sweep,
    /**
     * Runs `sweep()` every `everyMs` in this process, never two at once. The timer doesn't keep Node alive. On an
     * edge runtime, call `sweep()` from a cron trigger instead.
     */
    startSweeper(options: SweeperOptions = {}): { stop(): void } {
      let running = false;
      const timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
          await sweep();
        } catch (error) {
          options.onError?.(error);
        } finally {
          running = false;
        }
      }, options.everyMs ?? 60_000);
      (timer as { unref?: () => void }).unref?.();
      return { stop: () => clearInterval(timer) };
    },
  };
}
