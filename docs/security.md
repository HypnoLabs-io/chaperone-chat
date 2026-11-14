# Security model

What chaperone-chat protects, how, and what it doesn't. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What it is for

Two or more people talk without learning how to reach each other outside your platform. Each participant sees
only:
- the others' aliases and roles;
- the messages that were delivered;
- their own messages that weren't, each with a note on what happened to it.

The screen makes sharing a contact detail hard. It does not make it impossible: [what it doesn't protect
against](#what-it-doesnt-protect-against).

## Links are the credentials

A participant has no account in the package. Their link is their credential.

- **Signed.** A token names one participant and an expiry, signed with HMAC-SHA256 under your `secret`. It is
  checked with WebCrypto's constant-time verify before any of it is parsed. A token is also tied to one kind
  (`chat`), so a token signed for another use of the same secret never verifies here. A secret shorter than 32
  characters is refused.
- **Expiring.** A link works until the conversation's deadline plus `links.graceMs`, or for `links.ttlMs` with no
  deadline. `chat.link(participantId)` makes a fresh one.
- **Kept out of logs.** The token travels in the URL fragment (`#t=…`), which browsers never send to a server, so
  it isn't in your access logs or in a `Referer` header. The client keeps it in session storage and takes it out
  of the address bar and the history entry.
- **Rotating.** `secret: [next, current]` signs with `next` and still accepts `current`. To cut off every link at
  once, drop the old secret.

Anyone holding a link can read and write as that participant until it expires. Send links only to the person they
belong to, over a channel you trust for that person: their verified email, or your own app.

## Requests

- **POST only, JSON only.** `createChatHandler` answers a POST with a JSON body: anything else gets 405, and a
  non-JSON body gets 415. A link scanner or a message preview that fetches the page's URL therefore changes nothing.
- **No cookies.** The token in the body is the only authentication, so a cross-site form can't act for anyone.
- **Bounded.** Bodies are capped (`maxBodyBytes`, 16 KB), a token is at most 512 characters, and every response is
  `Cache-Control: no-store`.
- **Rate-limited.** Each participant gets 120 reads and 30 writes a minute by default, with an optional limit per
  client key (an IP address from your proxy) checked before the token. The default counter is in memory, one per
  process. Behind several servers, pass a `limiter` backed by a shared store.
- **A daily cap on messages.** `messages.perParticipantPerDay` (50) counts messages refused as well as delivered,
  so probing the screen counts against it.

The moderators' handler has no default check. `createModerationHandler` can't be made without
`authorizeModerator(req)`, and a check that throws counts as a refusal.

## The screen

- **Rules first, and fail closed.** A message the rules refuse is never stored and never sent to Jev. When Jev
  can't answer, the default fallback holds the message: nothing unchecked is delivered. A policy whose cutoffs
  don't belong to the model in use takes the fallback instead of guessing. An answer from any model but the pinned
  one is refused.
- **Aliases are screened.** `open()` refuses an alias that holds a contact detail, since everyone sees the
  aliases.
- **No slow patterns.** Every quantifier in the rules has a ceiling, and `custom` patterns are held to the same
  standard when the guard is built. In the chat, a message is capped (`maxChars`) before the rules read it, so a
  crafted message can't make them run for long. Used on its own, the guard reads whatever you give it: cap long
  fields first.
- **Held means unseen.** A held message is shown only to its sender. The others never learn that it existed.

## What is stored

| | Stored | Shown to participants |
|---|---|---|
| A delivered message | Its text, in plain text | Yes |
| A held message | Its text | Only to its sender |
| A message the screen refused | Nothing: it is never stored | No |
| A message a moderator refused | Its text is cleared | Its sender sees a note |
| A message a moderator hid | Its text, until retention deletes it | No: it is removed from the others' screens |
| Participants | Role, alias, your `externalRef`, read and notice stamps | Alias and role |
| Your `context` | As given | Never |
| Events | Ids, types, numbers and short codes, never message text | No |

The package stores no contact details: `externalRef` is your own id for the person. Retention deletes a closed
conversation's messages after `retention.deleteMessagesAfterCloseDays` (30). `store.deleteConversation(id)` deletes
a conversation, its participants, messages and votes at once.

Moderators are trusted. `moderation.thread()` shows every message in every status, every participant's
`externalRef`, and your context. The held queue shows `externalRef`s too.

## What leaves your server

- **To TypeSafe:** the text of the messages Jev reads, with the conversation before each one, and no ids, aliases
  or roles. See [what is sent to Jev](jev-data.md). `jev: false` sends nothing.
- **To `notify.send`:** a notice with the participant's `externalRef`, the others' aliases, a fresh link, and no
  message text. `renderNotice()` never quotes a message, so an email or a push carries no contact detail.
- **To `onEvent`:** ids, types and numbers.

The Jev client logs nothing, and its errors name a cause and a status code, never the content. The library never
reads the environment: you pass in every key and secret.

## What it doesn't protect against

- **End-to-end secrecy.** Messages are stored in plain text, and Jev reads them to screen them. Whoever runs your
  database can read them, and so can TypeSafe under your agreement with them.
- **A determined pair.** People can agree on a code word, describe a number in a way neither the rules nor Jev
  reads, or meet in person. The screen raises the cost of leaving the platform; it doesn't end it. A message a
  moderator hides is a miss worth adding to your samples ([calibration](calibration.md)).
- **A forwarded link.** Whoever has it is that participant until it expires.
- **Your other surfaces.** Profiles, listings and usernames elsewhere in your product can carry a contact detail.
  Screen them with `chaperone-chat/guard`.
- **Load beyond your limits.** The in-memory rate limiter protects one process, and each Jev call costs money.
  `dailyCap` puts a ceiling on that spend, and the fallback takes over past it.

## Your chat page

The page that shows `<ChatThread>` is yours. Serve it with:
- `Referrer-Policy: no-referrer`;
- `X-Content-Type-Options: nosniff`;
- a Content Security Policy that allows only your own scripts.

Never put a token in a query string.
