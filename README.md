# chaperone-chat

An anonymous chat that keeps contact details out. Two or more people talk through signed links and see only each
other's aliases. Every message passes deterministic rules, then TypeSafe's Jev, before anyone else sees it.

Use it where a conversation should stay on your platform until something is agreed: a buyer and a seller before
the sale, two matches before both say yes, a recruiter and a candidate before an interview, a renter and a landlord
before a viewing, two strangers in a peer-support chat.

```bash
npm install chaperone-chat
```

Node 22 or later, ESM or CommonJS, no runtime dependencies. React 18 or later only if you use the component.

## Contents

- [What's in the box](#whats-in-the-box)
- [How a message is checked](#how-a-message-is-checked)
- [Quickstart](#quickstart)
- [The parameters](#the-parameters)
- [Recipes](#recipes)
- [Jev](#jev)
- [What the tests prove, and what they don't](#what-the-tests-prove-and-what-they-dont)
- [Not in this version](#not-in-this-version)
- [Docs](#docs)

## What's in the box

| Import | What it is |
|---|---|
| `chaperone-chat` | `createChat(config)`: conversations, the screen, outcomes, moderation, notices and the sweep |
| `chaperone-chat/http` | `createChatHandler(chat)`: one Web-standard `(Request) => Promise<Response>` route for the participants, a moderators' handler, and a Node adapter |
| `chaperone-chat/postgres` | `postgresStore(query)` over any Postgres driver, and the schema |
| `chaperone-chat/react` | `<ChatThread>` and `useChatThread()`, styled with plain CSS variables |
| `chaperone-chat/client` | The participant's side in the browser, with no framework |
| `chaperone-chat/guard` | The screen on its own, for profiles, listings and forms |
| `chaperone-chat/jev` | A typed Jev client and the calibration helpers |
| `chaperone-chat/links` | The signed link tokens, on WebCrypto |
| `npx chaperone-chat` | `calibrate` a policy against Jev, and print the Postgres `schema` |

The server entries run on Node, Bun, Deno and edge workers. They read no environment variables and import nothing
from `node:` at run time: you pass in every key and secret.

## How a message is checked

1. **The rules.** Regular expressions over a normalized copy of the text find email addresses, phone numbers,
   links, handles, street addresses, the names of apps to move to, and asks to move ("text me", "find me on…").
   They read digits spelled out as words and letters spaced apart, in English and Spanish. A hit refuses the
   message at once, with a sentence that says why. Jev isn't called.
2. **The split-message pass.** The sender's last five messages from the past day are read together with the new
   one, to catch an email address or a phone number sent in pieces.
3. **Jev.** Jev reads whatever the rules pass, along with the conversation before it, in one request per policy.
   Its probability falls in a band:
   - at or above `block`: refused;
   - at or above `review`: refused with an appeal, so the sender can send it for a check;
   - below `review`: sent.
4. **The fallback.** When Jev can't answer (no key, the daily cap is spent, an error, or a policy that isn't
   calibrated for the model), the message is held for a later check by default. Nothing unchecked goes out.

A refused message is never stored. A held message is stored, and only its sender sees it until it is checked
again or a moderator decides. The others never learn that it existed.

The rules are strict on purpose. They also refuse a few clean messages, such as an app named in passing ("My
sister uses Venmo for everything"). The sender reads why and can rephrase, and `apps.allow` lets a name through.

## Quickstart

### 1. Try the screen

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

### 2. Serve it

This example uses three files in a Next.js app. Any framework works: the handler is a plain
`(Request) => Promise<Response>`.

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

```ts
// app/api/chat/route.ts
import { createChatHandler } from "chaperone-chat/http";
import { chat } from "../../../lib/chat";

export const POST = createChatHandler(chat);
```

```tsx
// app/chat/page.tsx
"use client";
import { ChatThread } from "chaperone-chat/react";
import "chaperone-chat/react/styles.css";

export default function ChatPage() {
  return <ChatThread endpoint="/api/chat" />;
}
```

Create the tables once with `npx chaperone-chat schema | psql "$DATABASE_URL"`. Every statement is
`IF NOT EXISTS`, so you can also call `await store.migrate()` on every boot.

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

Run the sweep every minute. It closes conversations past their deadline, checks held messages again, sends
notices and deletes old messages:

```ts
// lib/sweeper.ts
import { chat } from "./chat";

// In a long-running server:
chat.startSweeper({ onError: (error) => console.error("chat sweep failed", error) });
// On a serverless host, call `await chat.sweep()` from a cron route instead.
```

Moderators get a queue of held messages and a handler of their own, behind your own check:
[moderation](docs/moderation.md).

### 3. See the whole thing

The repository has a demo: a chat page where each person's link opens in its own tab, through the real handler, and
a moderation page. Clone the repository, then:

```bash
npm ci        # also builds the package
npm run demo  # prints the address, http://127.0.0.1:3000
```

The demo runs on the rules alone and keeps everything in memory. Set `TYPESAFE_API_KEY` to put Jev behind the
rules, or `DATABASE_URL` to use Postgres. See `.env.example`.

## The parameters

Every value the engine would otherwise hard-code is an option with a default.

### `createChat(config)`

| Option | Default | What it does |
|---|---|---|
| `secret` | required | Signs the participants' links. Each secret is 32 characters or more; with a list, the first signs and any of them verifies, so you can rotate without breaking links already sent |
| `store` | required | `memoryStore()`, `postgresStore(query)`, or your own `Store` |
| `jev` | required | `{ apiKey }` turns Jev on, or `false` keeps the rules alone. `apiKey` may be a function. Also `model` (`jev-1.13.0`), `timeoutMs` (3,000), `dailyCap` (2,000 calls a day across every conversation; `null` for none), `baseUrl` and `fetch` |
| `durationMs` | 7 days | How long a conversation runs; `null` for no deadline. `open()` can override it for one conversation |
| `messages` | | `maxChars` (1,000), `perParticipantPerDay` (50; `null` for no limit), `pageSize` (200) |
| `links` | | `graceMs`: how long a link works past the deadline (3 days). `ttlMs`: a link's life with no deadline (30 days) |
| `rules` | every kind on | What the rules read: [below](#the-rules) |
| `window` | 5 messages, 24 hours | The split-message pass, `{ maxEarlier, hours }`, or `false` |
| `policies` | `[contactLeak()]` | What Jev is asked. `contactLeak({ scope: "details-only" })` counts only actual contact details; `definePolicy()` makes your own ([calibration](docs/calibration.md)) |
| `bands` | `{ block: "refuse", review: "appealable" }` | What each band does. `block`: `refuse` or `hold` for a moderator. `review`: `appealable`, `hold` or `send` |
| `appeals` | `true` | Whether a refusal in the review band may be sent again for a check |
| `fallback` | `"hold"` | When Jev can't answer: `hold` the message for a later check, `send` it on the rules alone, or `refuse` it |
| `mode` | `"enforce"` | `"observe"` delivers everything and records what `enforce` would have stopped, for a safe rollout |
| `contextTurns` | 8 | How many earlier delivered messages Jev reads with the new one |
| `reasons` | | The sentence a sender sees, by kind (`email`, `phone`, `link`, `handle`, `address`, `app`, `ask`), plus `window.email` and `window.phone` |
| `notes` | | What a sender reads on their own message that wasn't delivered: `held`, `refused`, `hidden` |
| `outcomes` | `{ end: { by: "*" } }` | How a conversation can end: `{ name: { by: roles or "*", requires: "any" or "all" } }`. `all` is a double opt-in |
| `expiredOutcome` | `"expired"` | The outcome a conversation closes with at its deadline |
| `hooks` | | `beforeClose(ctx)` runs before a close commits and may refuse it. `onEvent(event)` sees every event: ids and numbers, never message text |
| `notify` | off | `{ send(notice), everyMinutes (60), graceMinutes (2), reminderBeforeMs (48 hours), maxPerDay, kinds }`: [notifications](docs/notifications.md) |
| `retention` | | `deleteMessagesAfterCloseDays` (30; `null` keeps them), `pruneEventsAfterDays` (`null`) |
| `staleClosingMs` | 5 minutes | How long a close waits on a `beforeClose` that threw before the sweep asks it again |
| `scrubber` | the rules | A detection method of your own to run instead; the rules stay its fallback |

### `chat.open(input)`

| Field | What it is |
|---|---|
| `participants` | 2 to 50, each `{ role, alias, externalRef? }`. Everyone sees the aliases, so an alias may not hold a contact detail. `externalRef` is your own id for the person: the package stores no contact details |
| `durationMs` | This conversation's deadline instead of the chat's, or `null` for none |
| `context` | Your own JSON about the conversation. Stored; moderators and `beforeClose` see it, participants never do |
| `key` | An idempotency key: opening twice with one key returns the first conversation, with `created: false` |

It returns `{ created, conversation, links }`, with one link per participant in the order given:
`{ participantId, role, alias, externalRef, token, expiresAt }`. Put the token in your chat page's fragment:
`https://example.com/chat#t=<token>`.

### The rest of `chat`

| Method | What it does |
|---|---|
| `link(participantId)` | A fresh link for a participant, to send again |
| `verify(token)` | `{ ok: true, participantId }`, or `{ ok: false, reason }` |
| `load(participantId, { since })` | One participant's view: who's there, the messages, the outcomes they may choose |
| `send(participantId, text, { appeal })` | One message through the screen: `{ ok: true, message, held }`, or `{ ok: false, reason }` |
| `resolve(participantId, outcome)` | A participant chooses how the conversation ends |
| `close(conversationId, outcome, { by })` | Your server ends it |
| `moderation` | `listHeld`, `thread`, `approve`, `refuse`, `hide`, `retry`: [moderation](docs/moderation.md) |
| `sweep()`, `startSweeper()` | Expiry, closes that are stuck, held messages, notices and retention, as one idempotent call |

### The rules

These are `rules` in `createChat`, or the options of `createGuard()` on its own (`chaperone-chat/guard`).

| Option | Default | What it does |
|---|---|---|
| `kinds` | all on | `{ email, phone, link, handle, address, app, ask }`, each `true` or `false` |
| `locales` | `["en", "es"]` | The languages whose number words, spellings and asks are read. A `Locale` object adds your own |
| `region` | `"us"` | Local phone and street-address formats; `null` for none, or a `Region` object of your own |
| `apps` | every group | `groups` turns `messaging`, `payments`, `scheduling`, `marketplaces` or `meetings` on or off. `extra` adds names to refuse; `allow` lists names that pass |
| `domains` | | `allow`: your own domains, whose links pass. `extraTlds`: more endings a bare domain may have |
| `streets` | | `named`: street names written without a suffix, read after a house number ("1600 Broadway") |
| `platformNames` | | Your product's names. "Off Acme" counts as asking to move, and Jev reads them as "this platform" |
| `custom` | | Detectors of your own, `{ kind, pattern, keep }`. Every quantifier must be bounded |

### The HTTP handlers

`createChatHandler(chat, options)` serves the participants. Every request is a POST that carries the token in its
JSON body.

| Option | Default | What it does |
|---|---|---|
| `rateLimit` | 120 reads and 30 writes a minute, per participant, in memory | `{ reads, writes, windowMs, limiter }`, or `false`. Behind several servers, pass a `limiter` backed by a shared store |
| `clientKey` | none | `(req) => key`, for example an IP address from your proxy's header, checked before the token |
| `clientLimit` | 300 | Requests per window from one client key |
| `maxBodyBytes` | 16 KB | The largest body read |

`createModerationHandler(chat, { authorizeModerator })` serves moderators. It has no default check and can't be
made without one. `toNodeHandler(handler)` adapts either one to Node's `http` server or to Express.

### The component and the client

`<ChatThread endpoint labels className />`, `useChatThread(options)` and `createChatClient(options)` take the same
options: `endpoint`, `token` (default: read from the page's `#t=` fragment, then from session storage),
`storageKey`, `pollMs` (15 seconds, only while the page is visible) and `fetch`.

`labels` overrides any word the component shows, so you can change or translate them (`DEFAULT_LABELS` lists them
all). The look comes from `--cc-*` CSS variables on `.cc-thread`, with dark-mode defaults.

## Recipes

Each recipe is a `createChat` configuration, and you can mix their parts. The `declare function` lines stand for
your own code.

### A marketplace: buyer and seller, until it sells

```ts
// marketplace.ts
import { createChat, memoryStore } from "chaperone-chat";

declare function markSold(conversationId: string): Promise<void>; // yours

export const chat = createChat({
  secret: process.env.CHAT_LINK_SECRET!,
  store: memoryStore(), // postgresStore(query) in production
  jev: { apiKey: process.env.TYPESAFE_API_KEY! },
  durationMs: 14 * 24 * 60 * 60 * 1000, // two weeks to agree
  rules: {
    domains: { allow: ["example.com"] }, // links to your own listings pass
    platformNames: ["Example"], // "let's do this off Example" asks to move
  },
  outcomes: {
    sold: { by: ["seller"] }, // the seller marks it sold
    end: { by: "*" }, // either side walks away
  },
  hooks: {
    async beforeClose({ outcome, conversation }) {
      // If this throws, the conversation stays closing and the sweep asks again.
      if (outcome === "sold") await markSold(conversation.id);
    },
  },
});
```

### Dating: a double opt-in before details are shared

Neither person can share a number until both choose to. Then your `beforeClose` hook shares their details from your
own records.

```ts
// dating.ts
import { createChat, memoryStore } from "chaperone-chat";

declare function shareContactDetails(userIds: (string | null)[]): Promise<void>; // yours

export const chat = createChat({
  secret: process.env.CHAT_LINK_SECRET!,
  store: memoryStore(),
  jev: { apiKey: process.env.TYPESAFE_API_KEY! },
  durationMs: 3 * 24 * 60 * 60 * 1000,
  outcomes: {
    swap: { by: "*", requires: "all" }, // closes only once everyone chooses it
    pass: { by: "*" }, // either one ends it
  },
  hooks: {
    async beforeClose({ outcome, participants }) {
      // Must be safe to run twice for one close.
      if (outcome === "swap") await shareContactDetails(participants.map((p) => p.externalRef));
    },
  },
});
```

The first person to choose `swap` sees that the chat is waiting for the other. With the component, that note comes
from the `waiting` label.

### Recruiting: until an interview is booked

Scheduling and meeting links stay refused (the `scheduling` and `meetings` app groups are on by default), so the
interview is booked through you.

```ts
// recruiting.ts
import { createChat, memoryStore } from "chaperone-chat";

declare function bookInterview(conversationId: string): Promise<void>; // yours

export const chat = createChat({
  secret: process.env.CHAT_LINK_SECRET!,
  store: memoryStore(),
  jev: { apiKey: process.env.TYPESAFE_API_KEY! },
  durationMs: 21 * 24 * 60 * 60 * 1000,
  messages: { perParticipantPerDay: 30 },
  rules: { platformNames: ["Example Jobs"] },
  outcomes: {
    interview: { by: ["recruiter"] },
    decline: { by: "*" },
  },
  hooks: {
    async beforeClose({ outcome, conversation }) {
      if (outcome === "interview") await bookInterview(conversation.id);
    },
  },
});
```

### Anonymous peer support: no deadline, and a person reads whatever is in doubt

Naming an app is fine here, but a number or a handle isn't. Nothing Jev doubts is refused outright: it waits for a
moderator. Messages are deleted a week after the conversation ends.

```ts
// peer-support.ts
import { createChat, memoryStore } from "chaperone-chat";
import { contactLeak } from "chaperone-chat/guard";

export const chat = createChat({
  secret: process.env.CHAT_LINK_SECRET!,
  store: memoryStore(),
  jev: { apiKey: process.env.TYPESAFE_API_KEY! },
  durationMs: null, // no deadline
  policies: [contactLeak({ scope: "details-only" })], // only actual contact details count
  bands: { block: "hold", review: "hold" }, // in doubt: held for a moderator, not refused
  retention: { deleteMessagesAfterCloseDays: 7 },
});
```

Your moderators work the queue with `chat.moderation.listHeld()`, `approve()` and `refuse()`
([moderation](docs/moderation.md)).

## Jev

Jev is a hosted decision model made by [TypeSafe](https://typesafe.ai). It answers a yes-or-no question about a
state with a probability. To use it, you need your own TypeSafe account and API key.

- **Calibrated.** The built-in contact policy is calibrated for `jev-1.13.0` on a labelled corpus of 595 messages
  and threads, which ships in `corpus/`. In both scopes:
  - Jev refuses none of the clean messages it reads outright;
  - it refuses fewer than 2% of them with an appeal;
  - one known miss gets through: a bare username with nothing around it.

  See [calibration](docs/calibration.md).
- **Pinned.** An answer from any model other than the pinned one is refused, because cutoffs belong to one model's
  scores. Moving to a new version means calibrating again: `npx chaperone-chat calibrate --model <id>`.
- **What it is sent.** The new message and up to eight earlier ones. Turns are labelled `sender` or `other`, and
  your product's names are replaced with "this platform". Jev is never sent an id, an alias, a role, an
  `externalRef` or your context. See [what is sent to Jev](docs/jev-data.md).
- **What it costs.** One request per policy for each message the rules pass. The calibration made 2,380 calls of
  about 670 input tokens each, for about 7¢ in all at the price TypeSafe quoted at the time. `dailyCap` puts a
  ceiling on the calls.

chaperone-chat is an independent open-source project. It is not affiliated with, sponsored by or endorsed by
TypeSafe. Jev is TypeSafe's product: you use it with your own account and under their terms.

## What the tests prove, and what they don't

The suite runs the rules on the labelled corpus. It checks the link tokens against fixed vectors and runs one
conformance suite on both stores: the memory store, and Postgres through PGlite (with 50-way races on a real
Postgres in `npm run test:pg`). It also covers:
- the engine, the lifecycle, moderation and the sweep, with the clock moved forward;
- the HTTP handlers, the browser client and the React component;
- a demo driven end to end over HTTP;
- Jev through a faked network, plus the committed calibration scores.

Every code block in this README and in `docs/` is compiled against the source.

What it doesn't prove:

- behaviour under real concurrent load beyond those 50-way races;
- Jev's scores for conversations of three or more people (the calibration is for two);
- the rules' reach outside English and Spanish, or phone and address formats outside the US.

## Not in this version

- Redacting part of a chat message. A message is refused or sent whole; `scrub()` in `chaperone-chat/guard`
  redacts profiles and forms.
- A "flag but deliver" band. `mode: "observe"` covers a rollout.
- A moderation UI component. The moderation functions, a JSON handler and the demo's plain page ship instead.
- Attachments, edits, typing indicators, and WebSocket or server-sent-event transport. The client polls.
- A built-in mailer. `notify.send` hands you each notice, and `renderNotice()` words it.
- End-to-end encryption. Messages are stored in plain text, and TypeSafe reads them to screen them:
  [security model](docs/security.md).

## Docs

- [Configuration](docs/configuration.md): every option, with examples
- [Calibration](docs/calibration.md): how the cutoffs were set, and how to calibrate a policy of your own
- [Security model](docs/security.md): links, auth, what is stored, and what it doesn't protect against
- [What is sent to Jev](docs/jev-data.md): the exact request, and what never leaves your server
- [Storage](docs/storage.md): the memory and Postgres stores, drivers, the schema, and writing your own
- [Notifications](docs/notifications.md): notices, the sweep, and wording them
- [Moderation](docs/moderation.md): the held queue, approve, refuse, hide and retry, and events

[Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

MIT © 2026 Hypno Labs LLC. See [LICENSE](LICENSE).
