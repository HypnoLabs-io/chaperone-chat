/**
 * The participants' HTTP endpoint: one Web-standard `Request → Response` function for Next.js route handlers, Hono,
 * Bun, Deno and workers (`toNodeHandler` adapts it to Node's `http`). Everything is a POST with a JSON body:
 *
 *   { token, step: "load", since? }       → 200 { ok, thread }
 *   { token, step: "send", text }         → 200 { ok, message, held } | 422 blocked { message, kind, appealable }
 *   { token, step: "appeal", text }       → the same, sending a refused message again for review
 *   { token, step: "resolve", outcome }   → 200 { ok, state, outcome, waitingFor? }: choose how it ends
 *
 * The signed link in the body is the only auth: there are no cookies, so a cross-site form can't act for anyone. The
 * token travels in the body, never in a URL, and the handler acts on POST only (link scanners fetch every URL they
 * see). Responses are `no-store`.
 *
 * Errors: 400 invalid_body / empty / too_long / unknown_outcome, 401 invalid_link / link_expired, 403 not_allowed,
 * 404 not_found, 405, 409 closed / refused, 413 body_too_large, 415, 422 blocked, 429 rate_limited (with
 * Retry-After) / too_many (the daily message limit), 500 server_error.
 */
import type { Chat } from "../index";
import { memoryRateLimiter, type RateLimiter } from "./rate-limit";
import { failure, json, readJson } from "./respond";

export interface HandlerOptions {
  /**
   * Per-participant request limits: reads (load) and writes (send, appeal) in a window. Default 120 reads and 30
   * writes a minute, counted in memory; pass `{ limiter }` to count elsewhere, or false for none.
   */
  rateLimit?: false | { reads?: number; writes?: number; windowMs?: number; limiter?: RateLimiter };
  /**
   * A key for the client (an IP address from your proxy's header), checked before the token: `clientLimit` requests a
   * window from one client, whoever they claim to be. Default: no client key.
   */
  clientKey?: (req: Request) => string | null | undefined;
  /** Requests per window from one client key. Default 300. */
  clientLimit?: number;
  /** The largest body read. Default 16 KB. */
  maxBodyBytes?: number;
}

type Step = "load" | "send" | "appeal" | "resolve";
const STEPS: readonly Step[] = ["load", "send", "appeal", "resolve"];
const MAX_TEXT_CHARS = 20_000;

const SEND_STATUS: Record<string, number> = {
  not_found: 404,
  closed: 409,
  empty: 400,
  too_long: 400,
  too_many: 429,
  blocked: 422,
};

const RESOLVE_STATUS: Record<string, number> = {
  not_found: 404,
  closed: 409,
  unknown_outcome: 400,
  not_allowed: 403,
  refused: 409,
};

interface Body {
  token: string;
  step: Step;
  since: string | null;
  text: string;
  outcome: string;
}

/** The body's fields, checked by hand: null when anything is off. */
function parseBody(value: unknown): Body | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.token !== "string" || v.token.length === 0 || v.token.length > 512) return null;
  if (typeof v.step !== "string" || !(STEPS as readonly string[]).includes(v.step)) return null;
  const step = v.step as Step;
  let since: string | null = null;
  if (v.since !== undefined && v.since !== null) {
    if (typeof v.since !== "string" || v.since.length > 40 || !Number.isFinite(Date.parse(v.since))) return null;
    since = v.since;
  }
  let text = "";
  if (step === "send" || step === "appeal") {
    if (typeof v.text !== "string" || v.text.length > MAX_TEXT_CHARS) return null;
    text = v.text;
  }
  let outcome = "";
  if (step === "resolve") {
    if (typeof v.outcome !== "string" || v.outcome.length === 0 || v.outcome.length > 32) return null;
    outcome = v.outcome;
  }
  return { token: v.token, step, since, text, outcome };
}

export function createChatHandler(chat: Chat, options: HandlerOptions = {}): (req: Request) => Promise<Response> {
  const limits = options.rateLimit === false ? null : options.rateLimit ?? {};
  const limiter = limits ? (limits.limiter ?? memoryRateLimiter()) : null;
  const windowMs = limits?.windowMs ?? 60_000;
  const reads = limits?.reads ?? 120;
  const writes = limits?.writes ?? 30;
  const maxBodyBytes = options.maxBodyBytes ?? 16_384;
  const clientLimit = options.clientLimit ?? 300;

  async function limited(key: string, limit: number): Promise<Response | null> {
    if (!limiter) return null;
    const result = await limiter.hit(key, limit, windowMs);
    if (result.ok) return null;
    const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    return failure("rate_limited", 429, { retryAfterMs: result.retryAfterMs }, { "Retry-After": String(seconds) });
  }

  return async function handle(req: Request): Promise<Response> {
    try {
      const client = options.clientKey?.(req);
      if (client) {
        const refused = await limited(`client:${client}`, clientLimit);
        if (refused) return refused;
      }
      const read = await readJson(req, maxBodyBytes);
      if (!read.ok) return read.response;
      const body = parseBody(read.value);
      if (!body) return failure("invalid_body", 400);

      const link = await chat.verify(body.token);
      if (!link.ok) return failure(link.reason, 401);
      const participantId = link.participantId;
      const writing = body.step !== "load";
      const refused = await limited(`${writing ? "w" : "r"}:${participantId}`, writing ? writes : reads);
      if (refused) return refused;

      if (body.step === "load") {
        const thread = await chat.load(participantId, { since: body.since });
        return thread ? json({ ok: true, thread }) : failure("not_found", 404);
      }
      if (body.step === "resolve") {
        const resolved = await chat.resolve(participantId, body.outcome);
        if (resolved.ok) return json(resolved);
        const { reason, ...rest } = resolved;
        return failure(reason, RESOLVE_STATUS[reason] ?? 409, rest);
      }
      const sent = await chat.send(participantId, body.text, { appeal: body.step === "appeal" });
      if (sent.ok) return json({ ok: true, message: sent.message, held: sent.held });
      const { reason, ...rest } = sent;
      return failure(reason, SEND_STATUS[reason] ?? 409, rest);
    } catch {
      // Never echo what went wrong: it could hold a message's text or the store's details.
      return failure("server_error", 500);
    }
  };
}
