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
export * from "./types";
export {
  createGuard,
  scan,
  has,
  block,
  scrub,
  type Block,
  type Guard,
  type GuardOptions,
} from "./guard";
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
export {
  check,
  DEFAULT_CONTEXT_TURNS,
  FALLBACK_REASON,
  HOLD_REASON,
  jevJudge,
  type Action,
  type Bands,
  type CheckInput,
  type CheckOptions,
  type HoldReason,
  type Judge,
  type JudgeFailure,
  type JudgeResult,
  type Verdict,
} from "./check";
export {
  bullets,
  calibrationOf,
  definePolicy,
  jevQuestionOf,
  jevState,
  platformSwapper,
  policyFingerprint,
  STATE_SHAPES,
  STATE_VERSION,
  type StateShape,
  type Cutoffs,
  type DefinePolicyInput,
  type JudgeTurn,
  type Policy,
  type PolicyLine,
} from "./policy";
export {
  ALLOWED_LINES,
  CONTACT_SCOPES,
  contactLines,
  DETAIL_LINES,
  MOVE_LINES,
  scopeKinds,
  type ContactScope,
  type Line,
} from "./policies/contact-lines";
export {
  CONTACT_CUTOFFS,
  CONTACT_POLICY_ID,
  CONTACT_QUESTIONS,
  CONTACT_REASON,
  contactLeak,
  type ContactLeakOptions,
} from "./policies/contact-leak";
export { ChaperoneError, isChaperoneError } from "../errors";
