// Part of `npm run smoke:pack`: type-checked, never run. The ESM side under node16 resolution.

import { createChat, memoryStore, type Chat, type ChatConfig, type SendResult, type Store, type Notice } from "chaperone-chat";
import { contactLeak, definePolicy, type Policy, type Verdict } from "chaperone-chat/guard";
import { createJevClient, type JevClient } from "chaperone-chat/jev";
import { createLinks } from "chaperone-chat/links";
import { createChatHandler, toNodeHandler, type HandlerOptions } from "chaperone-chat/http";
import { postgresStore, type PostgresStore } from "chaperone-chat/postgres";
import { createChatClient, type ClientState } from "chaperone-chat/client";
import pg from "pg";

const pool = new pg.Pool();
const store: PostgresStore = postgresStore((text, params) => pool.query(text, params));
await store.migrate();
const config: ChatConfig = { secret: "z".repeat(32), store: memoryStore() as Store, jev: false, policies: [contactLeak({ scope: "details-only" })] };
const chat: Chat = createChat(config);
const result: SendResult = await chat.send("p_1", "hello");
if (!result.ok) result.reason satisfies "not_found" | "closed" | "empty" | "too_long" | "too_many" | "blocked";
const options: HandlerOptions = { rateLimit: false };
export const handler = toNodeHandler(createChatHandler(chat, options));
export const client: JevClient = createJevClient({ apiKey: () => process.env.KEY });
export const policy: Policy = definePolicy({ id: "x", question: "q?", counts: [{ id: "a", text: "a" }], doesntCount: [{ id: "b", text: "b" }], reason: "r" });
export const links = createLinks({ secret: ["a".repeat(32), "b".repeat(32)] });
export const state: ClientState = createChatClient({ endpoint: "/api/chat", token: null }).getState();
export type V = Verdict;
export const onNotice = (n: Notice) => (n.kind === "trouble" ? n.why : n.participant.externalRef);
