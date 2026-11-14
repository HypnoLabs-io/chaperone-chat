/**
 * A policy is one yes/no question Jev answers about the newest message: what counts, what doesn't, the cutoffs that
 * turn its probability into an action, and the sentence a sender sees when it refuses. The contact policy ships
 * (`contactLeak`); `definePolicy` makes any other (harassment, payment outside the platform, personal data).
 *
 * What Jev is sent is neutral, whatever the host: turns labelled `sender` / `other`, never an id, alias, role or
 * brand, and the host's own names replaced with "this platform". So one calibration holds for every adopter.
 * Cutoffs carry the model and the question's fingerprint; when either differs from what is asked now, the policy is
 * uncalibrated and the check takes its fallback instead of guessing.
 */
import { ChaperoneError } from "../errors";
import { jevFingerprint, type JevQuestion } from "../jev/client";
import { alternation } from "./detector";
import type { ContactKind } from "./types";

export interface PolicyLine {
  /** Stable: labelled samples cite it. */
  readonly id: string;
  readonly text: string;
}

export interface Cutoffs {
  /** The Jev model the scores came from. */
  model: string;
  /** `policyFingerprint(policy, model)` when the scores were taken. */
  fingerprint: string;
  /** At or above: refused outright. */
  block: number;
  /** At or above, under `block`: refused, and the sender may send it again for review. */
  review: number;
}

export interface Policy {
  /** Short, stable, lowercase ("contact"): the question's name in Jev's request. */
  readonly id: string;
  /** The yes/no question about the latest message. */
  readonly question: string;
  readonly counts: readonly PolicyLine[];
  readonly doesntCount: readonly PolicyLine[];
  /** Null: uncalibrated. Jev isn't asked; the check takes its fallback. */
  readonly cutoffs: Cutoffs | null;
  /** What the sender sees when this policy refuses a message. */
  readonly reason: string;
  /** Rule kinds this policy turns off (the contact policy's `details-only` scope turns off `app` and `ask`). */
  readonly ruleKinds?: Readonly<Partial<Record<ContactKind, boolean>>>;
}

/**
 * The shapes of the state Jev can be sent: `1` the conversation as one list ending with the latest message (with
 * `latest_from`), `2` the earlier messages and the latest one apart. The calibration compares them;
 * `STATE_VERSION` is the one the chat uses. A change is a different question: every fingerprint moves with it.
 */
export const STATE_SHAPES = [1, 2] as const;
export type StateShape = (typeof STATE_SHAPES)[number];
export const STATE_VERSION: StateShape = 1;

const POLICY_ID = /^[a-z][a-z0-9_]{0,31}$/;

/** One list as the bullet text a question's criteria carry. */
export function bullets(lines: readonly { text: string }[]): string {
  return lines.map((line) => `- ${line.text}`).join("\n");
}

/** The policy as Jev's `noul` question. */
export function jevQuestionOf(policy: Policy): JevQuestion {
  return {
    type: "noul",
    instructions: policy.question,
    criteria: { true: bullets(policy.counts), false: bullets(policy.doesntCount) },
  };
}

/** The model, the state's shape and the question as one short hex string. */
export function policyFingerprint(policy: Policy, model: string, shape: StateShape = STATE_VERSION): string {
  return jevFingerprint(model, [shape, jevQuestionOf(policy)]);
}

/** Whether a policy's cutoffs belong to this model and this question, and make sense. */
export function calibrationOf(policy: Policy, model: string): "calibrated" | "uncalibrated" | "invalid" {
  const c = policy.cutoffs;
  if (!c || c.model !== model || c.fingerprint !== policyFingerprint(policy, model)) return "uncalibrated";
  const ok = Number.isFinite(c.review) && Number.isFinite(c.block) && 0 <= c.review && c.review <= c.block && c.block <= 1;
  return ok ? "calibrated" : "invalid";
}

export interface DefinePolicyInput {
  id: string;
  question: string;
  counts: readonly PolicyLine[];
  doesntCount: readonly PolicyLine[];
  cutoffs?: Cutoffs | null;
  reason: string;
}

/** A policy of your own. Calibrate it (`npx chaperone-chat calibrate --policy …`) before it can decide anything. */
export function definePolicy(input: DefinePolicyInput): Policy {
  const bad = (what: string) => new ChaperoneError("invalid_option", `policy ${JSON.stringify(input?.id)}: ${what}`);
  if (!input || typeof input.id !== "string" || !POLICY_ID.test(input.id)) throw bad("the id is lowercase letters, digits and _, 1-32 characters");
  if (typeof input.question !== "string" || !input.question.trim()) throw bad("needs a question");
  if (typeof input.reason !== "string" || !input.reason.trim()) throw bad("needs the reason a sender sees");
  for (const [name, list] of [["counts", input.counts], ["doesntCount", input.doesntCount]] as const) {
    if (!Array.isArray(list) || list.length === 0) throw bad(`${name} needs at least one line`);
    for (const line of list) if (!line || typeof line.id !== "string" || typeof line.text !== "string" || !line.text.trim()) throw bad(`${name} has a line without an id and text`);
  }
  const ids = [...input.counts, ...input.doesntCount].map((l) => l.id);
  if (new Set(ids).size !== ids.length) throw bad("line ids repeat");
  return {
    id: input.id,
    question: input.question.trim(),
    counts: input.counts.map((l) => ({ id: l.id, text: l.text.trim() })),
    doesntCount: input.doesntCount.map((l) => ({ id: l.id, text: l.text.trim() })),
    cutoffs: input.cutoffs ?? null,
    reason: input.reason.trim(),
  };
}

/** One turn as a judge reads it: the sender's own, or someone else's. */
export interface JudgeTurn {
  sender: boolean;
  text: string;
}

/** Replaces the host's own names with "this platform", so the question's words fit every host. */
export function platformSwapper(platformNames: readonly string[] = []): (text: string) => string {
  const names = alternation(platformNames);
  if (!names) return (text) => text;
  const re = new RegExp(String.raw`(?<![\w])(?:${names})(?![\w])`, "gi");
  return (text) => text.replace(re, "this platform");
}

/** The state Jev reads from the turns (oldest first, the judged one last): who wrote each is `sender` or `other`. */
export function jevState(
  turns: readonly JudgeTurn[],
  swap: (text: string) => string = (t) => t,
  shape: StateShape = STATE_VERSION,
): Record<string, unknown> {
  const said = turns.map((t) => ({ from: t.sender ? "sender" : "other", text: swap(t.text) }));
  if (shape === 2) {
    const latest = said[said.length - 1];
    return { earlier: said.slice(0, -1), latest: latest ? { from: "sender", text: latest.text } : null };
  }
  return { conversation: said, latest_from: "sender" };
}
