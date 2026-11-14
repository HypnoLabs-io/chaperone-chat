/**
 * Runs the demo: node examples/demo/server.mjs, then open the address it prints.
 *
 * Reads from the environment (see .env.example):
 *   PORT              the port (default 3000)
 *   CHAT_LINK_SECRET  signs the links (default: a throwaway one, so links stop working on restart)
 *   TYPESAFE_API_KEY  turns Jev on (default: the rules alone)
 *   MODERATOR_KEY     the moderation page's key (default: a random one, printed below)
 *   DATABASE_URL      Postgres (default: the in-memory store); the tables are created if missing
 */
import { postgresStore } from "chaperone-chat/postgres";
import { startDemo } from "./app.mjs";

const secret = process.env.CHAT_LINK_SECRET?.trim() || undefined;
if (secret && secret.length < 32) {
  console.error("CHAT_LINK_SECRET must be at least 32 characters.");
  process.exit(1);
}

let store;
let pool;
if (process.env.DATABASE_URL?.trim()) {
  const { default: pg } = await import("pg");
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL.trim() });
  store = postgresStore((text, params) => pool.query(text, params), { prefix: "demo_chat_" });
  await store.migrate();
}

const demo = await startDemo({
  port: Number(process.env.PORT) || 3000,
  secret,
  store,
  jevKey: process.env.TYPESAFE_API_KEY?.trim() || undefined,
  moderatorKey: process.env.MODERATOR_KEY?.trim() || undefined,
});
console.log(`chaperone-chat demo: ${demo.url}`);
console.log("Start a conversation there, then open each person's link in its own tab.");
console.log(`Moderation: ${demo.url}/moderate  (key: ${demo.moderatorKey})`);
console.log(process.env.TYPESAFE_API_KEY?.trim() ? "Screening: the rules, then Jev." : "Screening: the rules alone (set TYPESAFE_API_KEY for Jev).");
console.log(store ? "Storage: Postgres (tables demo_chat_*)." : "Storage: in memory.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () =>
    demo
      .close()
      .then(() => pool?.end())
      .then(() => process.exit(0)),
  );
}
