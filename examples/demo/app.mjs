/**
 * The demo: a plain Node server with two pages. Start a conversation, open each person's link in its own tab, and
 * chat; moderate what is held at /moderate. No build step of its own; it imports the package by name (`npm ci`
 * builds it).
 *
 * Routes:
 *   GET  /             the chat page (starts a conversation, or shows one when the URL carries a link)
 *   GET  /moderate     the moderation page (asks for the moderator key)
 *   GET  /client.js    the browser client, as built
 *   POST /api/open     opens a conversation between a buyer and a seller; answers each one's link
 *   POST /api/chat     the participants' endpoint (createChatHandler)
 *   POST /api/moderate the moderators' endpoint (createModerationHandler), behind the moderator key
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createChat, memoryStore } from "chaperone-chat";
import { createChatHandler, createModerationHandler, toNodeHandler } from "chaperone-chat/http";

const PAGES = {
  "/": new URL("./index.html", import.meta.url),
  "/moderate": new URL("./moderate.html", import.meta.url),
};
const CLIENT = new URL("../../dist/client/index.js", import.meta.url);

/**
 * Starts the demo and resolves once it listens.
 * @param {{
 *   port?: number, host?: string, secret?: string, moderatorKey?: string, jevKey?: string,
 *   store?: import("chaperone-chat").Store,
 *   chat?: Partial<import("chaperone-chat").ChatConfig>,
 *   handler?: import("chaperone-chat/http").HandlerOptions,
 * }} [options]
 */
export async function startDemo(options = {}) {
  const secret = options.secret || randomBytes(32).toString("base64url");
  const moderatorKey = options.moderatorKey || randomBytes(18).toString("base64url");
  const chat = createChat({
    secret,
    store: options.store ?? memoryStore(),
    jev: options.jevKey ? { apiKey: options.jevKey } : false,
    ...options.chat,
  });
  const participants = toNodeHandler(createChatHandler(chat, options.handler));
  const expected = Buffer.from(`Bearer ${moderatorKey}`);
  const moderators = toNodeHandler(
    createModerationHandler(chat, {
      authorizeModerator(req) {
        const given = Buffer.from(req.headers.get("authorization") ?? "");
        return given.length === expected.length && timingSafeEqual(given, expected);
      },
    }),
  );

  async function open(res) {
    const opened = await chat.open({
      participants: [
        { role: "buyer", alias: "Buyer" },
        { role: "seller", alias: "Seller" },
      ],
    });
    send(
      res,
      200,
      "application/json",
      JSON.stringify({
        ok: true,
        conversationId: opened.conversation.id,
        links: opened.links.map((l) => ({ alias: l.alias, role: l.role, url: `/#t=${l.token}` })),
      }),
    );
  }

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://demo").pathname;
      if (req.method === "POST" && path === "/api/chat") return await participants(req, res);
      if (req.method === "POST" && path === "/api/moderate") return await moderators(req, res);
      if (req.method === "POST" && path === "/api/open") return await open(res);
      if (req.method === "GET" && PAGES[path]) return send(res, 200, "text/html; charset=utf-8", await readFile(PAGES[path]));
      if (req.method === "GET" && path === "/favicon.ico") return send(res, 204, "image/x-icon", "");
      if (req.method === "GET" && path === "/client.js") {
        const code = await readFile(CLIENT).catch(() => null);
        return code
          ? send(res, 200, "text/javascript; charset=utf-8", code)
          : send(res, 503, "text/plain; charset=utf-8", "Build the package first: npm run build");
      }
      send(res, 404, "text/plain; charset=utf-8", "Not found");
    } catch {
      send(res, 500, "text/plain; charset=utf-8", "Something went wrong");
    }
  });

  await new Promise((ready) => server.listen(options.port ?? 3000, options.host ?? "127.0.0.1", ready));
  const address = server.address();
  return {
    url: `http://${address.address}:${address.port}`,
    moderatorKey,
    chat,
    server,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function send(res, status, type, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(body);
}
