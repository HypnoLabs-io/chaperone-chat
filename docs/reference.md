# Reference

Every entry point, every option and its default. [Configuration](configuration.md) goes through the same options
by area, with examples; the [install guide](install.md) puts them together into a working chat.

- [What's in the box](#whats-in-the-box)
- [The parameters](#the-parameters)
  - [`createChat(config)`](#createchatconfig)
  - [`chat.open(input)`](#chatopeninput)
  - [The rest of `chat`](#the-rest-of-chat)
  - [The rules](#the-rules)
  - [The HTTP handlers](#the-http-handlers)
  - [The component and the client](#the-component-and-the-client)
- [Jev](#jev)

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
| `policies` | `[contactLeak()]` | What Jev is asked. `contactLeak({ scope: "details-only" })` counts only actual contact details; `definePolicy()` makes your own ([calibration](calibration.md)) |
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
| `notify` | off | `{ send(notice), everyMinutes (60), graceMinutes (2), reminderBeforeMs (48 hours), maxPerDay, kinds }`: [notifications](notifications.md) |
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
| `moderation` | `listHeld`, `thread`, `approve`, `refuse`, `hide`, `retry`: [moderation](moderation.md) |
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

## Jev

Jev is a hosted decision model made by [TypeSafe](https://typesafe.ai). It answers a yes-or-no question about a
state with a probability. To use it, you need your own TypeSafe account and API key.

- **Calibrated.** The built-in contact policy is calibrated for `jev-1.13.0` on a labelled corpus of 595 messages
  and threads, which ships in `corpus/`. In both scopes:
  - Jev refuses none of the clean messages it reads outright;
  - it refuses fewer than 2% of them with an appeal;
  - one known miss gets through: a bare username with nothing around it.

  See [calibration](calibration.md).
- **Pinned.** An answer from any model other than the pinned one is refused, because cutoffs belong to one model's
  scores. Moving to a new version means calibrating again: `npx chaperone-chat calibrate --model <id>`.
- **What it is sent.** The new message and up to eight earlier ones. Turns are labelled `sender` or `other`, and
  your product's names are replaced with "this platform". Jev is never sent an id, an alias, a role, an
  `externalRef` or your context. See [what is sent to Jev](jev-data.md).
- **What it costs.** One request per policy for each message the rules pass. The calibration made 2,380 calls of
  about 670 input tokens each, for about 7¢ in all at the price TypeSafe quoted at the time. `dailyCap` puts a
  ceiling on the calls.

chaperone-chat is an independent open-source project. It is not affiliated with, sponsored by or endorsed by
TypeSafe. Jev is TypeSafe's product: you use it with your own account and under their terms.
