/**
 * What counts as sharing a way to get in touch: the one definition the built-in contact policy is built from. Three
 * things read it: Jev's question (its criteria are these lines), the rules' scope (`details-only` turns the app and
 * ask kinds off), and the sample corpus (`corpus/contact.json`), where every sample cites the line it tests. So the
 * corpus relabels itself for either scope.
 *
 * Two scopes:
 * - `off-platform` (the default): contact details, naming an app to move to, asking to move or to be looked up.
 * - `details-only`: only actual contact details count; for products that don't mind people saying "let's talk on the
 *   phone", only the number itself.
 */

export interface Line {
  /** Stable: a sample cites it. */
  readonly id: string;
  readonly text: string;
}

export const CONTACT_SCOPES = ["off-platform", "details-only"] as const;
export type ContactScope = (typeof CONTACT_SCOPES)[number];

/** The lines that always count: an actual contact detail. */
export const DETAIL_LINES: readonly Line[] = [
  {
    id: "email-phone",
    text:
      "An email address or phone number, whole or split across messages, including spelled-out, spaced-out, " +
      'misspelled and disguised forms ("jsmith at gee mail", "eight six seven…", "555 . 0199").',
  },
  { id: "link", text: "A link, web address or domain." },
  { id: "handle", text: "A username or social handle." },
  { id: "address", text: "A street address." },
];

/** The lines that count under `off-platform` only: moving elsewhere, or asking to. */
export const MOVE_LINES: readonly Line[] = [
  {
    id: "app",
    text: 'The name of an app or site to talk, meet or pay on instead, video calls included ("Zoom or Google Meet works").',
  },
  {
    id: "ask-elsewhere",
    text: 'Asking to move the conversation or the payment off this platform ("text me", "let\'s take this offline").',
  },
  { id: "ask-contact", text: "Asking the other person for their number, email, handle or last name." },
  {
    id: "ask-lookup",
    text: 'Asking to be searched for or looked up ("Google me", "search my name", "look me up on LinkedIn").',
  },
];

/** The lines that never count. */
export const ALLOWED_LINES: readonly Line[] = [
  {
    id: "logistics",
    text:
      "Prices, rates and budgets, times, days and dates, quantities, online or in person, and general areas: a city, " +
      "a neighborhood, a cross street or a transit line, and travel time.",
  },
  {
    id: "subject",
    text: "What the conversation is about: the need, the item, service or role, and who it is for (ages, levels, requirements).",
  },
  { id: "background", text: "A person's first name, experience, qualifications, education or employer." },
  { id: "name", text: "A full name or business name, stated without asking to be looked up." },
  { id: "passing", text: 'An app or site named in passing ("I found you on Instagram").' },
  { id: "here", text: "Arranging the next step here, on this platform." },
  { id: "conversation", text: "Greetings, thanks and everyday talk about the matter at hand." },
];

/** The two lists for a scope: what counts, and what doesn't. */
export function contactLines(scope: ContactScope = "off-platform"): { counts: Line[]; doesntCount: Line[] } {
  return scope === "details-only"
    ? { counts: [...DETAIL_LINES], doesntCount: [...MOVE_LINES, ...ALLOWED_LINES] }
    : { counts: [...DETAIL_LINES, ...MOVE_LINES], doesntCount: [...ALLOWED_LINES] };
}

/** The rule kinds a scope turns off: `details-only` leaves naming an app and asking to the conversation. */
export function scopeKinds(scope: ContactScope): { app?: false; ask?: false } {
  return scope === "details-only" ? { app: false, ask: false } : {};
}
