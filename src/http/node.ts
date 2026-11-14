/**
 * The handler on Node's own `http` server: `http.createServer(toNodeHandler(createChatHandler(chat)))`, or as a
 * route in Express (`app.post("/chat", toNodeHandler(handler))`). No `node:` import at run time, so this entry still
 * loads on edge runtimes; only its types come from Node.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type WebHandler = (req: Request) => Promise<Response>;

export interface NodeHandlerOptions {
  /** The largest body read before the handler sees it. Default 1 MB (the handler applies its own, smaller limit). */
  maxBodyBytes?: number;
}

export function toNodeHandler(
  handler: WebHandler,
  options: NodeHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  return async (req, res) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
      }
      let body: Uint8Array<ArrayBuffer> | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of req as AsyncIterable<Uint8Array | string>) {
          const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
          size += bytes.byteLength;
          if (size > maxBodyBytes) {
            res.statusCode = 413;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, error: "body_too_large" }));
            return;
          }
          chunks.push(bytes);
        }
        body = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          body.set(c, at);
          at += c.byteLength;
        }
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const response = await handler(
        new Request(url, { method: req.method ?? "GET", headers, body: body && body.byteLength ? body : undefined }),
      );
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.end(new Uint8Array(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      res.end(JSON.stringify({ ok: false, error: "server_error" }));
    }
  };
}
