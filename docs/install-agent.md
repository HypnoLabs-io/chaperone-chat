# Install guide for coding agents

This page is for a coding agent, such as Claude Code, Codex or Cursor, that is adding chaperone-chat to an app. It
covers the same ground as the [install guide](install.md), as steps to take in order: what to read in the project,
what to ask the person, what to write, and a check after each step. People can read it too.

To hand it to your agent, start the agent in your app's folder and say:

```text
Add chaperone-chat to this app. Follow https://raw.githubusercontent.com/HypnoLabs-io/chaperone-chat/main/docs/install-agent.md
```

- [How to work](#how-to-work)
- [0. Read the project](#0-read-the-project)
- [1. Ask the person](#1-ask-the-person)
- [2. Install](#2-install)
- [3. Set the secrets](#3-set-the-secrets)
- [4. Create the tables](#4-create-the-tables)
- [5. Create the chat](#5-create-the-chat)
- [6. Serve the route](#6-serve-the-route)
- [7. Show the page](#7-show-the-page)
- [8. Open conversations](#8-open-conversations)
- [9. Run the sweep](#9-run-the-sweep)
- [10. Moderation and notices](#10-moderation-and-notices)
- [11. Finish and report](#11-finish-and-report)
- [When a check fails](#when-a-check-fails)

## How to work

- **In order, and check each step.** Every step ends with a **Check**. Run it, and go on only when it passes.
- **Use the API on this page.** For anything else, the package's own types are the truth: every option has a
  comment in `node_modules/chaperone-chat/dist/*.d.ts`. Don't guess an option's name.
- **The package reads no environment variables.** The app reads them and passes the values in.
- **Secrets stay out of sight.** Never write a real secret or key into a tracked file, a log, a commit or your
  reply. Real values go only in the env file the project already ignores. If the project has a `.env.example`, it
  gets the names with empty values.
- **Tokens stay out of logs.** A participant's link is their credential. Its token goes after `#t=` in the page's
  address, and in the JSON body of a request: never in a query string, a log line or an analytics event.
- **Only development data.** Create tables and test conversations in a local or development database. **Ask**
  before touching any other.
- **Ask** marks a decision that belongs to the person. Everything else has a default on this page: use it, and
  list it in your report.
- **The project's own ways win.** Use its package manager, TypeScript or JavaScript, module system, folders,
  import aliases, formatter and lint rules. The paths on this page are examples.

## 0. Read the project

Change nothing yet. Find out:

| What | Where to look | Used in |
|---|---|---|
| The package manager | The lockfile: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` | [2](#2-install) |
| The Node version | `engines`, `.nvmrc`, `.node-version`, the host's settings | [2](#2-install) |
| The framework and router | The dependencies, and folders such as `app/` (Next.js App Router) or `pages/api/` (Pages Router) | [6](#6-serve-the-route), [7](#7-show-the-page) |
| Where the server runs | Long-running (a VM, a container, `next start`) or serverless and edge (Vercel, Netlify, Cloudflare Workers, Lambda) | [5](#5-create-the-chat), [9](#9-run-the-sweep) |
| The Postgres driver | `pg`, `postgres`, `@neondatabase/serverless`, or an ORM (Prisma, Drizzle, Kysely) and the driver beneath it. Also any module that already opens a connection | [5](#5-create-the-chat) |
| Migrations | A migrations folder, or a tool: Prisma Migrate, Drizzle Kit, Knex, node-pg-migrate | [4](#4-create-the-tables) |
| Existing `chat_` tables | The schema, or the ORM's models | [4](#4-create-the-tables) |
| React | `react` 18 or later in the dependencies | [7](#7-show-the-page) |
| How the app reaches its users | A mailer, push notices, an in-app inbox, sign-in | [8](#8-open-conversations) |
| Who is an admin | An admin role, or a session check the app already uses | [10](#10-moderation-and-notices) |
| The app's name and domains | The site's config, its metadata, `package.json` | [5](#5-create-the-chat) |

If the app runs on Node older than 22, stop and tell the person: the package needs Node 22 or later.

## 1. Ask the person

These are product decisions. Ask them together, in one message, each with its default, and go on with the default
for any the person leaves open. Where the app already suggests an answer (a marketplace with listings has a buyer
and a seller), propose that answer instead of asking an open question.

| Question | Default |
|---|---|
| Who talks to whom, and what starts a conversation? The roles, and the moment in the app: a "Message the seller" button, a match, an application | None: this one needs an answer |
| What name does each person see for the others? | The role: "Buyer", "Seller" |
| How can a conversation end, and who may end it each way? One vote, or everyone (a double opt-in)? | `end`, by anyone |
| What should the app do when it ends? Mark the item sold, share the two people's contact details, book the interview | Nothing |
| How long does a conversation run? | 7 days |
| Turn on Jev? It needs the person's own TypeSafe API key, and it sends message text to TypeSafe ([what is sent](jev-data.md)) | Off: the rules alone, wired so that setting the key turns Jev on |
| How does each person get to the conversation? | A button in the app that opens it, if people sign in. Otherwise **ask** |
| Email people about new messages, reminders and closes? | No |
| Who moderates, and how does the app know they may? | No moderation route. With Jev off, nothing is ever held, so there is nothing to moderate |

The [recipes](recipes.md) show these answers for a marketplace, dating, recruiting and peer support.

## 2. Install

```bash
npm install chaperone-chat
```

With another package manager: `pnpm add`, `yarn add` or `bun add`. If the project has no Postgres driver yet, add
`pg` too, and `@types/pg` in a TypeScript project.

**Check.** From the project's folder, this runs the rules on five messages and leaves no file behind:

```bash
node --input-type=module <<'EOF'
import { createChat, memoryStore } from "chaperone-chat";

const chat = createChat({ secret: "x".repeat(32), store: memoryStore(), jev: false });
const { links } = await chat.open({
  participants: [{ role: "buyer", alias: "Sam" }, { role: "seller", alias: "Alex" }],
});
for (const text of [
  "Is the bike still for sale?",
  "Text me on 312 555 0142",
  "my number is three one two five five five zero one four two",
  "Let's move this to WhatsApp",
  "Can we meet at the shop on Saturday?",
]) {
  const result = await chat.send(links[0].participantId, text);
  console.log(result.ok ? "sent   " : "refused", text);
}
EOF
```

It prints:

```text
sent    Is the bike still for sale?
refused Text me on 312 555 0142
refused my number is three one two five five five zero one four two
refused Let's move this to WhatsApp
sent    Can we meet at the shop on Saturday?
```

## 3. Set the secrets

| Name | Value |
|---|---|
| `CHAT_LINK_SECRET` | Signs every link: 32 characters or more. Make one with the command below |
| `DATABASE_URL` | The app's own, if it has one. Don't make a second |
| `TYPESAFE_API_KEY` | Only the person can get one. Leave it out |

Use the env file the project already loads (`.env.local`, `.env`). Write the secret straight into it, so it never
shows in your output:

```bash
echo "CHAT_LINK_SECRET=$(node -e "console.log(crypto.randomBytes(32).toString('base64url'))")" >> .env.local
```

Every server in one environment needs the same `CHAT_LINK_SECRET`, or a link made on one fails on another. Each
environment gets its own.

**Check.** `git check-ignore .env.local` prints the file's name, and `git status` doesn't list it.

## 4. Create the tables

Take the first case that fits:

- **The project has a migration tool.** Make a new migration the tool's way, with the output of
  `npx chaperone-chat schema` as its SQL. A tool that builds migrations from a schema file (Prisma, Drizzle) must
  also be told about the new tables, or its next generated migration may drop them: for example `prisma db pull`
  after applying it, or a table filter in Drizzle's config. **Ask** if the project leaves this unclear.
- **No migration tool, on a long-running server.** Call `await store.migrate()` at startup. Every statement is
  `IF NOT EXISTS`, so it is safe on every boot.
- **No migration tool, on a serverless host.** Run it once: `npx chaperone-chat schema | psql "$DATABASE_URL"`.
- **No database yet.** Use `memoryStore()` for now, and say in your report that it loses everything on restart and
  serves one process only, so it isn't for production.

If the database already has tables whose names start with `chat_`, use a prefix: pass `--prefix app_chat_` to
`npx chaperone-chat schema`, and `{ prefix: "app_chat_" }` to `postgresStore` in step 5.

**Check.** `psql "$DATABASE_URL" -c '\dt chat_*'` lists six tables: `chat_conversations`, `chat_participants`,
`chat_messages`, `chat_votes`, `chat_events` and `chat_meta`. Without `psql`, the check in
[step 8](#8-open-conversations) proves it.

## 5. Create the chat

One module makes one chat for the whole app, and everything else imports it:

```ts
// lib/chat.ts
import { createChat } from "chaperone-chat";
import { postgresStore } from "chaperone-chat/postgres";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const typesafeKey = process.env.TYPESAFE_API_KEY;

export const chat = createChat({
  secret: process.env.CHAT_LINK_SECRET!, // 32 characters or more
  store: postgresStore((text, params) => pool.query(text, params)),
  jev: typesafeKey ? { apiKey: typesafeKey } : false, // the rules alone until a key is set
  // From step 1, only what differs from the defaults:
  durationMs: 14 * 24 * 60 * 60 * 1000,
  outcomes: { sold: { by: ["seller"] }, end: { by: "*" } },
  // From the project: the app's own name, and its own domains, whose links pass.
  rules: { platformNames: ["Example"], domains: { allow: ["example.com"] } },
});
```

- **Write `jev` as it is here.** An empty key in `{ apiKey }` doesn't turn Jev off: every message the rules pass
  waits, held, for a check that can't run.
- **Reuse the app's connection.** If a module already opens a pool, pass that one rather than a second.
- **Hooks.** If step 1 says what the app does when a conversation ends, add `hooks.beforeClose`. It must be safe to
  run twice for one close. See [outcomes and closing](configuration.md#outcomes-and-closing).

`postgresStore` takes a `query(text, params)` that returns `{ rows }` or an array of rows:

| Driver | `query` |
|---|---|
| `pg` | `(text, params) => pool.query(text, params)` |
| PGlite | `(text, params) => db.query(text, params)` |
| `postgres` (postgres.js) | `(text, params) => sql.unsafe(text, params)`, casting `params` if the types complain |
| `@neondatabase/serverless` | `(text, params) => sql.query(text, params)` |
| An ORM | The driver beneath it: Drizzle's or Kysely's `pg` pool or postgres.js client. With Prisma, a `pg` pool on the same `DATABASE_URL` |

The package's tests run on `pg` and PGlite. For any other driver, the check in [step 8](#8-open-conversations) is
the proof. `pg` needs Node's sockets: on an edge runtime, use an HTTP driver such as Neon's, or run the route on
Node.

**Check.** The project's typecheck passes, and the server starts. `invalid_secret` at startup means the secret
isn't loaded ("no link secret was given") or is too short.

## 6. Serve the route

The participants reach the chat through one POST route. Next.js App Router:

```ts
// app/api/chat/route.ts
import { createChatHandler } from "chaperone-chat/http";
import { chat } from "../../../lib/chat";

export const POST = createChatHandler(chat);
```

Elsewhere, make `const handler = createChatHandler(chat)` once, at the top of a module, never per request: its rate
limiter lives in it. Then:

| Framework | The route |
|---|---|
| Next.js Pages Router | `pages/api/chat.ts`: `export default toNodeHandler(handler)`, with `export const config = { api: { bodyParser: false } }` |
| Express | `app.post("/api/chat", toNodeHandler(handler))`, placed before `app.use(express.json())` |
| Node's `http` | `toNodeHandler(handler)(req, res)` for a POST to that path |
| Hono | `app.post("/api/chat", (c) => handler(c.req.raw))` |
| SvelteKit | `src/routes/api/chat/+server.ts`: `export const POST = ({ request }) => handler(request)` |
| React Router 7, Remix | `export const action = ({ request }) => handler(request)` |
| Bun, Deno, Cloudflare Workers | Pass the `Request` for that path to `handler` |
| A framework that parsed the body already | Build a `Request` from it: `handler(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))`, then copy the status, headers and body back |

`toNodeHandler` comes from `chaperone-chat/http` too. The handler reads the body itself, so nothing may read it
first.

**Check.** With the dev server running (use its port):

```bash
curl -s -i -X POST http://localhost:3000/api/chat -H 'content-type: application/json' -d '{"token":"x","step":"load"}'
```

`401` with `{"ok":false,"error":"invalid_link"}` means the route works: it read the body and refused a made-up
token. Anything else: [when a check fails](#when-a-check-fails).

## 7. Show the page

Every link opens this page. With React and the Next.js App Router:

```tsx
// app/chat/page.tsx
"use client";
import { ChatThread } from "chaperone-chat/react";
import "chaperone-chat/react/styles.css";

export default function ChatPage() {
  return <ChatThread endpoint="/api/chat" />;
}
```

- **The look.** Set the `--cc-*` variables on `.cc-thread` in the app's own stylesheet, from its own colors and
  font: `--cc-bg`, `--cc-surface`, `--cc-ink`, `--cc-muted`, `--cc-line`, `--cc-accent`, `--cc-accent-ink`,
  `--cc-mine`, `--cc-theirs`, `--cc-warn`, `--cc-font`, `--cc-radius` and `--cc-gap`. Don't edit the package's
  stylesheet.
- **The words.** `labels` changes or translates any of them. `DEFAULT_LABELS` lists them all.
- **Without React.** `createChatClient({ endpoint })` from `chaperone-chat/client` takes the same options. The
  demo's page, [`examples/demo/index.html`](../examples/demo/index.html), uses it.
- **Headers.** Serve this page with `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`, the
  framework's usual way (Next.js: `headers()` in `next.config`). If the app has a Content Security Policy, the page
  needs nothing outside it. If it has none, say so in your report rather than adding one.

**Check.** It comes in step 8, which needs a real link.

## 8. Open conversations

Where step 1 says a conversation starts, open it on the server, and keep its ids against the app's own records:

```ts
// lib/start-conversation.ts
import { chat } from "./chat";

declare function saveChat(listingId: string, conversationId: string, people: { userId: string | null; participantId: string }[]): Promise<void>; // the app's

export async function startConversation(listingId: string, buyerId: string, sellerId: string) {
  const { conversation, links } = await chat.open({
    key: `listing:${listingId}:${buyerId}`, // opening twice with one key returns the first conversation
    participants: [
      { role: "buyer", alias: "Buyer", externalRef: buyerId },
      { role: "seller", alias: "Seller", externalRef: sellerId },
    ],
    context: { listingId }, // the app's own: stored, never shown to the participants
  });
  await saveChat(listingId, conversation.id, links.map((l) => ({ userId: l.externalRef, participantId: l.participantId })));
  return links;
}
```

Then get each person there, the way step 1 decided:

- **A button in the app.** The server checks that the signed-in user is that participant, makes a fresh link with
  `chat.link(participantId)`, and sends the browser to `https://example.com/chat#t=<token>`. Make a link only for
  the signed-in user's own participant.
- **An email or a push.** Send `https://example.com/chat#t=<token>` from each link `open()` returned, through the
  app's own mailer.

An alias is all the others see. `open()` refuses one that holds a contact detail (`invalid_input`), so never make
one from an email address or a phone number.

**Check.** With the dev server running, this opens a test conversation through the app's real database and
secret, sends three requests to the route, and prints the page's address. Use the env file from step 3, the route
and page from steps 6 and 7, the driver from step 5, and the prefix if there is one:

```bash
node --env-file=.env.local --input-type=module <<'EOF'
import { createChat } from "chaperone-chat";
import { postgresStore } from "chaperone-chat/postgres";
import pg from "pg";

const ROUTE = "http://localhost:3000/api/chat";
const PAGE = "http://localhost:3000/chat";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = postgresStore((text, params) => pool.query(text, params));
const chat = createChat({ secret: process.env.CHAT_LINK_SECRET, store, jev: false });

// The check's conversations carry this externalRef. Each run deletes the last one's first.
for (const { conversation } of await store.listConversations({ externalRef: "install-check", limit: 20 })) {
  await store.deleteConversation(conversation.id);
}
if (!process.env.CLEANUP) {
  const { links } = await chat.open({
    participants: [
      { role: "buyer", alias: "Check A", externalRef: "install-check" },
      { role: "seller", alias: "Check B", externalRef: "install-check" },
    ],
  });
  const token = links[0].token;
  for (const body of [{ step: "load" }, { step: "send", text: "Text me on 312 555 0142" }, { step: "send", text: "Is it still available?" }]) {
    const res = await fetch(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...body }) });
    const out = await res.json();
    console.log(res.status, body.step, out.ok ? "ok" : `${out.error}${out.kind ? ` (${out.kind})` : ""}`);
  }
  console.log(`${PAGE}#t=${token}`);
}
await pool.end();
EOF
```

It prints:

```text
200 load ok
422 send blocked (phone)
200 send ok
http://localhost:3000/chat#t=eyJ2Ijox…
```

If you can drive a browser, open the address it printed: the thread shows Check A's "Is it still available?", and
the address bar loses its `#t=` part. When you're done, run the same command with `CLEANUP=1` in front: it
deletes the check's conversation and opens no other.

With `memoryStore()`, the app's conversations live in its own process, out of this script's reach. The check in
step 6 is as far as it goes.

## 9. Run the sweep

The sweep closes conversations past their deadline, checks held messages again, sends notices and deletes old
messages. Run it every minute. It is idempotent, so two at once do no harm.

On a long-running server, start it once at startup. With Next.js on its own Node server:

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { chat } = await import("./lib/chat");
    chat.startSweeper({ onError: (error) => console.error("chat sweep failed", error) });
  }
}
```

On a serverless host, call it from a cron route that only the scheduler can call:

```ts
// app/api/chat/sweep/route.ts
import { chat } from "../../../../lib/chat";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response(null, { status: 401 });
  return Response.json(await chat.sweep());
}
```

On Vercel, add `{ "crons": [{ "path": "/api/chat/sweep", "schedule": "* * * * *" }] }` to `vercel.json` and set
`CRON_SECRET`: Vercel sends it as that header. On Cloudflare Workers, a `scheduled` handler with a `* * * * *`
trigger calls `ctx.waitUntil(chat.sweep())`. Some plans run crons less often than every minute, which delays
closes and notices: **ask** if the host can't run it every minute.

**Check.** For the cron route: without the header it answers 401, and with it, a report of counts:
`{"expired":0,"finished":0,"retried":{…},"notices":{…},"deleted":0,"pruned":0}`. For `startSweeper`: the server
logs no "chat sweep failed" for a few minutes.

## 10. Moderation and notices

**Moderation** is needed only with Jev on: with `jev: false`, nothing is ever held. Say so in your report and skip
it. With Jev on, put the moderators' route behind the app's own admin check:

```ts
// app/api/chat/moderate/route.ts
import { createModerationHandler } from "chaperone-chat/http";
import { chat } from "../../../../lib/chat";

declare function isModerator(req: Request): Promise<boolean>; // the app's own admin check

export const POST = createModerationHandler(chat, { authorizeModerator: (req) => isModerator(req) });
```

Never pass a check that always says yes, one that trusts a value the request sends, or a password kept in the
browser's code. The check runs before the handler reads the body, so it may read headers and cookies but not the
body. If the app has no admin role, **ask**. A moderation screen is a project of its own: **ask** before
building one. [Moderation](moderation.md) has the requests it answers.

**Notices**, if step 1 said yes: add `notify` to `createChat`, with a `send` that hands each notice to the app's
mailer, as in [wiring it](notifications.md#wiring-it). `renderNotice()` words them and never quotes a message.

**Check.** The project's typecheck passes. For moderation, a request without a moderator's session answers 401
`not_authorized`.

## 11. Finish and report

Run the project's typecheck, lint and tests, and the step 8 check with `CLEANUP=1`. Then tell the person:

- the files you added and changed;
- the environment variables each environment needs, by name only, and that `CHAT_LINK_SECRET` is one value per
  environment, shared by all of its servers;
- the defaults you took from step 1, and the answers you used;
- what is still theirs to do: a TypeSafe key to turn Jev on (and [what is sent to Jev](jev-data.md), for their
  privacy policy), the sweep's schedule on their host, moderators, a Content Security Policy if there's none, and
  a shared rate limiter if the route runs on several servers ([the HTTP handlers](reference.md#the-http-handlers));
- anything you couldn't check, such as the page in a browser.

## When a check fails

| What you see | Why | Fix |
|---|---|---|
| `400 invalid_body` from the route | Something read the body before the handler: `express.json()` ahead of the route, or the Pages Router's body parser | Mount the route before the parser, or set `bodyParser: false` |
| `415 unsupported_media_type` | The request has no `content-type: application/json` | Send the header |
| `405 method_not_allowed` | The request isn't a POST | POST it |
| `404`, or an HTML page | Nothing serves that path | Check the route's file and path against step 6 |
| `401 invalid_link` with a fresh token | The script and the app sign with different secrets | Load the same env file in both |
| `404 not_found` with a fresh token | The script and the app use different databases or prefixes | Use the same `DATABASE_URL` and prefix |
| `invalid_secret` at startup | "No link secret was given": `CHAT_LINK_SECRET` is missing or not loaded. Otherwise it is shorter than 32 characters | Check the env file and how the app loads it |
| `invalid_option` at startup, naming `apiKey` | `jev` was given no key | `jev: key ? { apiKey: key } : false` |
| Every message the rules pass is `held` | `jev` was given an empty key | The same |
| `invalid_input` from `open()`, about an alias | The alias holds a contact detail | Use the role, or a name without one |
| A Next.js error about hooks in a Server Component | The page has no `"use client"` | Add it as the first line |
| The thread has no styles | The stylesheet isn't imported | `import "chaperone-chat/react/styles.css"` |
| `pg` fails on an edge runtime | `pg` needs Node's sockets | Run the route on Node, or use an HTTP driver |
| The page says "This link doesn't work." | The token went into a query string, or the link points at another page | Link to the page from step 7, with `#t=<token>` |
| Conversations never expire, and no notices go out | The sweep isn't running | Step 9 |
