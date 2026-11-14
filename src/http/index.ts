/**
 * chaperone-chat/http: the participants' endpoint and the moderators' endpoint as Web-standard handlers, a Node
 * adapter, and the request limiter.
 *
 *   // Next.js: app/api/chat/route.ts
 *   export const POST = createChatHandler(chat);
 *   // Node: http.createServer(toNodeHandler(createChatHandler(chat)))
 */
export { createChatHandler, type HandlerOptions } from "./handler";
export { createModerationHandler, type ModerationHandlerOptions } from "./moderation";
export { toNodeHandler, type NodeHandlerOptions, type WebHandler } from "./node";
export { memoryRateLimiter, type RateLimiter, type RateResult } from "./rate-limit";
export { ChaperoneError, isChaperoneError } from "../errors";
