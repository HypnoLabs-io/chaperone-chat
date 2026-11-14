# Recipes

Each recipe is a `createChat` configuration, and you can mix their parts. The `declare function` lines stand for
your own code.

- [A marketplace: buyer and seller, until it sells](#a-marketplace-buyer-and-seller-until-it-sells)
- [Dating: a double opt-in before details are shared](#dating-a-double-opt-in-before-details-are-shared)
- [Recruiting: until an interview is booked](#recruiting-until-an-interview-is-booked)
- [Anonymous peer support: no deadline, and a person reads whatever is in doubt](#anonymous-peer-support-no-deadline-and-a-person-reads-whatever-is-in-doubt)

## A marketplace: buyer and seller, until it sells

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

## Dating: a double opt-in before details are shared

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

## Recruiting: until an interview is booked

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

## Anonymous peer support: no deadline, and a person reads whatever is in doubt

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
([moderation](moderation.md)).
