// Part of `npm run smoke:pack`: type-checked, never run. The CommonJS side under node16 resolution.

import { createChat, memoryStore, type Chat } from "chaperone-chat";
import { scrub } from "chaperone-chat/guard";
import { postgresStore, type PostgresStore } from "chaperone-chat/postgres";
import { createModerationHandler } from "chaperone-chat/http";

export const chat: Chat = createChat({ secret: "w".repeat(32), store: memoryStore(), jev: false });
export const cleaned: Promise<string> = scrub("call 312 555 0142");
export const moderation = createModerationHandler(chat, { authorizeModerator: async () => false });
export const migrate = (s: PostgresStore): Promise<void> => s.migrate();
export const make = (q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => postgresStore(q);
