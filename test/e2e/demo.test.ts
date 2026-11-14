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
