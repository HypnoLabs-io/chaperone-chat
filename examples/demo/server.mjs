/**
 * Runs the demo: node examples/demo/server.mjs, then open the address it prints.
 *
 * Reads PORT and CHAT_LINK_SECRET from the environment (see .env.example). With no secret, it makes a throwaway one,
 * so links stop working when the server restarts. Runs on the rules alone.
 */
import { startDemo } from "./app.mjs";

const secret = process.env.CHAT_LINK_SECRET?.trim() || undefined;
if (secret && secret.length < 32) {
  console.error("CHAT_LINK_SECRET must be at least 32 characters.");
  process.exit(1);
}

const demo = await startDemo({ port: Number(process.env.PORT) || 3000, secret });
console.log(`chaperone-chat demo: ${demo.url}`);
console.log("Start a conversation there, then open each person's link in its own tab.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => demo.close().then(() => process.exit(0)));
}
