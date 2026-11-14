/**
 * chaperone-chat: an anonymous chat that keeps contact details out. Two or more people talk through signed links,
 * each seeing only the others' aliases; every message passes the screen before anyone sees it.
 *
 *   const chat = createChat({ secret, store: memoryStore(), jev: false });
 *   const { links } = await chat.open({ participants: [{ role: "buyer", alias: "Buyer" }, { role: "seller", alias: "Seller" }] });
 *   // send each person `${yourChatPage}#t=${link.token}`; serve createChatHandler(chat) from one route.
 */
import { resolveConfig, type ChatConfig } from "./chat/config";
import { createContext } from "./chat/context";
import { createEngine, type Engine } from "./chat/engine";
import { createLifecycle, type Lifecycle } from "./chat/lifecycle";
import { createModeration, type Moderation } from "./chat/moderate";
import { createSweep, type SweepReport, type SweeperOptions } from "./chat/sweep";

export interface Chat extends Engine, Pick<Lifecycle, "resolve" | "close"> {
  /** The held queue, whole conversations, and approve, refuse, hide and retry on one message. */
  readonly moderation: Moderation;
  /** The sweep's parts: close what is past its deadline, and finish closes whose hook failed. */
  readonly lifecycle: Lifecycle;
  /** Expiry, stuck closes, held messages, notices and retention, in one idempotent call. Run it on a schedule. */
  sweep(options?: { limit?: number }): Promise<SweepReport>;
  /** Runs `sweep()` on an interval in this process. */
  startSweeper(options?: SweeperOptions): { stop(): void };
}

export function createChat(config: ChatConfig): Chat {
  const context = createContext(resolveConfig(config));
  const lifecycle = createLifecycle(context);
  const moderation = createModeration(context);
  const sweeper = createSweep(context, lifecycle, moderation);
  return {
    ...createEngine(context),
    resolve: lifecycle.resolve,
    close: lifecycle.close,
    lifecycle,
    moderation,
    sweep: sweeper.sweep,
    startSweeper: sweeper.startSweeper,
  };
}

export {
  DEFAULT_NOTES,
  DEFAULT_OUTCOMES,
  type ChatConfig,
  type ChatEvent,
  type CloseContext,
  type Hooks,
  type JevOptions,
  type LinkOptions,
  type MessageOptions,
  type Notes,
  type Notice,
  type NotifyOptions,
  type OutcomeRule,
  type ParticipantNotice,
  type RetentionOptions,
  type TroubleNotice,
} from "./chat/config";
export { TROUBLE_STREAK, type SweepReport, type SweeperOptions } from "./chat/sweep";
export { listNames, renderNotice, timeLeft, type RenderedNotice, type RenderOptions } from "./notices/render";
export type { CloseResult, ResolveResult } from "./chat/lifecycle";
export type { ModerationResult, ModeratorMessage, ModeratorThread, RetryOutcome } from "./chat/moderate";
export {
  CURSOR_OVERLAP_MS,
  LINK_KIND,
  type LinkInfo,
  type OpenInput,
  type OpenResult,
  type VerifyLink,
} from "./chat/engine";
export { EVENT, type EventType } from "./chat/event-types";
export type {
  ConversationView,
  MessageView,
  ParticipantView,
  SendRefusal,
  SendResult,
  ThreadView,
} from "./chat/views";
export { memoryStore, type MemoryStoreOptions } from "./store/memory";
export type * from "./store/types";
export { ChaperoneError, isChaperoneError } from "./errors";
export {
  CONTACT_KINDS,
  KIND_REASONS,
  type ContactKind,
  type Finding,
  type RulesOptions,
  type Scrubber,
} from "./guard";
