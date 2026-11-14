/**
 * chaperone-chat/client: the participant's side in the browser, with no framework. It reads the link's token from
 * the page's URL fragment (`#t=…`, which never reaches a server), keeps it in session storage so a reload still
 * works, and takes it out of the address bar. It polls the handler while the page is visible, merges what comes back
 * and drops what a moderator removed, and sends.
 *
 *   const client = createChatClient({ endpoint: "/api/chat" });
 *   const stop = client.subscribe((state) => render(state));
 *   await client.send("Hello!");
 *
 * SSR-safe: nothing touches `window` until it is used in a browser.
 */
import type { ConversationView, MessageView, ParticipantView, ThreadView } from "../chat/views";

export type { ConversationView, MessageView, ParticipantView, ThreadView } from "../chat/views";

export interface ClientOptions {
  /** The handler's URL. */
  endpoint: string;
  /** The participant's token. Default: from the URL fragment, then session storage. */
  token?: string | null;
  /** Where the token is kept for the session. Default "chaperone-chat:token". */
  storageKey?: string;
  /** How often to poll while the page is visible. Default 15 seconds. */
  pollMs?: number;
  fetch?: typeof fetch;
}

export type ClientStatus = "idle" | "loading" | "ready" | "error";

export interface ClientState {
  status: ClientStatus;
  conversation: ConversationView | null;
  you: ParticipantView | null;
  participants: ParticipantView[];
  /** Oldest first. */
  messages: MessageView[];
  /** A first load found older messages than it returned. */
  hasOlder: boolean;
  maxChars: number | null;
  /** The outcomes this participant may choose, and the ones they chose. */
  outcomes: string[];
  voted: string[];
  /** Why the conversation couldn't be loaded: an error code (`invalid_link`, `link_expired`, `not_found`, `network`…). */
  error: string | null;
}

export type SendOutcome =
  | { ok: true; message: MessageView; held: boolean }
  | {
      ok: false;
      /** `blocked`, `empty`, `too_long`, `too_many`, `closed`, `rate_limited`, `invalid_link`, `network`… */
      error: string;
      /** For `blocked`: the sentence to show the sender. */
      message?: string;
      kind?: string;
      /** For `blocked`: the sender may send it again for review (`appeal`). */
      appealable?: boolean;
      retryAfterMs?: number;
    };

export interface ChatClient {
  /** The token in use; null when the page has none. */
  readonly token: string | null;
  getState(): ClientState;
  /** Called on every change. The first subscriber starts polling; the last one leaving stops it. */
  subscribe(listener: (state: ClientState) => void): () => void;
  /** Load what changed (or, `full`, everything again). */
  refresh(full?: boolean): Promise<void>;
  send(text: string): Promise<SendOutcome>;
  /** Send a refused message again, for review. */
  appeal(text: string): Promise<SendOutcome>;
  /** Choose how the conversation ends (one of the view's `outcomes`). */
  resolve(outcome: string): Promise<ResolveOutcome>;
  stop(): void;
}

export type ResolveOutcome =
  | { ok: true; state: "closed" | "closing" | "waiting"; outcome: string; waitingFor?: ParticipantView[] }
  | { ok: false; error: string; message?: string };

/** Plain-English words for each error code, for a page that has none of its own. */
export const ERROR_TEXT: Readonly<Record<string, string>> = {
  invalid_link: "This link doesn't work.",
  link_expired: "This link has expired.",
  not_found: "This conversation isn't here any more.",
  closed: "This conversation has closed.",
  empty: "Write a message first.",
  too_long: "That message is too long.",
  too_many: "That's a lot of messages for one day. Please try again tomorrow.",
  not_allowed: "That choice isn't yours to make here.",
  unknown_outcome: "That choice isn't available.",
  refused: "That couldn't be done right now.",
  rate_limited: "Slow down a little, then try again.",
  network: "We couldn't reach the server. Check your connection and try again.",
  server_error: "Something went wrong on our side. Please try again.",
};

export function errorText(code: string | null | undefined, texts: Readonly<Record<string, string>> = ERROR_TEXT): string {
  return (code && texts[code]) || "Something went wrong. Please try again.";
}

const DEFAULT_STORAGE_KEY = "chaperone-chat:token";
const hasWindow = () => typeof window !== "undefined" && typeof document !== "undefined";

/**
 * The token from the page's URL fragment (`#t=…`), kept in session storage and taken out of the address bar (so it
 * isn't left in a screenshot or a copied link); else the one kept earlier in this session; else null.
 */
export function readFragmentToken(storageKey: string = DEFAULT_STORAGE_KEY): string | null {
  if (!hasWindow()) return null;
  const match = window.location.hash.match(/[#&]t=([^&]+)/);
  const fromHash = match ? decodeURIComponent(match[1] as string) : null;
  if (fromHash) {
    try {
      window.sessionStorage.setItem(storageKey, fromHash);
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    } catch {
      // Private mode: the token still works for this page view.
    }
    return fromHash;
  }
  try {
    return window.sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

/** Old messages and new ones by id, minus the removed, oldest first (stable for messages of one instant). */
export function mergeMessages(old: readonly MessageView[], incoming: readonly MessageView[], removed: readonly string[] = []): MessageView[] {
  const byId = new Map(old.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  for (const id of removed) byId.delete(id);
  return [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

const EMPTY: ClientState = {
  status: "idle",
  conversation: null,
  you: null,
  participants: [],
  messages: [],
  hasOlder: false,
  maxChars: null,
  outcomes: [],
  voted: [],
  error: null,
};

export function createChatClient(options: ClientOptions): ChatClient {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const pollMs = options.pollMs ?? 15_000;
  const token = options.token !== undefined ? options.token : readFragmentToken(options.storageKey);
  let state: ClientState = token ? { ...EMPTY } : { ...EMPTY, status: "error", error: "invalid_link" };
  let cursor: string | null = null;
  const listeners = new Set<(s: ClientState) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<void> | null = null;

  function set(next: Partial<ClientState>) {
    state = { ...state, ...next };
    for (const l of listeners) l(state);
  }

  async function post(body: Record<string, unknown>): Promise<Record<string, any>> {
    try {
      const res = await doFetch(options.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...body }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, any> | null;
      return data && typeof data === "object" ? data : { ok: false, error: res.ok ? "server_error" : `http_${res.status}` };
    } catch {
      return { ok: false, error: "network" };
    }
  }

  function apply(thread: ThreadView, full: boolean) {
    cursor = thread.cursor;
    set({
      status: "ready",
      error: null,
      conversation: thread.conversation,
      you: thread.you,
      participants: thread.participants,
      maxChars: thread.maxChars,
      outcomes: thread.outcomes,
      voted: thread.voted,
      hasOlder: full ? thread.hasOlder : state.hasOlder,
      messages: full ? mergeMessages([], thread.messages) : mergeMessages(state.messages, thread.messages, thread.removed),
    });
  }

  async function load(full: boolean): Promise<void> {
    if (!token) return;
    if (full || !cursor) set({ status: state.status === "ready" ? "ready" : "loading" });
    for (let pages = 0; pages < 20; pages++) {
      const data = await post({ step: "load", since: full ? null : cursor });
      if (data.ok && data.thread) {
        apply(data.thread as ThreadView, full);
        if (!(data.thread as ThreadView).more) return;
        full = false;
      } else {
        // A failed poll leaves what is on screen; a failed first load says why.
        if (state.status !== "ready") set({ status: "error", error: String(data.error ?? "server_error") });
        return;
      }
    }
  }

  function refresh(full = false): Promise<void> {
    if (inflight) return inflight;
    inflight = load(full || cursor === null).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const visible = () => !hasWindow() || document.visibilityState === "visible";
  // Polls until the conversation has closed for good, so its last state still reaches the screen.
  const tick = () => {
    if (visible() && state.conversation?.state !== "closed") void refresh();
  };

  function start() {
    if (timer || !token) return;
    timer = setInterval(tick, pollMs);
    if (hasWindow()) {
      document.addEventListener("visibilitychange", tick);
      window.addEventListener("focus", tick);
    }
    if (state.status === "idle") void refresh(true);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (hasWindow()) {
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    }
  }

  async function sendStep(step: "send" | "appeal", text: string): Promise<SendOutcome> {
    if (!token) return { ok: false, error: "invalid_link" };
    if (!text.trim()) return { ok: false, error: "empty" };
    const data = await post({ step, text });
    if (data.ok && data.message && typeof data.message === "object") {
      set({ messages: mergeMessages(state.messages, [data.message as MessageView]) });
      return { ok: true, message: data.message as MessageView, held: data.held === true };
    }
    const error = String(data.error ?? "server_error");
    if (error === "closed") void refresh(true);
    return {
      ok: false,
      error,
      ...(typeof data.message === "string" ? { message: data.message } : {}),
      ...(typeof data.kind === "string" ? { kind: data.kind } : {}),
      ...(error === "blocked" ? { appealable: data.appealable === true && step === "send" } : {}),
      ...(typeof data.retryAfterMs === "number" ? { retryAfterMs: data.retryAfterMs } : {}),
    };
  }

  return {
    token,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    refresh,
    send: (text) => sendStep("send", text),
    appeal: (text) => sendStep("appeal", text),
    async resolve(outcome) {
      if (!token) return { ok: false, error: "invalid_link" };
      const data = await post({ step: "resolve", outcome });
      await refresh(true);
      if (data.ok) {
        return {
          ok: true,
          state: data.state as "closed" | "closing" | "waiting",
          outcome: String(data.outcome),
          ...(Array.isArray(data.waitingFor) ? { waitingFor: data.waitingFor as ParticipantView[] } : {}),
        };
      }
      return { ok: false, error: String(data.error ?? "server_error"), ...(typeof data.message === "string" ? { message: data.message } : {}) };
    },
    stop,
  };
}
