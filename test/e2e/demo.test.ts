/**
 * The demo, driven end to end with fetch: the same server `node examples/demo/server.mjs` runs, on a free port.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDemo } from "../../examples/demo/app.mjs";

type Demo = Awaited<ReturnType<typeof startDemo>>;
let demo: Demo;

beforeAll(async () => {
  demo = await startDemo({ port: 0, handler: { rateLimit: { writes: 8 } } });
});
afterAll(() => demo.close());

async function api(path: string, body?: unknown) {
  const res = await fetch(`${demo.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function conversation() {
  const opened = await api("/api/open");
  expect(opened.status).toBe(200);
  const [buyer, seller] = opened.body.links.map((l: { url: string }) => decodeURIComponent(l.url.split("#t=")[1]!));
  return { buyer: buyer as string, seller: seller as string, links: opened.body.links };
}

describe("the demo", () => {
  it("serves its page", async () => {
    const res = await fetch(`${demo.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("Start a conversation");
    expect((await fetch(`${demo.url}/favicon.ico`)).status).toBe(204);
    expect((await fetch(`${demo.url}/nothing-here`)).status).toBe(404);
  });

  it("opens a conversation with a link for each side, carried in the fragment", async () => {
    const { links } = await conversation();
    expect(links.map((l: { alias: string }) => l.alias)).toEqual(["Buyer", "Seller"]);
    for (const l of links) expect(l.url).toMatch(/^\/#t=[\w-]+\.[\w-]+$/);
  });

  it("delivers a clean message to the other side", async () => {
    const { buyer, seller } = await conversation();
    expect(await api("/api/chat", { token: buyer, step: "send", text: "Is the bike still for sale?" })).toMatchObject({
      status: 200,
      body: { ok: true, held: false },
    });
    const seen = await api("/api/chat", { token: seller, step: "load" });
    expect(seen.body.thread.messages.map((m: { body: string; alias: string }) => [m.alias, m.body])).toEqual([
      ["Buyer", "Is the bike still for sale?"],
    ]);
  });

  it("refuses a phone number with 422 and its kind, and the other side never sees it", async () => {
    const { buyer, seller } = await conversation();
    expect(await api("/api/chat", { token: seller, step: "send", text: "call me on 312 555 0142" })).toMatchObject({
      status: 422,
      body: { ok: false, error: "blocked", kind: "phone", appealable: false },
    });
    expect((await api("/api/chat", { token: buyer, step: "load" })).body.thread.messages).toEqual([]);
  });

  it("refuses a number split across three messages, by the split-message pass", async () => {
    const { seller } = await conversation();
    expect((await api("/api/chat", { token: seller, step: "send", text: "it's 312" })).status).toBe(200);
    expect((await api("/api/chat", { token: seller, step: "send", text: "555" })).status).toBe(200);
    expect(await api("/api/chat", { token: seller, step: "send", text: "0142" })).toMatchObject({
      status: 422,
      body: { error: "blocked", kind: "phone", message: "Together with your last few messages, that reads as a phone number." },
    });
  });

  it("answers rate_limited past the per-participant limit", async () => {
    const { buyer } = await conversation();
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await api("/api/chat", { token: buyer, step: "send", text: `message ${i}` })).status);
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(200));
    const limited = await api("/api/chat", { token: buyer, step: "send", text: "one too many" });
    expect(limited).toMatchObject({ status: 429, body: { ok: false, error: "rate_limited" } });
  });

  it("refuses a link that isn't one", async () => {
    expect(await api("/api/chat", { token: "forged.token", step: "load" })).toMatchObject({
      status: 401,
      body: { error: "invalid_link" },
    });
  });
});

describe("the demo with Jev and a moderator", () => {
  /** Jev's network: answers by the judged message's text, 0.05 for anything not listed. */
  const SCORES: Record<string, number> = { "Shall we swap over on the usual photo app?": 0.3, "Find me by my full name, the blue profile.": 0.9 };
  const fakeJev = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const latest = body.state.conversation.at(-1).text as string;
    const answers = Object.fromEntries(Object.keys(body.questions).map((n) => [n, { type: "noul", noul: SCORES[latest] ?? 0.05 }]));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers }));
  }) as typeof fetch;
  const events: { type: string; meta: Record<string, unknown> }[] = [];
  let jevDemo: Demo;

  beforeAll(async () => {
    jevDemo = await startDemo({
      port: 0,
      moderatorKey: "mod-key",
      chat: { jev: { apiKey: "k", fetch: fakeJev }, hooks: { onEvent: (e) => void events.push(e as never) } },
    });
  });
  afterAll(() => jevDemo.close());

  async function call(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${jevDemo.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }
  const moderate = (body: unknown) => call("/api/moderate", body, { Authorization: "Bearer mod-key" });
  async function opened() {
    const o = await call("/api/open", {});
    const [buyer, seller] = o.body.links.map((l: { url: string }) => decodeURIComponent(l.url.split("#t=")[1]!));
    return { buyer: buyer as string, seller: seller as string, conversationId: o.body.conversationId as string };
  }

  it("refuses a high score outright, and lets a review-band score be appealed, held, and approved", async () => {
    const { buyer, seller } = await opened();
    expect(await call("/api/chat", { token: seller, step: "send", text: "Find me by my full name, the blue profile." })).toMatchObject({
      status: 422,
      body: { error: "blocked", appealable: false },
    });
    const text = "Shall we swap over on the usual photo app?";
    expect(await call("/api/chat", { token: seller, step: "send", text })).toMatchObject({ status: 422, body: { appealable: true } });
    expect(await call("/api/chat", { token: seller, step: "appeal", text })).toMatchObject({ status: 200, body: { held: true } });
    expect((await call("/api/chat", { token: buyer, step: "load" })).body.thread.messages).toEqual([]);
    const queue = await moderate({ step: "held" });
    const held = queue.body.held.find((m: { body: string }) => m.body === text);
    expect(held).toMatchObject({ holdReason: "appeal" });
    expect(await moderate({ step: "approve", messageId: held.id })).toMatchObject({ status: 200 });
    expect((await call("/api/chat", { token: buyer, step: "load" })).body.thread.messages.map((m: { body: string }) => m.body)).toEqual([text]);
  });

  it("takes a hidden message off the recipient's open thread at the next poll", async () => {
    const { buyer, seller } = await opened();
    const sent = await call("/api/chat", { token: seller, step: "send", text: "Here is something to take back." });
    const open = await call("/api/chat", { token: buyer, step: "load" });
    expect(open.body.thread.messages).toHaveLength(1);
    expect(await moderate({ step: "hide", messageId: sent.body.message.id })).toMatchObject({ status: 200 });
    const next = await call("/api/chat", { token: buyer, step: "load", since: open.body.thread.cursor });
    expect(next.body.thread.removed).toEqual([sent.body.message.id]);
  });

  it("answers 409 to a send after the conversation closes", async () => {
    const { buyer, seller } = await opened();
    expect(await call("/api/chat", { token: buyer, step: "resolve", outcome: "end" })).toMatchObject({
      status: 200,
      body: { state: "closed", outcome: "end" },
    });
    expect(await call("/api/chat", { token: seller, step: "send", text: "Wait!" })).toMatchObject({ status: 409, body: { error: "closed" } });
  });

  it("keeps the moderation endpoint shut without the key", async () => {
    expect(await call("/api/moderate", { step: "held" })).toMatchObject({ status: 401 });
    expect((await fetch(`${jevDemo.url}/moderate`)).status).toBe(200);
  });

  it("records a spent Jev cap as unavailable and holds the message", async () => {
    const capped = await startDemo({
      port: 0,
      chat: { jev: { apiKey: "k", fetch: fakeJev, dailyCap: 0 }, hooks: { onEvent: (e) => void events.push(e as never) } },
    });
    try {
      const o = (await fetch(`${capped.url}/api/open`, { method: "POST" }).then((r) => r.json())) as { links: { url: string }[] };
      const token = decodeURIComponent(o.links[0]!.url.split("#t=")[1]!);
      const res = await fetch(`${capped.url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, step: "send", text: "Tuesday works for me." }),
      });
      expect(await res.json()).toMatchObject({ ok: true, held: true });
      expect(events.at(-1)).toMatchObject({ type: "message_held", meta: { judgeFailure: "unavailable" } });
    } finally {
      await capped.close();
    }
  });
});
