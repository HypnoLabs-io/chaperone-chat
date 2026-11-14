/**
 * chaperone-chat/jev: TypeSafe's Jev as a typed client, and the helpers that read its scores on labelled samples.
 * chaperone-chat is not affiliated with TypeSafe; you bring your own Jev account and key.
 *
 *   const jev = createJevClient({ apiKey: process.env.TYPESAFE_API_KEY! });
 *   const { p } = await jev.ask({ state: { … }, questions: { contact: { type: "noul", instructions, criteria } } });
 */
export {
  createJevClient,
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  isJevError,
  JEV_MAX_QUESTIONS,
  JevError,
  jevFingerprint,
  jevRequestBody,
  readJevAnswers,
  type JevAnswers,
  type JevClient,
  type JevClientOptions,
  type JevFailure,
  type JevQuestion,
  type JevRequest,
  type JevUsage,
} from "./client";
export {
  bandMisses,
  reliabilityTable,
  suggestCutoffs,
  type BandMisses,
  type CutoffSuggestion,
  type ReliabilityRow,
  type ScoredItem,
} from "./calibration";
export { ChaperoneError, isChaperoneError } from "../errors";
