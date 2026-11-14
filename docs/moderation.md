# Moderation

Some messages wait for a person. This page covers why they wait, the functions and the HTTP handler a moderator
works with, and the events that record it all.

- [Why a message waits](#why-a-message-waits)
- [The functions](#the-functions)
- [The handler](#the-handler)
- [Events](#events)
- [Rolling out, and learning from misses](#rolling-out-and-learning-from-misses)

## Why a message waits

A held message is stored, and only its sender sees it, with the `held` note. Its `holdReason` says why it waits:

| `holdReason` | How it got there | Who moves it |
|---|---|---|
| `appeal` | Jev put it in the review band, and the sender asked for a check | A moderator |
| `unchecked` | Jev couldn't answer (no key, the cap, an error, an uncalibrated policy) and `fallback` is `"hold"` | The sweep checks it again; a moderator can too |
| `flagged` | A band set to `"hold"` caught it, or a check run again scored it high | A moderator |

## The functions

Everything is on `chat.moderation`. Moderators are trusted: these views carry every participant's `externalRef`.
`thread()` also carries your context.

| Function | What it does |
|---|---|
| `listHeld({ holdReason, conversationId, onlyOpen, limit })` | Held messages, oldest first: the queue. `limit` 50 |
| `thread(conversationId, { limit })` | A whole conversation: every message in every status, the participants, the votes and your context. `limit` 1,000 |
| `approve(messageId)` | A held message is delivered now, at the end of the thread, while the conversation is open |
| `refuse(messageId)` | A held message is not delivered. Its text is cleared, and its sender reads that a moderator stopped it |
| `hide(messageId)` | A delivered message leaves the others' screens at their next poll, and its sender reads that it was removed |
| `retry(messageId)` | An `unchecked` message is checked again, as the conversation stood when it was written. The result is `"sent"`, `"flagged"` (it now waits for a moderator), `"still_held"`, `"closed"` or `"gone"` |

Each move is one conditional write, so a moderator and the sweep acting on one message at once move it once. A move
that doesn't apply says why: `{ ok: false, reason: "not_found" | "not_held" | "not_sent" | "closed" }`.

To end a conversation yourself, call `chat.close(conversationId, outcome)`, which records `"moderator"` as the
closer. Your `beforeClose` hook runs as for any close.

```ts
// review.ts
import type { Chat } from "chaperone-chat";

/** The oldest appeals, each with its conversation, for a review screen. */
export async function nextAppeals(chat: Chat) {
  const held = await chat.moderation.listHeld({ holdReason: "appeal", onlyOpen: true, limit: 20 });
  return Promise.all(held.map(async (message) => ({ message, thread: await chat.moderation.thread(message.conversationId) })));
}
```

## The handler

`createModerationHandler(chat, { authorizeModerator })` puts the same functions behind one JSON route. There is no
default check: it can't be made without `authorizeModerator`. Use your own session or an API key. A check that
throws counts as a no.

```ts
// moderation-route.ts
import type { Chat } from "chaperone-chat";
import { createModerationHandler } from "chaperone-chat/http";

declare function isModerator(req: Request): Promise<boolean>; // yours: a session, an admin role, an API key

export function moderationRoute(chat: Chat) {
  return createModerationHandler(chat, { authorizeModerator: (req) => isModerator(req) });
}
// Next.js: export const POST = moderationRoute(chat);
```

Every request is a POST with a JSON body:

| Body | Answer |
|---|---|
| `{ step: "held", holdReason?, conversationId?, limit? }` | `{ ok, held }`: the queue |
| `{ step: "thread", conversationId }` | `{ ok, thread }` |
| `{ step: "approve" \| "refuse" \| "hide", messageId }` | `{ ok, message }` |
| `{ step: "retry", messageId }` | `{ ok, outcome }` |
| `{ step: "close", conversationId, outcome }` | `{ ok, state, outcome }` |

The errors are:
- 401 `not_authorized`;
- 400 `invalid_body` or `unknown_outcome`;
- 404 `not_found`;
- 409 `not_held`, `not_sent`, `closed` or `refused`;
- 405, 413, 415, and 500 `server_error`.

The demo's moderation page (`examples/demo/moderate.html`) is a plain example of a client for it.

## Events

Every action records an event: ids, a type and numbers, never message text. The events stay in the store's
`events` table, and `hooks.onEvent` sees each one as it is recorded. Use them for metrics, an audit log or alerts.

| Type | When |
|---|---|
| `conversation_opened` | `open()` made a conversation |
| `message_sent` | A message was delivered, or a check run again passed it |
| `message_held` | A message was stored to wait |
| `message_blocked` | The screen refused a message. Its `meta` says what decided (`decidedBy`, `kind`, `policy`, `p`) and whether it was an appeal |
| `message_observed` | Observe mode delivered a message that enforcing would have stopped |
| `jev_call` | One request to Jev: the policy, the score, the model and the token counts, or why it failed |
| `message_approved`, `message_refused`, `message_hidden` | A moderator's move |
| `vote_cast` | A participant chose an outcome |
| `conversation_closing`, `conversation_closed` | The two steps of a close |
| `conversation_reopened` | `beforeClose` refused a close |
| `close_failed` | `beforeClose` threw; the sweep will try again |
| `notice_sent`, `notice_failed` | A notice handed to `notify.send`, or one that threw |
| `trouble_alert` | The daily alert that Jev needs attention |

The names are exported as `EVENT` (for example `EVENT.messageBlocked`).

## Rolling out, and learning from misses

- **Observe first.** `mode: "observe"` delivers everything and records `message_observed` for what enforcing would
  have stopped. Read those events, with the threads they point to, before you enforce. See
  [configuration](configuration.md#observe-mode).
- **A hidden message is a miss.** A message a moderator hides is one the screen let through. Write made-up messages
  like it into your samples, and calibrate again ([calibration](calibration.md)).
- **Watch the appeal queue.** A long queue of appeals that moderators approve means `review` sits too low for your
  conversations. A queue they refuse means it's working.
