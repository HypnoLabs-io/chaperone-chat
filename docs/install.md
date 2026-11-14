# Install guide

From `npm install` to a working chat on your own server. The examples use Next.js and Postgres. Any framework
works, because the handler is a plain `(Request) => Promise<Response>`, and any Postgres driver works.

Using a coding agent? Hand it the [install guide for agents](install-agent.md) instead.

- [Requirements](#requirements)
- [1. Install](#1-install)
- [2. Try the screen](#2-try-the-screen)
- [3. Set your secrets](#3-set-your-secrets)
- [4. Create the tables](#4-create-the-tables)
- [5. Create the chat](#5-create-the-chat)
- [6. Serve it](#6-serve-it)
- [7. Show it](#7-show-it)
- [8. Open a conversation](#8-open-a-conversation)
- [9. Run the sweep](#9-run-the-sweep)
- [10. Add moderation](#10-add-moderation)
- [See the whole thing](#see-the-whole-thing)
- [Next](#next)

## Requirements

- **Node 22 or later**, ESM or CommonJS. The server entries also run on Bun, Deno and edge workers.
- **React 18 or later**, only if you use the component. `chaperone-chat/client` works without a framework.
- **Postgres**, through any driver, for production. `memoryStore()` is enough to try it and to test.
- **A TypeSafe API key** to turn Jev on. It's optional: with `jev: false` the rules work alone.

The package has no runtime dependencies. It reads no environment variables and imports nothing from `node:` at run
time: you pass in every key and secret.

## 1. Install

```bash
npm install chaperone-chat
npm install pg   # the Postgres driver these examples use; any driver works
```

## 2. Try the screen

Before wiring anything, see what the rules refuse. This runs on the rules alone and keeps everything in memory.

```js
// try.mjs
import { createChat, memoryStore } from "chaperone-chat";

const chat = createChat({
  secret: crypto.randomUUID() + crypto.randomUUID(), // signs the links: use a fixed secret of your own in production
  store: memoryStore(),
  jev: false, // the rules alone; pass { apiKey } to add Jev
});

const { links } = await chat.open({
  participants: [
    { role: "buyer", alias: "Sam" },
    { role: "seller", alias: "Alex" },
  ],
});
const sam = links[0].participantId;

for (const text of [
  "Is the bike still for sale?",
  "Text me on 312 555 0142",
  "my number is three one two five five five zero one four two",
  "Let's move this to WhatsApp",
  "Can we meet at the shop on Saturday?",
]) {
  const result = await chat.send(sam, text);
  console.log(result.ok ? `sent     ${text}` : `refused  ${text}  (${result.message})`);
}
```

```text
$ node try.mjs
sent     Is the bike still for sale?
refused  Text me on 312 555 0142  (That looks like a phone number.)
refused  my number is three one two five five five zero one four two  (That looks like a phone number.)
refused  Let's move this to WhatsApp  (That names an app or site for talking or paying outside this chat.)
sent     Can we meet at the shop on Saturday?
```

## 3. Set your secrets

| Variable | What it is |
|---|---|
| `CHAT_LINK_SECRET` | Signs the participants' links. 32 characters or more. Make one with `node -e "console.log(crypto.randomBytes(32).toString('base64url'))"` |
| `DATABASE_URL` | Your Postgres connection string |
| `TYPESAFE_API_KEY` | Turns Jev on. Leave it out, and pass `jev: false`, to run the rules alone |

The names are only a convention: the package never reads them itself. To rotate the secret later without breaking
links already sent, see [links and secrets](configuration.md#links-and-secrets).

## 4. Create the tables

```bash
npx chaperone-chat schema | psql "$DATABASE_URL"
```

Every statement is `IF NOT EXISTS`, so you can instead call `await store.migrate()` on every boot. The tables, a
table prefix and other drivers are covered in [storage](storage.md).

## 5. Create the chat

One `createChat` for your whole app, with the store and Jev:

```ts
// lib/chat.ts
import { createChat } from "chaperone-chat";
import { postgresStore } from "chaperone-chat/postgres";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const chat = createChat({
  secret: process.env.CHAT_LINK_SECRET!, // 32 characters or more
  store: postgresStore((text, params) => pool.query(text, params)),
  jev: { apiKey: process.env.TYPESAFE_API_KEY! },
});
```

Every other option has a default: the deadline (7 days), the outcomes, the rules, the bands. The
[reference](reference.md) lists them all, and the [recipes](recipes.md) set them up for a marketplace, dating,
recruiting and peer support.

## 6. Serve it

The participants reach the chat through one route. Every request is a POST that carries the participant's token in
its JSON body.

```ts
// app/api/chat/route.ts
import { createChatHandler } from "chaperone-chat/http";
import { chat } from "../../../lib/chat";

export const POST = createChatHandler(chat);
```

On Node's own `http` server, or anywhere that takes `(req, res)`, wrap the handler with `toNodeHandler()`:

```ts
// server.ts
import { createServer } from "node:http";
import { createChatHandler, toNodeHandler } from "chaperone-chat/http";
import { chat } from "./lib/chat";

const handle = toNodeHandler(createChatHandler(chat));

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/chat") return void handle(req, res);
  res.statusCode = 404;
  res.end();
}).listen(3000);
```

The handler limits requests per participant by default. Behind several servers, give it a shared limiter: see
[the HTTP handlers](reference.md#the-http-handlers).

## 7. Show it

```tsx
// app/chat/page.tsx
"use client";
import { ChatThread } from "chaperone-chat/react";
import "chaperone-chat/react/styles.css";

export default function ChatPage() {
  return <ChatThread endpoint="/api/chat" />;
}
```

`<ChatThread>` reads the token from the page's `#t=` fragment, keeps it in session storage, and takes it out of the
address bar. Its look comes from `--cc-*` CSS variables, with dark-mode defaults, and `labels` changes or translates
every word it shows. Without React, `createChatClient()` from `chaperone-chat/client` takes the same options.

## 8. Open a conversation

Open a conversation from your own server code, and send each person their link:

```ts
// lib/start-conversation.ts
import { chat } from "./chat";

export async function startConversation(listingId: string, buyerId: string, sellerId: string) {
  const { links } = await chat.open({
    key: `listing:${listingId}:${buyerId}`, // opening twice with one key returns the first conversation
    participants: [
      { role: "buyer", alias: "Buyer", externalRef: buyerId },
      { role: "seller", alias: "Seller", externalRef: sellerId },
    ],
    context: { listingId }, // yours: stored, never shown to the participants
  });
  // Reach each person your own way: email, a push, your inbox. The token goes after "#", so it never reaches a
  // server log, and the page takes it out of the address bar.
  return links.map((link) => ({ userId: link.externalRef, url: `https://example.com/chat#t=${link.token}` }));
}
```

An alias is all the others see, so it may not hold a contact detail. `externalRef` is your own id for the person:
the package stores no contact details.

## 9. Run the sweep

Run the sweep every minute. It closes conversations past their deadline, checks held messages again, sends notices
and deletes old messages:

```ts
// lib/sweeper.ts
import { chat } from "./chat";

// In a long-running server:
chat.startSweeper({ onError: (error) => console.error("chat sweep failed", error) });
// On a serverless host, call `await chat.sweep()` from a cron route instead.
```

The sweep is idempotent: running it again does no harm. To email people about new messages, reminders
and closes, add `notify`: see [notifications](notifications.md).

## 10. Add moderation

A message waits in a held queue when its sender appeals a refusal, when Jev couldn't answer, or when a band you
set to `"hold"` catches it. Only its sender sees it while it waits. Moderators work the queue with
`chat.moderation` (`listHeld`, `approve`, `refuse`, `hide`, `retry`), or over HTTP with
`createModerationHandler(chat, { authorizeModerator })`, which can't be made without your own check. See
[moderation](moderation.md).

## See the whole thing

The repository has a demo: a chat page where each person's link opens in its own tab, through the real handler, and
a moderation page. Clone the repository, then:

```bash
npm ci        # also builds the package
npm run demo  # prints the address, http://127.0.0.1:3000
```

The demo runs on the rules alone and keeps everything in memory. Set `TYPESAFE_API_KEY` to put Jev behind the
rules, or `DATABASE_URL` to use Postgres. See `.env.example`.

## Next

- [Configuration](configuration.md): deadlines, outcomes, the rules, bands and observe mode, with examples.
- [Security model](security.md): links, requests, what is stored, and what it doesn't protect against.
- [What is sent to Jev](jev-data.md): before you turn Jev on, and for your privacy policy.
- [Limits](limits.md): what the tests prove, and what isn't in this version.
