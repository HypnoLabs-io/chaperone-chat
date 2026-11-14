/** The guard: the rules built once from options, a swappable method, and the sentences a sender sees. */
import { createRules, type Rules, type RulesOptions } from "./rules";
import { scanWith, type Scan } from "./scan";
import { scrubWith } from "./scrub";
import { KIND_REASONS, type ContactKind, type Scrubber } from "./types";
import { windowKinds, type WindowKind } from "./window";

export interface GuardOptions extends RulesOptions {
  /** The method to run instead of the rules (or `combine("rules+x", [guard.rules, x])` to keep them underneath). */
  scrubber?: Scrubber;
  /** The sentence a sender sees, by kind. */
  reasons?: Partial<Record<ContactKind, string>>;
}

/** Why a text is refused. */
export interface Block {
  kind: ContactKind;
  reason: string;
  /** The method that decided (`rules`, or your scrubber's id). */
  scrubberId: string;
}

export interface Guard {
  /** The rules these options built; `rules.find(text)` is the synchronous scan. */
  readonly rules: Rules;
  readonly reasons: Readonly<Record<ContactKind, string>>;
  scan(text: string): Promise<Scan>;
  has(text: string): Promise<boolean>;
  block(text: string): Promise<Block | null>;
  scrub(text: string): Promise<string>;
  /** The split-message pass (`./window.ts`) over the sender's own earlier messages. */
  windowKinds(earlier: readonly string[], text: string, maxEarlier?: number): WindowKind[];
}

export function createGuard(options: GuardOptions = {}): Guard {
  const rules = createRules(options);
  const scrubber = options.scrubber ?? rules;
  const reasons = { ...KIND_REASONS, ...options.reasons };
  const scan = (text: string) => scanWith(scrubber, rules, text);
  return {
    rules,
    reasons,
    scan,
    async has(text) {
      return (await scan(text)).kinds.length > 0;
    },
    async block(text) {
      const result = await scan(text);
      const kind = result.kinds[0];
      return kind ? { kind, reason: reasons[kind], scrubberId: result.scrubberId } : null;
    },
    scrub: (text) => scrubWith(scan, text),
    windowKinds: (earlier, text, maxEarlier) => windowKinds(rules, earlier, text, maxEarlier),
  };
}

function isGuard(value: Guard | GuardOptions): value is Guard {
  return typeof (value as Guard).scan === "function" && typeof (value as Guard).scrub === "function";
}

let defaultGuard: Guard | undefined;
const guards = new WeakMap<GuardOptions, Guard>();

function guardFor(value?: Guard | GuardOptions): Guard {
  if (!value) return (defaultGuard ??= createGuard());
  if (isGuard(value)) return value;
  let guard = guards.get(value);
  if (!guard) {
    guard = createGuard(value);
    guards.set(value, guard);
  }
  return guard;
}

/** Everything `text` holds, with the default rules or the guard / options given. */
export const scan = (text: string, guard?: Guard | GuardOptions): Promise<Scan> => guardFor(guard).scan(text);
/** Whether `text` holds a contact detail. */
export const has = (text: string, guard?: Guard | GuardOptions): Promise<boolean> => guardFor(guard).has(text);
/** The most specific kind in `text`, its sentence and the method that decided; null when clean. */
export const block = (text: string, guard?: Guard | GuardOptions): Promise<Block | null> => guardFor(guard).block(text);
/** `text` with every sentence that holds a contact detail cut out; blank when it can't be cut cleanly. */
export const scrub = (text: string, guard?: Guard | GuardOptions): Promise<string> => guardFor(guard).scrub(text);
