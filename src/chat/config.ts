/**
 * `createChat`'s options, their defaults, and the resolved shape the engine reads. Every value the engine would
 * otherwise hard-code is here: who takes part, how long a conversation runs, the message limits, the screening.
 */
import { ChaperoneError } from "../errors";
import { createGuard, type Guard, type RulesOptions, type Scrubber } from "../guard";
import type { ContactKind } from "../guard/types";
import { DEFAULT_WINDOW, WINDOW_REASONS, type WindowKind } from "../guard/window";
import { createLinks, type Links } from "../links";
import type { Store } from "../store/types";

const DAY = 86_400_000;

export interface MessageOptions {
  /** Longest message, in characters after cleaning. Default 1,000. */
  maxChars?: number;
  /** Messages one participant may send (stored or refused) in 24 hours; null for no limit. Default 50. */
  perParticipantPerDay?: number | null;
  /** How many messages a first load returns, newest last. Default 200. */
  pageSize?: number;
}

export interface LinkOptions {
  /** How long a link keeps working past the conversation's deadline. Default 3 days. */
  graceMs?: number;
  /** A link's life when the conversation has no deadline. Default 30 days. */
  ttlMs?: number;
}

/** What a participant reads on their own message that isn't delivered. */
export interface Notes {
  held: string;
  refused: string;
  hidden: string;
}

export interface ChatConfig {
  /** Signs the participants' links. At least 32 characters; a list rotates (the first signs, any verifies). */
  secret: string | readonly string[];
  store: Store;
  /** False: the rules alone, by intent. */
  jev: false;
  /** How long a conversation runs; null for no deadline. Default 7 days. Each conversation may override it. */
  durationMs?: number | null;
  links?: LinkOptions;
  messages?: MessageOptions;
  /** The rules: kinds, locales, region, apps, domains, platform names, custom detectors. */
  rules?: RulesOptions;
  /** A method to run instead of the rules (they stay the fallback). */
  scrubber?: Scrubber;
  /** The split-message pass, or false to turn it off. Default 5 earlier messages within 24 hours. */
  window?: { maxEarlier?: number; hours?: number } | false;
  /** The sentence a sender sees, by kind, and for the split-message pass. */
  reasons?: Partial<Record<ContactKind, string>> & { window?: Partial<Record<WindowKind, string>> };
  notes?: Partial<Notes>;
}

export const DEFAULT_NOTES: Notes = {
  held: "Waiting for a quick check before it's sent.",
  refused: "Not sent: a moderator stopped it.",
  hidden: "Removed by a moderator.",
};

export interface Resolved {
  store: Store;
  guard: Guard;
  links: Links;
  durationMs: number | null;
  linkGraceMs: number;
  linkTtlMs: number;
  maxChars: number;
  perParticipantPerDay: number | null;
  pageSize: number;
  window: { maxEarlier: number; windowMs: number } | null;
  windowReasons: Record<WindowKind, string>;
  notes: Notes;
}

function nonNegative(value: number | null | undefined, fallback: number | null, name: string): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new ChaperoneError("invalid_option", `${name} must be a number of 0 or more`);
  return value;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new ChaperoneError("invalid_option", `${name} must be a whole number of 1 or more`);
  return value;
}

export function resolveConfig(config: ChatConfig): Resolved {
  if (!config || typeof config !== "object") throw new ChaperoneError("invalid_option", "createChat needs options");
  if (!config.store) throw new ChaperoneError("invalid_option", "createChat needs a store (memoryStore() or postgresStore(query))");
  if (config.jev !== false) {
    throw new ChaperoneError("invalid_option", "jev must be false (the rules alone) or Jev's options");
  }
  const { window: windowReasons, ...kindReasons } = config.reasons ?? {};
  const window =
    config.window === false
      ? null
      : {
          maxEarlier: positive(config.window?.maxEarlier, DEFAULT_WINDOW.maxEarlier, "window.maxEarlier"),
          windowMs: (nonNegative(config.window?.hours, DEFAULT_WINDOW.hours, "window.hours") as number) * 3_600_000,
        };
  return {
    store: config.store,
    guard: createGuard({ ...config.rules, scrubber: config.scrubber, reasons: kindReasons }),
    links: createLinks({ secret: config.secret }),
    durationMs: nonNegative(config.durationMs, 7 * DAY, "durationMs"),
    linkGraceMs: nonNegative(config.links?.graceMs, 3 * DAY, "links.graceMs") as number,
    linkTtlMs: positive(config.links?.ttlMs, 30 * DAY, "links.ttlMs"),
    maxChars: positive(config.messages?.maxChars, 1_000, "messages.maxChars"),
    perParticipantPerDay:
      config.messages?.perParticipantPerDay === null
        ? null
        : positive(config.messages?.perParticipantPerDay, 50, "messages.perParticipantPerDay"),
    pageSize: positive(config.messages?.pageSize, 200, "messages.pageSize"),
    window,
    windowReasons: { ...WINDOW_REASONS, ...windowReasons },
    notes: { ...DEFAULT_NOTES, ...config.notes },
  };
}
