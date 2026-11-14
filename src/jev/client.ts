/**
 * TypeSafe's Jev, a hosted decision model, as a plain client: one request holds a `state` and any number of named
 * yes/no (`noul`) questions about it, and the answer gives each question's probability of yes under the same name.
 *
 * Fetch only, no SDK. The key is passed in (never read from the environment here). **The state never leaves this
 * module except in the request**: nothing is logged, and every error names a cause and a status, never the content.
 * The model is pinned (`jev-1.13.0` by default): an answer from any other model is refused, because cutoffs belong
 * to one model's scores. Moving to another version means calibrating again.
 */
import { ChaperoneError } from "../errors";

export const DEFAULT_JEV_MODEL = "jev-1.13.0";
export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
/** Per attempt. TypeSafe quotes about a tenth of a second for one question. */
export const DEFAULT_JEV_TIMEOUT_MS = 3_000;
/** The most questions one request may ask. */
export const JEV_MAX_QUESTIONS = 50;
/** One retry on 429 / 529, after `Retry-After` when it is this or less (no header: a short pause). */
const MAX_RETRY_AFTER_MS = 2_000;
const DEFAULT_RETRY_MS = 250;
/** A question's name in the request and the answer: short and opaque. */
const QUESTION_NAME = /^[a-z][a-z0-9_]{0,31}$/;

export interface JevQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export interface JevRequest {
  /** What the questions are about. Plain JSON. */
  state: Record<string, unknown>;
  questions: Readonly<Record<string, JevQuestion>>;
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JevAnswers {
  /** Each question's probability of yes, 0 to 1, by its name. */
  p: Record<string, number>;
  /** The model that answered (always the pinned one: anything else throws). */
  model: string;
  usage?: JevUsage;
}

export type JevFailure = "no_key" | "timeout" | "network" | "http" | "malformed" | "model_mismatch";

/** A failed call, by cause. Its message names the cause and the status only. Check it with `isJevError`. */
export class JevError extends ChaperoneError {
  readonly failure: JevFailure;
  readonly status?: number;
  /** On `model_mismatch`: the model the response named. */
  readonly answeredModel?: string;

  constructor(failure: JevFailure, status?: number, answeredModel?: string) {
    super(status ? `jev_${failure}_${status}` : `jev_${failure}`);
    this.name = "JevError";
    this.failure = failure;
    if (status !== undefined) this.status = status;
    if (answeredModel !== undefined) this.answeredModel = answeredModel;
  }
}

/** True for a `JevError` from any of the package's entries (by shape: each entry has its own copy of the class). */
export function isJevError(error: unknown): error is JevError {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; failure?: unknown };
  return e.name === "JevError" && typeof e.failure === "string";
}

export interface JevClientOptions {
  /** Your TypeSafe API key, or a function that returns it when a call is made. */
  apiKey: string | (() => string | null | undefined);
  /** The pinned model. Default `jev-1.13.0`. */
  model?: string;
  /** Default `https://api.typesafe.ai`. */
  baseUrl?: string;
  /** Per attempt. Default 3 seconds. */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface JevClient {
  readonly model: string;
  /** One request: every question answered, or a `JevError`. */
  ask(request: JevRequest): Promise<JevAnswers>;
}

/** The questions' names, checked: at least one, at most `JEV_MAX_QUESTIONS`, each opaque. */
function questionNames(questions: JevRequest["questions"]): string[] {
  const names = Object.keys(questions ?? {});
  if (names.length === 0 || names.length > JEV_MAX_QUESTIONS) throw new JevError("malformed");
  for (const name of names) if (!QUESTION_NAME.test(name)) throw new JevError("malformed");
  return names;
}

/** The request body: the pinned model, the state and the questions. */
export function jevRequestBody(model: string, request: JevRequest) {
  questionNames(request.questions);
  return { model, state: request.state, questions: request.questions };
}

/** Every asked question's probability and the usage out of a response, or a `JevError`. Extra answers are ignored. */
export function readJevAnswers(json: unknown, names: readonly string[], model: string): JevAnswers {
  if (!json || typeof json !== "object") throw new JevError("malformed");
  const body = json as {
    model?: unknown;
    answers?: Record<string, { type?: unknown; noul?: unknown } | undefined>;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  if (body.model !== model) {
    throw new JevError("model_mismatch", undefined, typeof body.model === "string" ? body.model : undefined);
  }
  const p: Record<string, number> = {};
  for (const name of names) {
    const answer = body.answers?.[name];
    const value = answer?.noul;
    if (answer?.type !== "noul" || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new JevError("malformed");
    }
    p[name] = value;
  }
  const input = body.usage?.input_tokens;
  const output = body.usage?.output_tokens;
  const usage = typeof input === "number" && typeof output === "number" ? { inputTokens: input, outputTokens: output } : undefined;
  return { p, model, ...(usage ? { usage } : {}) };
}

/** `Retry-After` in ms (seconds or an HTTP date); null when absent or unreadable. */
function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function createJevClient(options: JevClientOptions): JevClient {
  if (!options || (typeof options.apiKey !== "string" && typeof options.apiKey !== "function")) {
    throw new ChaperoneError("invalid_option", "createJevClient needs an apiKey (a string, or a function returning one)");
  }
  const model = options.model?.trim() || DEFAULT_JEV_MODEL;
  const url = `${(options.baseUrl?.trim() || DEFAULT_JEV_BASE_URL).replace(/\/+$/, "")}/v1/systemone`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const key = () => (typeof options.apiKey === "function" ? options.apiKey() : options.apiKey)?.trim();

  async function attempt(apiKey: string, body: string): Promise<Response> {
    const doFetch = options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } catch {
      throw new JevError(controller.signal.aborted ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    model,
    async ask(request) {
      const apiKey = key();
      if (!apiKey) throw new JevError("no_key");
      const names = questionNames(request.questions);
      const body = JSON.stringify(jevRequestBody(model, request));

      let res = await attempt(apiKey, body);
      if (res.status === 429 || res.status === 529) {
        const wait = retryAfterMs(res.headers.get("retry-after"), now()) ?? DEFAULT_RETRY_MS;
        if (wait > MAX_RETRY_AFTER_MS) throw new JevError("http", res.status);
        await sleep(wait);
        res = await attempt(apiKey, body);
      }
      if (!res.ok) throw new JevError("http", res.status);
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new JevError("malformed");
      }
      return readJevAnswers(json, names, model);
    },
  };
}

/**
 * A model and a value (a question, a state's shape version) as one short hex string (FNV-1a 32). Cutoffs record it:
 * a changed question is a different question, so its scores are redone.
 */
export function jevFingerprint(model: string, value: unknown): string {
  const text = JSON.stringify([model, value]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
