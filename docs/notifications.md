# Notifications

The package doesn't send email. With `notify`, the sweep hands you a notice each time a participant should hear
about something, and you deliver it your way: email, a text, a push, a webhook. `renderNotice()` words a notice
for you.

- [The notices](#the-notices)
- [Wiring it](#wiring-it)
- [The words](#the-words)
- [Running the sweep](#running-the-sweep)
- [When a notice fails](#when-a-notice-fails)

## The notices

| Kind | Who | When |
|---|---|---|
| `message` | A participant with an unread message | Someone else's message was delivered after they last read the conversation and at least `graceMinutes` (2) ago. At most one notice per participant every `everyMinutes` (60), and none for a message an earlier notice already covered |
| `reminder` | Each participant, once | The deadline is within `reminderBeforeMs` (48 hours), with at least an hour left. `null` turns reminders off |
| `closed` | Each participant, once | The conversation has closed, within the last three days |
| `trouble` | You, at most once a day | Jev's daily cap is spent, or its last five calls all failed |

The grace period leaves a message alone while a participant who has the page open reads it within seconds: loading
the conversation marks it read. Turn a kind off with `kinds`, for example `kinds: { reminder: false }`.

`maxPerDay` caps the notices sent across everyone in 24 hours. It is off by default. Over the cap nothing is sent,
and each notice waits for a later sweep.

A participant's notice holds everything you need to reach them and nothing they said:

```ts nocheck
{
  kind: "message" | "reminder" | "closed",
  conversationId: string,
  participant: { id, role, alias, externalRef },  // externalRef: your id for them
  others: { role, alias }[],                      // who they're talking with
  link: { token, expiresAt },                     // a fresh link: `${yourChatPage}#t=${token}`
  msLeft: number | null,                          // time to the deadline
  outcome: string | null,                         // for `closed`: how it ended
}
```

A `trouble` notice is for you: `{ kind: "trouble", why: "cap" | "failing", calls, cap, failedInARow }`.

## Wiring it

```ts
// notify.ts
import { createChat, memoryStore, renderNotice, type Notice } from "chaperone-chat";

declare function emailOf(userId: string | null): Promise<string | null>; // yours
declare function sendEmail(to: string, subject: string, text: string, html: string): Promise<void>; // yours

const CHAT_PAGE = "https://example.com/chat";

async function send(notice: Notice): Promise<void> {
  if (notice.kind === "trouble") {
    const { subject, text, html } = renderNotice(notice, { url: "https://example.com/admin/chat" });
    await sendEmail("ops@example.com", subject, text, html);
    return;
  }
  const to = await emailOf(notice.participant.externalRef);
  if (!to) return;
  const { subject, text, html } = renderNotice(notice, { url: `${CHAT_PAGE}#t=${notice.link.token}`, appName: "Example" });
  await sendEmail(to, subject, text, html);
}

export const chat = createChat({
  secret: process.env.CHAT_LINK_SECRET!,
  store: memoryStore(),
  jev: { apiKey: process.env.TYPESAFE_API_KEY! },
  notify: { send, everyMinutes: 60, reminderBeforeMs: 24 * 60 * 60 * 1000, maxPerDay: 1_000 },
});

chat.startSweeper();
```

## The words

`renderNotice(notice, { url, appName })` returns `{ subject, text, html }`, in neutral words. It never quotes a
message, so a notice can't carry a contact detail out of the chat. It names people only by the aliases they were
given. With `url` it adds a link, and with `appName` it says where ("on Example").

| Kind | Subject | Text |
|---|---|---|
| `message` | New message from Alex | Alex sent you a message on Example. Messages stay in the conversation: read it and reply there. Read and reply: … |
| `reminder` | 47 hours left in your conversation | Your conversation with Alex on Example closes in 47 hours. Open the conversation: … |
| `closed` | Your conversation has ended | Your conversation with Alex on Example has ended. See the conversation: … |
| `trouble` | Message screening needs attention | Jev's daily cap is spent: 2000 calls in the last 24 hours, against a cap of 2000. Until it frees up, messages that need Jev's check take your fallback… |

Use the words as they are, or as a starting point for your own. `listNames()` and `timeLeft()`, which it uses, are
exported too.

## Running the sweep

Notices go out when the sweep runs, so run it every minute or so.

- **In a long-running server:** call `chat.startSweeper({ everyMs, onError })`. It never runs two sweeps at once,
  and its timer doesn't keep Node alive. It returns `{ stop }`.
- **On a serverless or edge host:** call `await chat.sweep()` from a cron route. It returns a report: how many
  conversations expired, closes it finished, held messages it checked again, notices by kind, and messages and
  events it deleted.

Every step is a claim in the store. Two sweeps that overlap, on two servers or because one ran slow, never send a
notice twice.

## When a notice fails

When `send` throws, the notice isn't tried again: the next notice covers it. The failure is recorded as a
`notice_failed` event, and the sweep's report counts it under `notices.failed`. `onEvent` sees both `notice_sent`
and `notice_failed`.
