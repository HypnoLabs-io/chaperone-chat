/**
 * The moderators' HTTP endpoint, behind your own check (`authorizeModerator`): a session, an API key, an admin role.
 * Without one there is no endpoint: the handler can't be made, so it can't be left open by mistake. Everything is a
 * POST with a JSON body:
 *
 *   { step: "held", holdReason?, conversationId?, limit? }   → 200 { ok, held }: the queue, oldest first
 *   { step: "thread", conversationId }                       → 200 { ok, thread }: every message, every status
 *   { step: "approve" | "refuse" | "hide", messageId }        → 200 { ok, message }
 *   { step: "retry", messageId }                             → 200 { ok, outcome }: check a held message again
 *   { step: "close", conversationId, outcome }               → 200 { ok, state, outcome }
 *
 * Errors: 400 invalid_body / unknown_outcome, 401 not_authorized, 404 not_found, 405, 409 not_held / not_sent / closed
 * / refused, 413, 415, 500 server_error. Responses are `no-store`.
 */
import { ChaperoneError } from "../errors";
import type { Chat } from "../index";
import { failure, json, readJson } from "./respond";

export interface ModerationHandlerOptions {
  /** True for a request from a moderator. Required: there is no default. */
  authorizeModerator: (req: Request) => boolean | Promise<boolean>;
  /** The largest body read. Default 16 KB. */
  maxBodyBytes?: number;
}

const HOLD_REASONS = ["appeal", "unchecked", "flagged"] as const;
const STATUS: Record<string, number> = {
  not_found: 404,
  not_held: 409,
  not_sent: 409,
  closed: 409,
  refused: 409,
  unknown_outcome: 400,
};

const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;

export function createModerationHandler(chat: Chat, options: ModerationHandlerOptions): (req: Request) => Promise<Response> {
  if (!options || typeof options.authorizeModerator !== "function") {
    throw new ChaperoneError("invalid_option", "createModerationHandler needs authorizeModerator(req)");
  }
  const maxBodyBytes = options.maxBodyBytes ?? 16_384;

  return async function handle(req: Request): Promise<Response> {
    try {
      let allowed = false;
      try {
        allowed = (await options.authorizeModerator(req)) === true;
      } catch {
        allowed = false;
      }
      if (!allowed) return failure("not_authorized", 401);
      const read = await readJson(req, maxBodyBytes);
      if (!read.ok) return read.response;
      const b = read.value as Record<string, unknown> | null;
      if (!b || typeof b !== "object" || Array.isArray(b)) return failure("invalid_body", 400);

      switch (b.step) {
        case "held": {
          if (b.holdReason !== undefined && !(HOLD_REASONS as readonly unknown[]).includes(b.holdReason)) return failure("invalid_body", 400);
          if (b.conversationId !== undefined && !id(b.conversationId)) return failure("invalid_body", 400);
          const limit = b.limit === undefined ? 50 : Number(b.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 500) return failure("invalid_body", 400);
          const held = await chat.moderation.listHeld({
            holdReason: b.holdReason as (typeof HOLD_REASONS)[number] | undefined,
            conversationId: b.conversationId as string | undefined,
            limit,
          });
          return json({ ok: true, held });
        }
        case "thread": {
          if (!id(b.conversationId)) return failure("invalid_body", 400);
          const thread = await chat.moderation.thread(b.conversationId);
          return thread ? json({ ok: true, thread }) : failure("not_found", 404);
        }
        case "approve":
        case "refuse":
        case "hide": {
          if (!id(b.messageId)) return failure("invalid_body", 400);
          const result = await chat.moderation[b.step](b.messageId);
          return result.ok ? json(result) : failure(result.reason, STATUS[result.reason] ?? 409);
        }
        case "retry": {
          if (!id(b.messageId)) return failure("invalid_body", 400);
          return json({ ok: true, outcome: await chat.moderation.retry(b.messageId) });
        }
        case "close": {
          if (!id(b.conversationId) || typeof b.outcome !== "string" || !b.outcome || b.outcome.length > 32) {
            return failure("invalid_body", 400);
          }
          const result = await chat.close(b.conversationId, b.outcome, { by: "moderator" });
          if (result.ok) return json(result);
          const { reason, ...rest } = result;
          return failure(reason, STATUS[reason] ?? 409, rest);
        }
        default:
          return failure("invalid_body", 400);
      }
    } catch {
      return failure("server_error", 500);
    }
  };
}
