// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChat, memoryStore, type Chat } from "../../src";
import {
  createChatClient as makeClient,
  errorText,
  mergeMessages,
  readFragmentToken,
  type ChatClient,
  type ClientOptions,
  type ClientState,
} from "../../src/client";
import { createChatHandler } from "../../src/http";

const SECRET = "test-secret-0123456789-0123456789";

/** Every client a test makes is stopped after it, so none answers the next test's events. */
const clients: ChatClient[] = [];
function createChatClient(options: ClientOptions): ChatClient {
  const client = makeClient(options);
  clients.push(client);
  return client;
}

let chat: Chat;
let tokens: [string, string];
let calls: { step: string; since?: string | null }[];

/** The client's fetch, answered by the real handler; outages and visibility are the browser's, so they're faked. */
let down = false;
function fakeFetch(handler: (r: Request) => Promise<Response>) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (down) throw new TypeError("Failed to fetch");
    const body = JSON.parse(String(init?.body));
    calls.push({ step: body.step, since: body.since });
    return handler(new Request(new URL(String(input), "http://chat.test"), init));
  };
}

/**
 * For the timing tests: an answer at once, with no crypto or store work in between, so a poll is never still in
 * flight when the next one is due (the client rightly doesn't stack them).
 */
function cannedFetch() {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ step: body.step, since: body.since });
    const thread = {
      conversation: { id: "c", state: "open", open: true, outcome: null, deadline: null, msLeft: null },
      you: { id: "p", role: "buyer", alias: "Buyer" },
      participants: [],
      messages: [],
      removed: [],
      cursor: "2026-03-01T12:00:00.000Z",
      more: false,
      hasOlder: false,
      maxChars: 1000,
    };
    return new Response(JSON.stringify({ ok: true, thread }), { headers: { "Content-Type": "application/json" } });
  };
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(async () => {
  calls = [];
  down = false;
  chat = createChat({ secret: SECRET, store: memoryStore(), jev: false });
  const opened = await chat.open({ participants: [{ role: "buyer", alias: "Buyer" }, { role: "seller", alias: "Seller" }] });
  tokens = [opened.links[0]!.token, opened.links[1]!.token];
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/chat");
  setVisibility("visible");
});

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.useRealTimers();
});

describe("readFragmentToken", () => {
  it("takes the token from the fragment, keeps it for the session and clears the address bar", () => {
    window.history.replaceState(null, "", `/chat?x=1#t=${tokens[0]}`);
    expect(readFragmentToken()).toBe(tokens[0]);
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?x=1");
    // A reload: no fragment now, the session still has it.
    expect(readFragmentToken()).toBe(tokens[0]);
    expect(readFragmentToken("another-key")).toBeNull();
  });
});

describe("createChatClient", () => {
  async function ready(token: string) {
    const client = createChatClient({ endpoint: "/api/chat", token, fetch: fakeFetch(createChatHandler(chat)) });
    const states: ClientState[] = [];
    const unsubscribe = client.subscribe((s) => states.push(s));
    await vi.waitFor(() => expect(client.getState().status).toBe("ready"));
    return { client, states, unsubscribe };
  }

  it("loads the conversation on the first subscriber", async () => {
    const { client } = await ready(tokens[0]);
    expect(client.getState()).toMatchObject({
      status: "ready",
      error: null,
      you: { role: "buyer", alias: "Buyer" },
      conversation: { state: "open", open: true },
      maxChars: 1_000,
      messages: [],
    });
    expect(calls).toEqual([{ step: "load", since: null }]);
  });

  it("sends, shows its own message at once, and the other side sees it on its next poll", async () => {
    const a = await ready(tokens[0]);
    const b = await ready(tokens[1]);
    expect(await a.client.send("Is it still available?")).toMatchObject({ ok: true, held: false });
    expect(a.client.getState().messages.map((m) => [m.body, m.mine])).toEqual([["Is it still available?", true]]);
    await b.client.refresh();
    expect(b.client.getState().messages.map((m) => [m.body, m.mine, m.alias])).toEqual([["Is it still available?", false, "Buyer"]]);
    // The poll asked only for what changed.
    expect(calls.at(-1)).toMatchObject({ step: "load", since: expect.any(String) });
  });

  it("returns a refusal with its sentence and kind, and stores nothing on screen", async () => {
    const { client } = await ready(tokens[0]);
    expect(await client.send("my email is dana@gmail.com")).toEqual({
      ok: false,
      error: "blocked",
      kind: "email",
      message: "That looks like an email address.",
      appealable: false,
    });
    expect(client.getState().messages).toEqual([]);
    expect(await client.send("   ")).toEqual({ ok: false, error: "empty" });
  });

  it("polls on its interval only while the page is visible, and on coming back", async () => {
    vi.useFakeTimers();
    const client = createChatClient({ endpoint: "/api/chat", token: tokens[1], pollMs: 1_000, fetch: cannedFetch() });
    client.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toHaveLength(4);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(4);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(5);
    client.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(5);
  });

  it("stops polling when the last subscriber leaves", async () => {
    vi.useFakeTimers();
    const client = createChatClient({ endpoint: "/api/chat", token: tokens[0], pollMs: 1_000, fetch: cannedFetch() });
    const off = client.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    const before = calls.length;
    off();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.length).toBe(before);
  });

  it("says why when the link doesn't work, and when there is none", async () => {
    const bad = createChatClient({ endpoint: "/api/chat", token: "x.y", fetch: fakeFetch(createChatHandler(chat)) });
    bad.subscribe(() => {});
    await vi.waitFor(() => expect(bad.getState()).toMatchObject({ status: "error", error: "invalid_link" }));
    const none = createChatClient({ endpoint: "/api/chat", fetch: fakeFetch(createChatHandler(chat)) });
    expect(none.token).toBeNull();
    expect(none.getState()).toMatchObject({ status: "error", error: "invalid_link" });
    expect(await none.send("hi")).toEqual({ ok: false, error: "invalid_link" });
  });

  it("keeps what is on screen through a failed poll, and reports a failed send as network", async () => {
    const { client } = await ready(tokens[0]);
    await client.send("first");
    down = true;
    await client.refresh();
    expect(client.getState()).toMatchObject({ status: "ready", error: null });
    expect(client.getState().messages).toHaveLength(1);
    expect(await client.send("second")).toEqual({ ok: false, error: "network" });
  });

  it("passes on the rate limit's code and wait", async () => {
    const handler = createChatHandler(chat, { rateLimit: { writes: 1 } });
    const client = createChatClient({ endpoint: "/api/chat", token: tokens[0], fetch: fakeFetch(handler) });
    await client.send("one");
    const limited = await client.send("two");
    expect(limited).toMatchObject({ ok: false, error: "rate_limited", retryAfterMs: expect.any(Number) });
    expect(errorText(limited.ok ? null : limited.error)).toBe("Slow down a little, then try again.");
  });
});

describe("mergeMessages", () => {
  const m = (id: string, at: string, body = id) =>
    ({ id, at, body, from: "p", alias: "A", role: "a", mine: false, status: "sent", note: null }) as const;

  it("replaces by id, drops the removed and keeps time order, stable within an instant", () => {
    const old = [m("a", "2026-01-01T00:00:01Z"), m("b", "2026-01-01T00:00:02Z")];
    const merged = mergeMessages(old, [m("b", "2026-01-01T00:00:02Z", "b2"), m("c", "2026-01-01T00:00:00Z"), m("d", "2026-01-01T00:00:02Z")], ["a"]);
    expect(merged.map((x) => [x.id, x.body])).toEqual([
      ["c", "c"],
      ["b", "b2"],
      ["d", "d"],
    ]);
  });
});
