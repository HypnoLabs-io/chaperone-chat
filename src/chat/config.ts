/**
 * `createChat`'s options, their defaults, and the resolved shape the engine reads. Every value the engine would
 * otherwise hard-code is here: who takes part, how long a conversation runs, the message limits, the screening.
 */
import { ChaperoneError } from "../errors";
import { createGuard, type Guard, type RulesOptions, type Scrubber } from "../guard";
import { DEFAULT_CONTEXT_TURNS, jevJudge, type Bands, type Judge } from "../guard/check";
import { contactLeak } from "../guard/policies/contact-leak";
import type { Policy } from "../guard/policy";
import type { ContactKind } from "../guard/types";
import { DEFAULT_WINDOW, WINDOW_REASONS, type WindowKind } from "../guard/window";
import { createJevClient } from "../jev/client";
import { createLinks, type Links } from "../links";
import type { Json, Store } from "../store/types";

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

export interface JevOptions {
  /** Your TypeSafe API key, or a function returning it at each call. */
  apiKey: string | (() => string | null | undefined);
  /** The pinned model. Default `jev-1.13.0`; the built-in cutoffs belong to it. */
  model?: string;
  baseUrl?: string;
  /** Per attempt. Default 3 seconds. */
  timeoutMs?: number;
  /** Jev calls in 24 hours across every conversation; past it, the fallback decides. Null for none. Default 2,000. */
  dailyCap?: number | null;
  fetch?: typeof fetch;
}

/** Who may decide an outcome, and whether one vote closes or every one of them must agree. */
export interface OutcomeRule {
  /** The roles that may vote for it, or "*" for everyone. */
  by: readonly string[] | "*";
  /** `any` (default): one vote closes. `all`: every participant who may vote must, a double opt-in. */
  requires?: "any" | "all";
}

/** What a host's `beforeClose` hook is told. Server-side: it holds every participant's `externalRef` and the context. */
export interface CloseContext {
  conversation: { id: string; key: string | null; context: Json; deadline: Date | null; createdAt: Date };
  outcome: string;
  /** A participant's id, "system" (the deadline passed) or "moderator". */
  by: string;
  participants: { id: string; role: string; alias: string; externalRef: string | null }[];
  votes: { participantId: string; outcome: string }[];
}

/** An event as `onEvent` receives it: ids and numbers, never message text. */
export interface ChatEvent {
  id: string;
  type: string;
  conversationId: string | null;
  participantId: string | null;
  meta: Json;
  at: Date;
}

export interface Hooks {
  /**
   * Runs once a close is claimed, before it commits (where a host charges, releases, or swaps contact details).
   * Return or resolve false, or `{ refuse: "why" }`, to refuse it: the conversation opens again. Throw and it stays
   * closing: the sweep calls the hook again later. Must be safe to run more than once for one close.
   */
  beforeClose?(context: CloseContext): void | boolean | { refuse: string } | Promise<void | boolean | { refuse: string }>;
  /** Every event, after it is recorded. Errors are swallowed: the action has happened. */
  onEvent?(event: ChatEvent): void | Promise<void>;
}

export interface ChatConfig {
  /** Signs the participants' links. At least 32 characters; a list rotates (the first signs, any verifies). */
  secret: string | readonly string[];
  store: Store;
  /** Jev's options, or false: the rules alone, by intent. */
  jev: false | JevOptions;
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
  /** Jev's policies. Default `[contactLeak()]`. */
  policies?: readonly Policy[];
  /** What each band of Jev's score does. Default: block refuses, review refuses with an appeal. */
  bands?: Bands;
  /** Whether a refusal in the review band may be sent again for review. Default true. */
  appeals?: boolean;
  /** When Jev can't decide: hold the message (default), send it on the rules alone, or refuse it. */
  fallback?: "hold" | "send" | "refuse";
  /** `observe` delivers everything and records what `enforce` (the default) would have stopped. */
  mode?: "enforce" | "observe";
  /** How many earlier delivered messages Jev reads with the new one. Default 8. */
  contextTurns?: number;
  /** The sentence a sender sees, by kind, and for the split-message pass. */
  reasons?: Partial<Record<ContactKind, string>> & { window?: Partial<Record<WindowKind, string>> };
  notes?: Partial<Notes>;
  /** How a conversation can end. Default `{ end: { by: "*" } }`: anyone may end it. */
  outcomes?: Readonly<Record<string, OutcomeRule>>;
  /** The outcome a conversation closes with when its deadline passes. Default "expired". */
  expiredOutcome?: string;
  hooks?: Hooks;
}

export const DEFAULT_OUTCOMES: Readonly<Record<string, OutcomeRule>> = { end: { by: "*", requires: "any" } };

export const DEFAULT_NOTES: Notes = {
  held: "Waiting for a quick check before it's sent.",
  refused: "Not sent: a moderator stopped it.",
  hidden: "Removed by a moderator.",
};

export interface Resolved {
  store: Store;
  guard: Guard;
  links: Links;
  judge: Judge | null;
  dailyCap: number | null;
  policies: readonly Policy[];
  bands: Bands;
  appeals: boolean;
  fallback: "hold" | "send" | "refuse";
  mode: "enforce" | "observe";
  contextTurns: number;
  durationMs: number | null;
  linkGraceMs: number;
  linkTtlMs: number;
  maxChars: number;
  perParticipantPerDay: number | null;
  pageSize: number;
  window: { maxEarlier: number; windowMs: number } | null;
  windowReasons: Record<WindowKind, string>;
  notes: Notes;
  outcomes: Readonly<Record<string, Required<OutcomeRule>>>;
  expiredOutcome: string;
  hooks: Hooks;
}

const OUTCOME = /^[a-z][a-z0-9_-]{0,31}$/;

function resolveOutcomes(outcomes: Readonly<Record<string, OutcomeRule>> | undefined): Record<string, Required<OutcomeRule>> {
  const out: Record<string, Required<OutcomeRule>> = {};
  for (const [name, rule] of Object.entries(outcomes ?? DEFAULT_OUTCOMES)) {
    if (!OUTCOME.test(name)) throw new ChaperoneError("invalid_option", `outcome "${name}": lowercase, 1-32 characters`);
    const by = rule?.by;
    if (by !== "*" && !(Array.isArray(by) && by.length > 0 && by.every((r) => typeof r === "string" && r))) {
      throw new ChaperoneError("invalid_option", `outcome "${name}": by is "*" or a list of roles`);
    }
    out[name] = { by, requires: oneOf<"any" | "all">(rule.requires, ["any", "all"], "any", `outcomes.${name}.requires`) };
  }
  if (Object.keys(out).length === 0) throw new ChaperoneError("invalid_option", "outcomes needs at least one");
  return out;
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

function oneOf<T extends string>(value: T | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new ChaperoneError("invalid_option", `${name} must be one of ${allowed.join(", ")}`);
  return value;
}

export function resolveConfig(config: ChatConfig): Resolved {
  if (!config || typeof config !== "object") throw new ChaperoneError("invalid_option", "createChat needs options");
  if (!config.store) throw new ChaperoneError("invalid_option", "createChat needs a store (memoryStore() or postgresStore(query))");
  if (config.jev !== false && (!config.jev || typeof config.jev !== "object")) {
    throw new ChaperoneError("invalid_option", "jev must be Jev's options ({ apiKey }) or false for the rules alone");
  }
  const policies = config.policies ?? [contactLeak()];
  if (!Array.isArray(policies)) throw new ChaperoneError("invalid_option", "policies must be a list");
  const ids = policies.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw new ChaperoneError("invalid_option", "two policies share an id");

  const outcomes = resolveOutcomes(config.outcomes);
  const expiredOutcome = config.expiredOutcome ?? "expired";
  if (!OUTCOME.test(expiredOutcome)) throw new ChaperoneError("invalid_option", "expiredOutcome: lowercase, 1-32 characters");
  const { window: windowReasons, ...kindReasons } = config.reasons ?? {};
  const window =
    config.window === false
      ? null
      : {
          maxEarlier: positive(config.window?.maxEarlier, DEFAULT_WINDOW.maxEarlier, "window.maxEarlier"),
          windowMs: (nonNegative(config.window?.hours, DEFAULT_WINDOW.hours, "window.hours") as number) * 3_600_000,
        };
  // A policy's scope turns rule kinds off (the contact policy's details-only); the host's own kinds win.
  const kinds = Object.assign({}, ...policies.map((p) => p.ruleKinds ?? {}), config.rules?.kinds);
  const rules: RulesOptions = { ...config.rules, kinds };

  let judge: Judge | null = null;
  let dailyCap: number | null = null;
  if (config.jev) {
    const client = createJevClient({
      apiKey: config.jev.apiKey,
      model: config.jev.model,
      baseUrl: config.jev.baseUrl,
      timeoutMs: config.jev.timeoutMs,
      fetch: config.jev.fetch,
    });
    judge = jevJudge(client, { platformNames: config.rules?.platformNames });
    dailyCap = config.jev.dailyCap === null ? null : (nonNegative(config.jev.dailyCap, 2_000, "jev.dailyCap") as number);
  }

  return {
    store: config.store,
    guard: createGuard({ ...rules, scrubber: config.scrubber, reasons: kindReasons }),
    links: createLinks({ secret: config.secret }),
    judge,
    dailyCap,
    policies,
    bands: {
      block: oneOf<"refuse" | "hold">(config.bands?.block, ["refuse", "hold"], "refuse", "bands.block"),
      review: oneOf<"appealable" | "hold" | "send">(config.bands?.review, ["appealable", "hold", "send"], "appealable", "bands.review"),
    },
    appeals: config.appeals !== false,
    fallback: oneOf<"hold" | "send" | "refuse">(config.fallback, ["hold", "send", "refuse"], "hold", "fallback"),
    mode: oneOf<"enforce" | "observe">(config.mode, ["enforce", "observe"], "enforce", "mode"),
    contextTurns: nonNegative(config.contextTurns, DEFAULT_CONTEXT_TURNS, "contextTurns") as number,
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
    outcomes,
    expiredOutcome,
    hooks: config.hooks ?? {},
  };
}
