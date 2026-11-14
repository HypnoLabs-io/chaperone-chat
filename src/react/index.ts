/**
 * chaperone-chat/react: the participant's side as a hook and a component (React 18 or 19).
 *
 *   import { ChatThread } from "chaperone-chat/react";
 *   import "chaperone-chat/react/styles.css";
 *   <ChatThread endpoint="/api/chat" />   // the token comes from the page's #t= fragment
 *
 * Or build your own interface on `useChatThread()`.
 */
export { ChatThread, type ChatThreadProps } from "./chat-thread";
export { useChatThread, type ChatThreadApi, type UseChatThreadOptions } from "./use-chat-thread";
export { DEFAULT_LABELS, type ChatLabels } from "./labels";
export type { ClientState, MessageView, ParticipantView, ResolveOutcome, SendOutcome } from "../client";
