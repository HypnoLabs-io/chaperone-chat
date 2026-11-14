/**
 * The demo: a plain Node server with one page. Start a conversation, open each person's link in its own tab, and
 * chat. No build step of its own; it imports the package by name (`npm ci` builds it).
 *
 * Routes:
 *   GET  /            the page (starts a conversation, or shows one when the URL carries a link)
 *   GET  /client.js   the browser client, as built
 *   POST /api/open    opens a conversation between a buyer and a seller; answers each one's link
 *   POST /api/chat    the chat itself (createChatHandler)
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createChat, memoryStore } from "chaperone-chat";
import { createChatHandler, toNodeHandler } from "chaperone-chat/http";

const PAGE = new URL("./index.html", import.meta.url);
const CLIENT = new URL("../../dist/client/index.js", import.meta.url);

/**
 * Starts the demo and resolves once it listens.
 * @param {{ port?: number, host?: string, secret?: string, store?: import("chaperone-chat").Store, chat?: Partial<import("chaperone-chat").ChatConfig>, handler?: import("chaperone-chat/http").HandlerOptions }} [options]
 */
export async function startDemo(options = {}) {
  const secret = options.secret || randomBytes(32).toString("base64url");
  const chat = createChat({ secret, store: options.store ?? memoryStore(), jev: false, ...options.chat });
  const handle = toNodeHandler(createChatHandler(chat, options.handler));

  async function open(req, res) {
    const opened = await chat.open({
      participants: [
        { role: "buyer", alias: "Buyer" },
        { role: "seller", alias: "Seller" },
      ],
    });
    send(res, 200, "application/json", JSON.stringify({
      ok: true,
      links: opened.links.map((l) => ({ alias: l.alias, role: l.role, url: `/#t=${l.token}` })),
    }));
  }

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://demo").pathname;
      if (req.method === "POST" && path === "/api/chat") return await handle(req, res);
      if (req.method === "POST" && path === "/api/open") return await open(req, res);
      if (req.method === "GET" && path === "/") return send(res, 200, "text/html; charset=utf-8", await readFile(PAGE));
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
  const url = `http://${address.address}:${address.port}`;
  return {
    url,
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
