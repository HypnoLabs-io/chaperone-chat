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
 * it is calibrated again. Empty until calibrated.
 */
export const CONTACT_CUTOFFS: Readonly<Partial<Record<ContactScope, Cutoffs>>> = {};

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
