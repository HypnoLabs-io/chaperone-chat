/**
 * chaperone-chat/http: the participants' endpoint as one Web-standard handler, a Node adapter, and the request
 * limiter it uses.
 *
 *   // Next.js: app/api/chat/route.ts
 *   export const POST = createChatHandler(chat);
 *   // Node: http.createServer(toNodeHandler(createChatHandler(chat)))
 */
export { createChatHandler, type HandlerOptions } from "./handler";
export { toNodeHandler, type NodeHandlerOptions, type WebHandler } from "./node";
export { memoryRateLimiter, type RateLimiter, type RateResult } from "./rate-limit";
export { ChaperoneError, isChaperoneError } from "../errors";
