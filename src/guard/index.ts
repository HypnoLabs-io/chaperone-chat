/**
 * chaperone-chat/guard: the screen on its own, for anything people type that others will read (a chat message, a
 * profile, a listing, a form). Usable without the chat.
 *
 * - `has(text)`: whether it holds a contact detail (refuse a field at save).
 * - `block(text)`: the most specific kind, the sentence to show the sender, and the method that decided.
 * - `scrub(text)`: the text with every sentence that holds one cut out (clean a field at render).
 * - `scan(text)`: everything found.
 *
 * Each takes an optional guard or options; `createGuard(options)` builds the rules once for repeated calls.
 *
 * **The method is swappable.** A method is a `Scrubber` (an `id` and a `find`, sync or async); the rules are the
 * default. **Fail closed:** a method that throws or answers nonsense is replaced for that call by the rules.
 */
import { createRules, type Rules, type RulesOptions } from "./rules";
import { scanWith, type Scan } from "./scan";
import { scrubWith } from "./scrub";
import { KIND_REASONS, type ContactKind, type Scrubber } from "./types";
import { windowKinds, type WindowKind } from "./window";

export * from "./types";
export {
  createRules,
  kindsOf,
  LOCALES,
  REGIONS,
  type CustomDetector,
  type FindOptions,
  type LocaleName,
  type RegionName,
  type Rules,
  type RulesOptions,
} from "./rules";
export { en } from "./locales/en";
export { es } from "./locales/es";
export { us } from "./regions/us";
export type { Locale, LocaleContext } from "./locales/types";
export type { Region } from "./regions/types";
export type { Detector } from "./detector";
export { APP_GROUPS, type AppGroup, type AppOptions } from "./detectors/apps";
export { hasUnboundedQuantifier } from "./bounded";
export { combine, type Scan } from "./scan";
export {
  DEFAULT_WINDOW,
  WINDOW_KINDS,
  WINDOW_REASONS,
  windowKinds,
  type WindowKind,
  type WindowOptions,
} from "./window";
export { ChaperoneError, isChaperoneError } from "../errors";

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
