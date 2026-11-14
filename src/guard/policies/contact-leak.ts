/**
 * The built-in policy: a way to get in touch outside the chat. Two scopes (`./contact-lines.ts`):
 *
 * - `off-platform` (default): contact details, naming an app to move to, asking to move or to be looked up.
 * - `details-only`: only actual contact details count; the rules' `app` and `ask` kinds turn off with it.
 *
 * Its cutoffs come from the calibration on `corpus/contact.json` (`npx chaperone-chat calibrate`), one pair per
 * scope, for the pinned model. A scope that has none ships uncalibrated: the check takes its fallback.
 */
import type { Cutoffs, Policy } from "../policy";
import { contactLines, scopeKinds, type ContactScope } from "./contact-lines";

export const CONTACT_POLICY_ID = "contact";

export const CONTACT_QUESTIONS: Readonly<Record<ContactScope, string>> = {
  "off-platform":
    "Does the latest message, alone or together with the same sender's earlier messages, share or try to share a way " +
    "to contact them outside this platform, or ask for the other person's?",
  "details-only":
    "Does the latest message, alone or together with the same sender's earlier messages, share or try to share an " +
    "actual contact detail of theirs: an email address, a phone number, a link, a handle or a street address?",
};

export const CONTACT_REASON = "That looks like a way to get in touch outside this chat.";

/**
 * The measured cutoffs, by scope, with the model and the question's fingerprint they were measured under. A change
 * to the question or its lines changes the fingerprint, so the policy reads as uncalibrated (and a test fails) until
 * it is calibrated again.
 *
 * From `corpus/contact-scores.json` (595 samples and threads, state shape 1; `docs/calibration.md`): block sits a
 * margin above every clean message Jev reads, review a margin below every contact detail the rules miss but one (a
 * bare username with nothing around it, "I'm hikingwithdana everywhere."). Off-platform: no clean message refused
 * outright, 1.7% of them refused with an appeal. Details-only: none refused outright, 1.6% with an appeal.
 */
export const CONTACT_CUTOFFS: Readonly<Partial<Record<ContactScope, Cutoffs>>> = {
  "off-platform": { model: "jev-1.13.0", fingerprint: "6ce551c1", block: 0.5, review: 0.2 },
  "details-only": { model: "jev-1.13.0", fingerprint: "30250a75", block: 0.5, review: 0.25 },
};

export interface ContactLeakOptions {
  /** Default `off-platform`. */
  scope?: ContactScope;
  /** What the sender sees when Jev refuses. */
  reason?: string;
  /** Your own cutoffs (after calibrating another model or scope), or null to run uncalibrated. */
  cutoffs?: Cutoffs | null;
}

function base(scope: ContactScope, reason: string): Policy {
  const lines = contactLines(scope);
  return {
    id: CONTACT_POLICY_ID,
    question: CONTACT_QUESTIONS[scope],
    counts: lines.counts,
    doesntCount: lines.doesntCount,
    cutoffs: null,
    reason,
    ruleKinds: scopeKinds(scope),
  };
}

export function contactLeak(options: ContactLeakOptions = {}): Policy {
  const scope = options.scope ?? "off-platform";
  const policy = base(scope, options.reason ?? CONTACT_REASON);
  return { ...policy, cutoffs: options.cutoffs !== undefined ? options.cutoffs : (CONTACT_CUTOFFS[scope] ?? null) };
}
