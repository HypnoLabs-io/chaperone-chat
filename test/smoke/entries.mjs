// Part of `npm run smoke:pack`: every entry of the installed package, imported from ESM, each with one real call.

import assert from "node:assert/strict";
import { createChat, memoryStore, renderNotice, EVENT } from "chaperone-chat";
import { has, scrub, contactLeak, definePolicy, CONTACT_CUTOFFS } from "chaperone-chat/guard";
import { createJevClient, DEFAULT_JEV_MODEL, suggestCutoffs } from "chaperone-chat/jev";
import { createLinks } from "chaperone-chat/links";
import { createChatHandler, createModerationHandler, toNodeHandler, memoryRateLimiter } from "chaperone-chat/http";
import { postgresStore, schemaSql } from "chaperone-chat/postgres";
import { createChatClient, readFragmentToken } from "chaperone-chat/client";
import { ChatThread, useChatThread, DEFAULT_LABELS } from "chaperone-chat/react";

for (const f of [createChat, memoryStore, renderNotice, has, scrub, contactLeak, definePolicy, createJevClient, suggestCutoffs, createLinks, createChatHandler, createModerationHandler, toNodeHandler, memoryRateLimiter, postgresStore, schemaSql, createChatClient, readFragmentToken, ChatThread, useChatThread]) assert.equal(typeof f, "function");
assert.equal(DEFAULT_JEV_MODEL, "jev-1.13.0");
assert.equal(EVENT.jevCall, "jev_call");
assert.equal(CONTACT_CUTOFFS["off-platform"].block, 0.5);
assert.equal(DEFAULT_LABELS.send, "Send");
assert.equal(await has("mail me at sam@example.org"), true);
assert.match(schemaSql(), /CREATE TABLE IF NOT EXISTS chat_conversations/);
const links = createLinks({ secret: "x".repeat(32) });
const token = await links.sign({ kind: "chat", subject: "p_1", ttlMs: 60_000 });
assert.deepEqual((await links.verify(token, "chat")).ok, true);
const css = import.meta.resolve("chaperone-chat/react/styles.css");
assert.match(css, /dist\/react\/styles\.css$/);
console.log("ESM: every entry imports and works; styles.css resolves to", css.replace(/^.*node_modules\//, ""));
