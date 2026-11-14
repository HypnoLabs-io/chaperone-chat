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

export interface Chat extends Engine, Pick<Lifecycle, "resolve" | "close"> {
  /** The held queue, whole conversations, and approve, refuse, hide and retry on one message. */
  readonly moderation: Moderation;
  /** For the sweep (`sweep()`): close what is past its deadline, and finish closes whose hook failed. */
  readonly lifecycle: Lifecycle;
}

export function createChat(config: ChatConfig): Chat {
  const context = createContext(resolveConfig(config));
  const lifecycle = createLifecycle(context);
  return {
    ...createEngine(context),
    resolve: lifecycle.resolve,
    close: lifecycle.close,
    lifecycle,
    moderation: createModeration(context),
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
  type OutcomeRule,
} from "./chat/config";
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
