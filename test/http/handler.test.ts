import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChat, KIND_REASONS, memoryStore, type Chat } from "../../src";
import { createChatHandler, memoryRateLimiter, toNodeHandler } from "../../src/http";

const SECRET = "test-secret-0123456789-0123456789";

let now: number;
let chat: Chat;
let tokens: [string, string];

beforeEach(async () => {
  now = new Date("2026-03-01T12:00:00.000Z").getTime();
  chat = createChat({ secret: SECRET, store: memoryStore({ clock: () => new Date(now) }), jev: false });
  const opened = await chat.open({ participants: [{ role: "buyer", alias: "Buyer" }, { role: "seller", alias: "Seller" }] });
  tokens = [opened.links[0]!.token, opened.links[1]!.token];
});

function post(body: unknown, init: { type?: string; raw?: string } = {}) {
  return new Request("http://chat.test/api/chat", {
    method: "POST",
    headers: { "Content-Type": init.type ?? "application/json" },
    body: init.raw ?? JSON.stringify(body),
  });
}

async function call(handler: (r: Request) => Promise<Response>, req: Request) {
  const res = await handler(req);
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
}

describe("createChatHandler", () => {
  it("loads, sends and loads again, with no-store answers", async () => {
    const handle = createChatHandler(chat);
    const sent = await call(handle, post({ token: tokens[0], step: "send", text: "Is it still available?" }));
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ok: true, held: false, message: { body: "Is it still available?", mine: true } });
    expect(sent.headers.get("cache-control")).toBe("no-store");
    const loaded = await call(handle, post({ token: tokens[1], step: "load" }));
    expect(loaded.status).toBe(200);
    expect(loaded.body.thread.messages).toEqual([expect.objectContaining({ body: "Is it still available?", mine: false })]);
    const again = await call(handle, post({ token: tokens[1], step: "load", since: loaded.body.thread.cursor }));
    expect(again.body.thread.cursor).toEqual(expect.any(String));
  });

  it("answers a refused message with 422, its kind and its sentence", async () => {
    const handle = createChatHandler(chat);
    const refused = await call(handle, post({ token: tokens[0], step: "send", text: "dana@gmail.com" }));
    expect(refused).toMatchObject({
      status: 422,
      body: { ok: false, error: "blocked", kind: "email", message: KIND_REASONS.email, appealable: false },
    });
  });

  it.each([
    ["empty", { step: "send", text: "   " }, 400],
    ["too_long", { step: "send", text: "x".repeat(1_001) }, 400],
  ])("answers %s with %s", async (error, body, status) => {
    const handle = createChatHandler(chat);
    expect(await call(handle, post({ token: tokens[0], ...body }))).toMatchObject({ status, body: { ok: false, error } });
  });

  it("answers 409 once the conversation is past its deadline", async () => {
    const handle = createChatHandler(chat);
    now += 8 * 86_400_000;
    expect(await call(handle, post({ token: tokens[0], step: "send", text: "hi" }))).toMatchObject({
      status: 409,
      body: { error: "closed" },
    });
  });

  it("refuses a bad or expired link with 401", async () => {
    const handle = createChatHandler(chat);
    expect(await call(handle, post({ token: "x.y", step: "load" }))).toMatchObject({ status: 401, body: { error: "invalid_link" } });
    now += 11 * 86_400_000;
    expect(await call(handle, post({ token: tokens[0], step: "load" }))).toMatchObject({ status: 401, body: { error: "link_expired" } });
  });

  it.each([
    ["no step", { token: "t" }],
    ["an unknown step", { token: "t", step: "delete" }],
    ["send without text", { token: "t", step: "send" }],
    ["a since that isn't a time", { token: "t", step: "load", since: "soon" }],
    ["an array", [1, 2]],
  ])("refuses a body with %s", async (_label, body) => {
    expect(await call(createChatHandler(chat), post(body))).toMatchObject({ status: 400, body: { error: "invalid_body" } });
  });

  it("refuses what isn't a JSON POST within the size limit", async () => {
    const handle = createChatHandler(chat, { maxBodyBytes: 200 });
    const get = await handle(new Request("http://chat.test/api/chat"));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await handle(post({}, { type: "text/plain", raw: "{}" }))).status).toBe(415);
    expect((await handle(post({}, { raw: "{not json" }))).status).toBe(400);
    expect((await handle(post({ token: tokens[0], step: "send", text: "x".repeat(500) }))).status).toBe(413);
  });

  it("limits each participant's reads and writes, answering rate_limited with Retry-After", async () => {
    let clock = 0;
    const handle = createChatHandler(chat, {
      rateLimit: { reads: 2, writes: 1, windowMs: 60_000, limiter: memoryRateLimiter({ clock: () => clock }) },
    });
    expect((await call(handle, post({ token: tokens[0], step: "send", text: "one" }))).status).toBe(200);
    const second = await call(handle, post({ token: tokens[0], step: "send", text: "two" }));
    expect(second).toMatchObject({ status: 429, body: { ok: false, error: "rate_limited", retryAfterMs: 60_000 } });
    expect(second.headers.get("retry-after")).toBe("60");
    // The other participant has their own budget; reads have theirs.
    expect((await call(handle, post({ token: tokens[1], step: "send", text: "mine" }))).status).toBe(200);
    expect((await call(handle, post({ token: tokens[0], step: "load" }))).status).toBe(200);
    expect((await call(handle, post({ token: tokens[0], step: "load" }))).status).toBe(200);
    expect((await call(handle, post({ token: tokens[0], step: "load" }))).status).toBe(429);
    clock += 60_000;
    expect((await call(handle, post({ token: tokens[0], step: "send", text: "three" }))).status).toBe(200);
  });

  it("limits a client key before reading the token", async () => {
    const handle = createChatHandler(chat, { clientKey: (r) => r.headers.get("x-client"), clientLimit: 1 });
    const req = () => {
      const r = post({ token: "bad", step: "load" });
      r.headers.set("x-client", "1.2.3.4");
      return r;
    };
    expect((await handle(req())).status).toBe(401);
    expect((await handle(req())).status).toBe(429);
  });

  it("answers 500 without details when the store fails", async () => {
    const broken = createChat({
      secret: SECRET,
      jev: false,
      store: {
        ...memoryStore({ clock: () => new Date(now) }),
        getParticipantContext: () => Promise.reject(new Error("db down: secret detail")),
      },
    });
    const handle = createChatHandler(broken);
    const res = await call(handle, post({ token: tokens[0], step: "load" }));
    expect(res).toEqual({ status: 500, headers: expect.anything(), body: { ok: false, error: "server_error" } });
  });
});

describe("toNodeHandler", () => {
  let server: Server;
  afterEach(() => new Promise<void>((done) => server.close(() => done())));

  it("serves the handler on Node's http server", async () => {
    server = createServer(toNodeHandler(createChatHandler(chat)));
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", () => ready()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokens[0], step: "send", text: "hello from node" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, message: { body: "hello from node" } });
    const get = await fetch(`http://127.0.0.1:${port}/api/chat`);
    expect(get.status).toBe(405);
  });
});
