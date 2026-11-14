import { beforeEach, describe, expect, it } from "vitest";
import { createChat, isChaperoneError, memoryStore, type Chat } from "../../src";
import { createChatHandler, createModerationHandler } from "../../src/http";

const SECRET = "test-secret-0123456789-0123456789";
const MOD_KEY = "moderator-key";

let now: number;
let chat: Chat;
let cid: string;
let tokens: [string, string];

beforeEach(async () => {
  now = new Date("2026-03-01T12:00:00.000Z").getTime();
  chat = createChat({
    secret: SECRET,
    store: memoryStore({ clock: () => new Date(now) }),
    // Jev is configured but always down, so every message is held for a check.
    jev: { apiKey: "k", fetch: (async () => new Response("", { status: 503 })) as typeof fetch },
    outcomes: { keep: { by: ["buyer"] }, end: { by: "*" } },
  });
  const opened = await chat.open({ participants: [{ role: "buyer", alias: "Buyer" }, { role: "seller", alias: "Seller" }] });
  cid = opened.conversation.id;
  tokens = [opened.links[0]!.token, opened.links[1]!.token];
});

const auth = (req: Request) => req.headers.get("authorization") === `Bearer ${MOD_KEY}`;

async function mod(body: unknown, key: string | null = MOD_KEY) {
  const handle = createModerationHandler(chat, { authorizeModerator: auth });
  const res = await handle(
    new Request("http://chat.test/api/moderate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function participant(token: string, body: Record<string, unknown>) {
  const res = await createChatHandler(chat)(
    new Request("http://chat.test/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...body }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("createModerationHandler", () => {
  it("can't be made without an authorizer", () => {
    let error: unknown;
    try {
      createModerationHandler(chat, {} as never);
    } catch (e) {
      error = e;
    }
    expect(isChaperoneError(error, "invalid_option")).toBe(true);
  });

  it("refuses anyone the authorizer doesn't let in, or that makes it throw", async () => {
    expect(await mod({ step: "held" }, null)).toMatchObject({ status: 401, body: { error: "not_authorized" } });
    expect(await mod({ step: "held" }, "wrong")).toMatchObject({ status: 401 });
    const throwing = createModerationHandler(chat, { authorizeModerator: () => { throw new Error("session store down"); } });
    const res = await throwing(new Request("http://chat.test/api/moderate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("lists the held queue, reads a thread, approves, hides and closes", async () => {
    const held = await participant(tokens[0], { step: "send", text: "Saturday at 10?" });
    expect(held).toMatchObject({ status: 200, body: { held: true } });
    const queue = await mod({ step: "held" });
    expect(queue).toMatchObject({ status: 200, body: { ok: true, held: [{ body: "Saturday at 10?", holdReason: "unchecked" }] } });
    const messageId = queue.body.held[0].id as string;
    expect(await mod({ step: "approve", messageId })).toMatchObject({ status: 200, body: { ok: true, message: { status: "sent" } } });
    expect(await mod({ step: "approve", messageId })).toMatchObject({ status: 409, body: { error: "not_held" } });
    expect((await participant(tokens[1], { step: "load" })).body.thread.messages).toHaveLength(1);
    expect(await mod({ step: "hide", messageId })).toMatchObject({ status: 200, body: { message: { status: "hidden" } } });
    expect(await mod({ step: "thread", conversationId: cid })).toMatchObject({
      status: 200,
      body: { thread: { conversation: { id: cid }, messages: [{ id: messageId, status: "hidden" }] } },
    });
    expect(await mod({ step: "retry", messageId })).toMatchObject({ status: 200, body: { outcome: "gone" } });
    expect(await mod({ step: "close", conversationId: cid, outcome: "keep" })).toMatchObject({
      status: 200,
      body: { ok: true, state: "closed", outcome: "keep" },
    });
    // The same outcome again is the same close; another one is refused.
    expect(await mod({ step: "close", conversationId: cid, outcome: "keep" })).toMatchObject({ status: 200, body: { state: "closed" } });
    expect(await mod({ step: "close", conversationId: cid, outcome: "end" })).toMatchObject({ status: 409, body: { error: "closed" } });
  });

  it.each([
    [{ step: "nope" }],
    [{ step: "approve" }],
    [{ step: "thread", conversationId: 7 }],
    [{ step: "held", holdReason: "whatever" }],
    [{ step: "held", limit: 0 }],
    [{ step: "close", conversationId: "c1" }],
  ])("refuses a body of %j", async (body) => {
    expect(await mod(body)).toMatchObject({ status: 400, body: { error: "invalid_body" } });
  });

  it("answers 404 for what isn't there", async () => {
    expect(await mod({ step: "thread", conversationId: "c_none" })).toMatchObject({ status: 404 });
    expect(await mod({ step: "refuse", messageId: "m_none" })).toMatchObject({ status: 404 });
  });
});

describe("the participants' resolve step", () => {
  it("closes with an outcome the role may choose, then refuses to send with 409", async () => {
    expect(await participant(tokens[1], { step: "resolve", outcome: "keep" })).toMatchObject({ status: 403, body: { error: "not_allowed" } });
    expect(await participant(tokens[1], { step: "resolve", outcome: "maybe" })).toMatchObject({ status: 400, body: { error: "unknown_outcome" } });
    expect(await participant(tokens[0], { step: "resolve", outcome: "keep" })).toMatchObject({
      status: 200,
      body: { ok: true, state: "closed", outcome: "keep" },
    });
    expect(await participant(tokens[1], { step: "send", text: "hello?" })).toMatchObject({ status: 409, body: { error: "closed" } });
    expect(await participant(tokens[1], { step: "resolve", outcome: "end" })).toMatchObject({ status: 409, body: { error: "closed" } });
  });

  it("needs an outcome", async () => {
    expect(await participant(tokens[0], { step: "resolve" })).toMatchObject({ status: 400, body: { error: "invalid_body" } });
  });
});
