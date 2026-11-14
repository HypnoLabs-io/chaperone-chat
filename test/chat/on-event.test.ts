/**
 * `hooks.onEvent` sees every event the chat records, including the three recorded as claims (a Jev call under the
 * daily cap, a notice under its budget, the once-a-day trouble alert), each once it is recorded.
 */
import { describe, expect, it } from "vitest";
import { createChat, memoryStore, type ChatEvent, type Notice } from "../../src";

const SECRET = "test-secret-0123456789-0123456789";
const T0 = new Date("2026-03-01T12:00:00.000Z").getTime();

/** Jev's network, answering every question with `p`. */
const jevAt = (p: number) =>
  (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(Object.keys(body.questions).map((n) => [n, { type: "noul", noul: p }]));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 600, output_tokens: 1 } }));
  }) as typeof fetch;

function setup(options: { dailyCap?: number } = {}) {
  let now = T0;
  const seen: ChatEvent[] = [];
  const notices: Notice[] = [];
  const chat = createChat({
    secret: SECRET,
    store: memoryStore({ clock: () => new Date(now) }),
    jev: { apiKey: "k", fetch: jevAt(0.05), ...(options.dailyCap !== undefined ? { dailyCap: options.dailyCap } : {}) },
    hooks: { onEvent: (e) => void seen.push(e) },
    notify: { send: (n) => void notices.push(n) },
  });
  return { chat, seen, notices, advance: (ms: number) => void (now += ms) };
}

const people = [
  { role: "buyer", alias: "Buyer" },
  { role: "seller", alias: "Seller" },
];

describe("onEvent", () => {
  it("sees each Jev call with what it recorded: the policy, the score, the model and the usage", async () => {
    const { chat, seen } = setup();
    const { links } = await chat.open({ participants: people });
    await chat.send(links[0]!.participantId, "Is it still available?");
    expect(seen.map((e) => e.type)).toEqual(["conversation_opened", "jev_call", "message_sent"]);
    expect(seen[1]!.meta).toEqual({ policy: "contact", p: 0.05, model: "jev-1.13.0", usage: { inputTokens: 600, outputTokens: 1 } });
    expect(seen[1]!.conversationId).toBe(seen[0]!.conversationId);
    expect(seen[1]!.participantId).toBe(links[0]!.participantId);
  });

  it("sees each notice handed to notify.send", async () => {
    const { chat, seen, notices, advance } = setup();
    const { links } = await chat.open({ participants: people });
    await chat.send(links[0]!.participantId, "Is it still available?");
    advance(5 * 60_000);
    await chat.sweep();
    expect(notices.map((n) => n.kind)).toEqual(["message"]);
    const sent = seen.filter((e) => e.type === "notice_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.meta).toEqual({ kind: "message" });
    expect(sent[0]!.participantId).toBe(links[1]!.participantId);
  });

  it("sees the trouble alert and its notice", async () => {
    const { chat, seen, notices } = setup({ dailyCap: 1 });
    const { links } = await chat.open({ participants: people });
    await chat.send(links[0]!.participantId, "Is it still available?");
    // The cap is spent: this one waits for a check.
    expect((await chat.send(links[0]!.participantId, "Can you hold it until Friday?")).ok).toBe(true);
    await chat.sweep();
    expect(notices.filter((n) => n.kind === "trouble")).toHaveLength(1);
    const alerts = seen.filter((e) => e.type === "trouble_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.meta).toEqual({ why: "cap", calls: 1 });
    expect(seen.filter((e) => e.type === "notice_sent" && (e.meta as { kind?: string }).kind === "trouble")).toHaveLength(1);
  });
});
