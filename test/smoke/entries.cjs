// Part of `npm run smoke:pack`: every entry of the installed package, required from CommonJS, and one conversation
// through the HTTP handler.

const assert = require("node:assert/strict");
const { createChat, memoryStore } = require("chaperone-chat");
const { has } = require("chaperone-chat/guard");
const { createJevClient } = require("chaperone-chat/jev");
const { createLinks } = require("chaperone-chat/links");
const { createChatHandler } = require("chaperone-chat/http");
const { postgresStore } = require("chaperone-chat/postgres");
const { createChatClient } = require("chaperone-chat/client");
const { ChatThread } = require("chaperone-chat/react");
const pkg = require("chaperone-chat/package.json");

(async () => {
  for (const f of [createChat, memoryStore, has, createJevClient, createLinks, createChatHandler, postgresStore, createChatClient, ChatThread]) assert.equal(typeof f, "function");
  assert.equal(pkg.version, "0.1.0");
  const chat = createChat({ secret: "y".repeat(32), store: memoryStore(), jev: false });
  const { links } = await chat.open({ participants: [{ role: "a", alias: "A" }, { role: "b", alias: "B" }] });
  const handler = createChatHandler(chat);
  const post = (body) => handler(new Request("http://x/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const sent = await post({ token: links[0].token, step: "send", text: "Hello there" });
  assert.equal(sent.status, 200);
  const blocked = await post({ token: links[0].token, step: "send", text: "email me: a@b.co" });
  assert.equal(blocked.status, 422);
  const thread = await (await post({ token: links[1].token, step: "load" })).json();
  assert.deepEqual(thread.thread.messages.map((m) => m.body), ["Hello there"]);
  console.log("CJS: every entry requires; a conversation runs through the handler (200, 422, the other side reads one message)");
})().catch((e) => { console.error(e); process.exit(1); });
