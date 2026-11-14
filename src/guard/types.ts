/**
 * The guard's contract. A method only finds; the guard decides what a finding means (refuse a chat message, cut a
 * sentence from a profile, blank a field). So another method (a hosted moderation API, a model) is one object with an
 * `id` and a `find`, and nothing that calls the guard changes.
 */

/** Most specific first: a text with several kinds is reported by the first one here. */
export const CONTACT_KINDS = ["email", "phone", "link", "handle", "address", "app", "ask"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export function isContactKind(value: unknown): value is ContactKind {
  return typeof value === "string" && (CONTACT_KINDS as readonly string[]).includes(value);
}

/** What a sender is told, by kind. Each can be overridden (`reasons`). */
export const KIND_REASONS: Readonly<Record<ContactKind, string>> = {
  email: "That looks like an email address.",
  phone: "That looks like a phone number.",
  link: "That looks like a link or a web address.",
  handle: "That looks like a username or a handle.",
  address: "That looks like a street address.",
  app: "That names an app or site for talking or paying outside this chat.",
  ask: "That asks to move the conversation elsewhere.",
};

/**
 * One contact detail a method found. `start` / `end` are UTF-16 offsets into the text it was given, end exclusive.
 * Left out when the method can't say where (a model's verdict, a match on a rewritten copy): a field holding a
 * finding that can't be cut is blanked whole.
 */
export interface Finding {
  kind: ContactKind;
  start?: number;
  end?: number;
}

/** A way of finding contact details. The rules are one; `combine` runs several as one. */
export interface Scrubber {
  /** Short and stable ("rules"). Recorded with a refusal, so a block can be traced to the method that made it. */
  readonly id: string;
  /** Every contact detail in `text`; empty when clean. May throw: the guard then falls back to the rules. */
  find(text: string): Finding[] | Promise<Finding[]>;
}
