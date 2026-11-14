/**
 * chaperone-chat: an anonymous chat that keeps contact details out. Two or more people talk through signed links,
 * each seeing only the others' aliases; every message passes the screen before anyone sees it.
 *
 *   const chat = createChat({ secret, store: memoryStore(), jev: false });
 *   const { links } = await chat.open({ participants: [{ role: "buyer", alias: "Buyer" }, { role: "seller", alias: "Seller" }] });
 *   // send each person `${yourChatPage}#t=${link.token}`; serve createChatHandler(chat) from one route.
 */
import { resolveConfig, type ChatConfig } from "./chat/config";
import { createEngine, type Engine } from "./chat/engine";

export type Chat = Engine;

export function createChat(config: ChatConfig): Chat {
  return createEngine(resolveConfig(config));
}

export { DEFAULT_NOTES, type ChatConfig, type LinkOptions, type MessageOptions, type Notes } from "./chat/config";
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
