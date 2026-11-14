/**
 * The full check on one message before it is delivered:
 *
 * 1. **The rules** on the new text. A hit refuses at once, no appeal, and Jev is never called (or paid).
 * 2. **The split-message pass:** the sender's own last few messages with the new one, for an email or a phone split
 *    across them.
 * 3. **Jev**, one request per policy, in parallel (a batch's shape moves scores, so adding a policy never shifts
 *    another's calibrated cutoffs). Each probability picks a band: at or above `block`, refused; at or above
 *    `review`, refused with an appeal (or, when the sender appeals, held for review); else sent.
 *
 * When Jev can't answer for a policy (none to call: the cap or no key; it failed; it answered nonsense; the policy
 * isn't calibrated for this model and question), the **fallback** decides that policy: `hold` (the default) keeps the
 * message for a later check, `send` lets the rules decide alone, `refuse` asks the sender to try again. The most
 * severe outcome across policies wins: refuse, then appealable, then hold, then send.
 *
 * **Observe mode** delivers everything and reports what enforcing would have done, for a safe rollout.
 *
 * Pure apart from awaiting the judge. Nothing here logs or keeps the text.
 */
import { contactLeak } from "./policies/contact-leak";
import { calibrationOf, jevQuestionOf, jevState, platformSwapper, type JudgeTurn, type Policy } from "./policy";
import { isJevError, type JevClient, type JevUsage } from "../jev/client";
import { createGuard, type Guard, type GuardOptions } from "./guard";
import type { ContactKind } from "./types";
import { DEFAULT_WINDOW, WINDOW_REASONS, type WindowKind } from "./window";

export type Action = "send" | "refuse" | "appealable" | "hold";
export type HoldReason = "appeal" | "unchecked" | "flagged";
/** Why Jev didn't decide: none to call, it failed, its answer can't be trusted, or the policy isn't calibrated. */
export type JudgeFailure = "unavailable" | "error" | "invalid" | "uncalibrated";

export type JudgeResult =
  | { ok: true; p: number; usage?: JevUsage }
  | { ok: false; failure: Exclude<JudgeFailure, "uncalibrated"> };

/** What scores a policy's question. Never throws: a failure is a result. */
export interface Judge {
  /** The model asked; a policy's cutoffs must belong to it. */
  readonly model: string;
  judge(policy: Policy, turns: readonly JudgeTurn[]): Promise<JudgeResult>;
}

/** Jev as a judge: one request per call, the policy's question, the neutral state. */
export function jevJudge(client: JevClient, options: { platformNames?: readonly string[] } = {}): Judge {
  const swap = platformSwapper(options.platformNames);
  return {
    model: client.model,
    async judge(policy, turns) {
      try {
        const answers = await client.ask({ state: jevState(turns, swap), questions: { [policy.id]: jevQuestionOf(policy) } });
        const p = answers.p[policy.id] as number;
        return { ok: true, p, ...(answers.usage ? { usage: answers.usage } : {}) };
      } catch (error) {
        if (isJevError(error) && error.failure === "no_key") return { ok: false, failure: "unavailable" };
        if (isJevError(error) && (error.failure === "malformed" || error.failure === "model_mismatch")) return { ok: false, failure: "invalid" };
        return { ok: false, failure: "error" };
      }
    },
  };
}

export interface CheckInput {
  /** The message being sent, already cleaned. */
  text: string;
  /** The sender's own earlier delivered messages within the window, oldest first (the split-message pass). */
  earlier?: readonly string[];
  /** The delivered messages before this one, oldest first, both sides (Jev's context). */
  context?: readonly JudgeTurn[];
  /** The sender is appealing a refusal: the review band holds the message for review instead. */
  appeal?: boolean;
}

export interface Bands {
  /** At or above `block`. Default `refuse`; `hold` keeps it for a moderator. */
  block?: "refuse" | "hold";
  /** At or above `review`. Default `appealable`; `hold` keeps it for a moderator; `send` delivers it. */
  review?: "appealable" | "hold" | "send";
}

export interface CheckOptions {
  /** The rules and their reasons. Default: the default guard. */
  guard?: Guard | GuardOptions;
  /** Jev (or another judge). Null: the rules alone, by intent. */
  judge: Judge | null;
  /** Default `[contactLeak()]`. */
  policies?: readonly Policy[];
  /** The split-message pass, or false. Default 5 earlier messages. */
  window?: { maxEarlier?: number } | false;
  /** How many earlier delivered messages Jev reads. Default 8. */
  contextTurns?: number;
  bands?: Bands;
  /** Whether a refusal in the review band may be sent again for review. Default true. */
  appeals?: boolean;
  /** When Jev can't decide a policy. Default `hold`. */
  fallback?: "hold" | "send" | "refuse";
  /** `observe` delivers everything and reports what `enforce` would have done. Default `enforce`. */
  mode?: "enforce" | "observe";
  /** Sentences a sender sees. */
  reasons?: { window?: Partial<Record<WindowKind, string>>; hold?: string; fallback?: string };
}

export interface Verdict {
  action: Action;
  /** The method's id (`rules`), `rules-window`, a policy's id, or `fallback`. */
  decidedBy: string;
  /** The rules' kind, when the rules decided. */
  kind?: ContactKind;
  /** The policy that decided, when one did. */
  policy?: string;
  /** The sentence the sender sees; null when it goes. */
  reason: string | null;
  /** The deciding probability: 1 for a rules refusal, the policy's score when Jev decided. */
  p?: number;
  /** Every policy's score that came back. */
  scores?: Record<string, number>;
  /** `rules`, or `rules+<model>` once Jev answered. Stored with the message. */
  checkedBy: string;
  holdReason?: HoldReason;
  /** Set when a fallback decided. */
  judgeFailure?: JudgeFailure;
  /** Jev's billable size, summed. */
  usage?: JevUsage;
  /** Observe mode: what enforcing would have done. The action is then `send`. */
  observed?: Omit<Verdict, "observed">;
}

export const DEFAULT_CONTEXT_TURNS = 8;
export const HOLD_REASON = "Waiting for a quick check before it's sent.";
export const FALLBACK_REASON = "We couldn't check that message just now. Please try again in a minute.";

const SEVERITY: Record<Action, number> = { refuse: 4, appealable: 3, hold: 2, send: 1 };

let defaultGuard: Guard | undefined;
function guardOf(value: Guard | GuardOptions | undefined): Guard {
  if (!value) return (defaultGuard ??= createGuard());
  return typeof (value as Guard).scan === "function" ? (value as Guard) : createGuard(value as GuardOptions);
}

interface Outcome {
  action: Action;
  policy: Policy;
  p?: number;
  failure?: JudgeFailure;
  holdReason?: HoldReason;
}

async function enforce(input: CheckInput, options: CheckOptions, guard: Guard): Promise<Verdict> {
  // 1. The rules on the new text.
  const scan = await guard.scan(input.text);
  const kind = scan.kinds[0];
  if (kind) return { action: "refuse", decidedBy: scan.scrubberId, kind, reason: guard.reasons[kind], p: 1, checkedBy: "rules" };

  // 2. The split-message pass.
  if (options.window !== false) {
    const maxEarlier = options.window?.maxEarlier ?? DEFAULT_WINDOW.maxEarlier;
    const windowKind = guard.windowKinds(input.earlier ?? [], input.text, maxEarlier)[0];
    if (windowKind) {
      const reason = options.reasons?.window?.[windowKind] ?? WINDOW_REASONS[windowKind];
      return { action: "refuse", decidedBy: "rules-window", kind: windowKind, reason, p: 1, checkedBy: "rules" };
    }
  }

  // 3. Jev, one request per policy.
  const judge = options.judge;
  const policies = options.policies ?? [contactLeak()];
  if (!judge || policies.length === 0) return { action: "send", decidedBy: "rules", reason: null, checkedBy: "rules" };
  const contextTurns = options.contextTurns ?? DEFAULT_CONTEXT_TURNS;
  const turns: JudgeTurn[] = [...(contextTurns > 0 ? (input.context ?? []).slice(-contextTurns) : []), { sender: true, text: input.text }];
  const fallback = options.fallback ?? "hold";
  const appeals = options.appeals !== false;
  const bands = { block: options.bands?.block ?? "refuse", review: options.bands?.review ?? "appealable" };

  const results = await Promise.all(
    policies.map(async (policy): Promise<{ policy: Policy; result: JudgeResult | { ok: false; failure: JudgeFailure } }> => {
      const calibration = calibrationOf(policy, judge.model);
      if (calibration !== "calibrated") return { policy, result: { ok: false, failure: calibration } };
      try {
        const result = await judge.judge(policy, turns);
        if (result.ok && !(typeof result.p === "number" && Number.isFinite(result.p) && result.p >= 0 && result.p <= 1)) {
          return { policy, result: { ok: false, failure: "invalid" } };
        }
        return { policy, result };
      } catch {
        return { policy, result: { ok: false, failure: "error" } };
      }
    }),
  );

  const scores: Record<string, number> = {};
  let usage: JevUsage | undefined;
  const outcomes: Outcome[] = results.map(({ policy, result }) => {
    if (!result.ok) {
      const action: Action = fallback === "send" ? "send" : fallback === "refuse" ? "refuse" : "hold";
      return { action, policy, failure: result.failure, ...(action === "hold" ? { holdReason: "unchecked" as const } : {}) };
    }
    scores[policy.id] = result.p;
    if ("usage" in result && result.usage) {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + result.usage.inputTokens,
        outputTokens: (usage?.outputTokens ?? 0) + result.usage.outputTokens,
      };
    }
    const c = policy.cutoffs!;
    if (result.p >= c.block) {
      return bands.block === "hold"
        ? { action: "hold", policy, p: result.p, holdReason: "flagged" }
        : { action: "refuse", policy, p: result.p };
    }
    if (result.p >= c.review) {
      if (input.appeal && appeals && bands.review === "appealable") return { action: "hold", policy, p: result.p, holdReason: "appeal" };
      if (bands.review === "hold") return { action: "hold", policy, p: result.p, holdReason: "flagged" };
      if (bands.review === "send") return { action: "send", policy, p: result.p };
      return { action: appeals ? "appealable" : "refuse", policy, p: result.p };
    }
    return { action: "send", policy, p: result.p };
  });

  // The most severe outcome wins; the first policy breaks a tie.
  const top = outcomes.reduce((a, b) => (SEVERITY[b.action] > SEVERITY[a.action] ? b : a));
  const answered = Object.keys(scores).length > 0;
  const failure = outcomes.find((o) => o.failure)?.failure;
  const verdict: Verdict = {
    action: top.action,
    decidedBy: top.failure ? "fallback" : top.policy.id,
    policy: top.policy.id,
    reason:
      top.action === "send"
        ? null
        : top.action === "hold"
          ? (options.reasons?.hold ?? HOLD_REASON)
          : top.failure
            ? (options.reasons?.fallback ?? FALLBACK_REASON)
            : top.policy.reason,
    checkedBy: answered ? `rules+${judge.model}` : "rules",
    ...(top.p !== undefined ? { p: top.p } : {}),
    ...(answered ? { scores } : {}),
    ...(top.holdReason ? { holdReason: top.holdReason } : {}),
    ...(failure ? { judgeFailure: failure } : {}),
    ...(usage ? { usage } : {}),
  };
  return verdict;
}

export async function check(input: CheckInput, options: CheckOptions): Promise<Verdict> {
  const guard = guardOf(options.guard);
  const verdict = await enforce(input, options, guard);
  if (options.mode !== "observe" || verdict.action === "send") return verdict;
  const { action: _action, reason: _reason, holdReason: _hold, ...rest } = verdict;
  return { ...rest, action: "send", reason: null, observed: verdict };
}
