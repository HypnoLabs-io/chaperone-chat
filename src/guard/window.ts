/**
 * The split-message pass: the sender's recent messages read together, for a phone number or an email split across
 * them ("it's a 312" … "555" … "0142"). Every earlier message passed the rules on its own, so what the rules find in
 * the joined text crosses a message boundary. Only an email or a phone refuses here; other kinds across messages are
 * left to Jev, which reads the conversation too. A phone counts only with its area code: "Math was 680." and "1450
 * overall." would read as a seven-digit number.
 */
import type { Rules } from "./rules";
import { CONTACT_KINDS, type ContactKind } from "./types";

export const WINDOW_KINDS = ["email", "phone"] as const satisfies readonly ContactKind[];
export type WindowKind = (typeof WINDOW_KINDS)[number];

/** What the sender is told: the message is fine alone, so the sentence says it's the run of them. */
export const WINDOW_REASONS: Readonly<Record<WindowKind, string>> = {
  email: "Together with your last few messages, that reads as an email address.",
  phone: "Together with your last few messages, that reads as a phone number.",
};

export interface WindowOptions {
  /** How many of the sender's own earlier messages are read with the new one. Default 5. */
  maxEarlier?: number;
  /** How far back they may go, in hours. Default 24. (The caller picks the messages; the chat applies this.) */
  hours?: number;
}

export const DEFAULT_WINDOW: Required<WindowOptions> = { maxEarlier: 5, hours: 24 };

function windowKindsIn(rules: Rules, text: string): Set<WindowKind> {
  const found = new Set<WindowKind>();
  for (const f of rules.find(text, { fullPhonesOnly: true })) {
    if (f.kind === "email" || f.kind === "phone") found.add(f.kind);
  }
  return found;
}

/**
 * The email or phone that `text` completes, read after `earlier` (the sender's own messages, oldest first, already
 * limited to the window's hours; only the last `maxEarlier` are read). Most specific first; empty when it completes
 * none. A detail the earlier messages already make on their own is not the new message's, so only what the new one
 * adds counts.
 */
export function windowKinds(
  rules: Rules,
  earlier: readonly string[],
  text: string,
  maxEarlier: number = DEFAULT_WINDOW.maxEarlier,
): WindowKind[] {
  const before = earlier.slice(-Math.max(0, maxEarlier)).filter((t) => t.trim() !== "");
  if (maxEarlier <= 0 || before.length === 0 || !text.trim()) return [];
  const had = windowKindsIn(rules, before.join(" "));
  const has = windowKindsIn(rules, [...before, text].join(" "));
  return CONTACT_KINDS.filter((k): k is WindowKind => (k === "email" || k === "phone") && has.has(k) && !had.has(k));
}
