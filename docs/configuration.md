# Configuration

The [reference](reference.md) lists every option and its default. This page goes through them by area, with
examples.

- [Links and secrets](#links-and-secrets)
- [Deadlines](#deadlines)
- [Messages](#messages)
- [The rules](#the-rules)
- [The split-message pass](#the-split-message-pass)
- [Jev and policies](#jev-and-policies)
- [Outcomes and closing](#outcomes-and-closing)
- [Notices and retention](#notices-and-retention)
- [Another detection method](#another-detection-method)

## Links and secrets

Every participant gets a signed link. The token names that one participant and expires. The token is all a
participant needs: there are no accounts and no cookies.

- `secret` signs the tokens and must be 32 characters or more. One way to make one:
  `node -e "console.log(crypto.randomBytes(32).toString('base64url'))"`.
- To rotate, pass a list with the new secret first: `secret: [next, current]`. New links are signed with `next`,
  and links signed with `current` keep working. Drop `current` once the longest link signed with it has expired.
- A link works until the conversation's deadline plus `links.graceMs` (3 days), so a participant can still read the
  ending. With no deadline, it works for `links.ttlMs` (30 days).
- `chat.link(participantId)` makes a fresh link to send again. Each notice already carries a fresh one.

A link is a bearer credential, like a password-reset link. See the [security model](security.md).

## Deadlines

`durationMs` (7 days) sets every conversation's deadline, and `open({ durationMs })` sets one conversation's. `null`
means no deadline. At the deadline, sending stops at once. The next sweep closes the conversation with
`expiredOutcome` (`"expired"`), by `"system"`, and runs your `beforeClose` hook like any other close.

## Messages

| Option | Default | Notes |
|---|---|---|
| `messages.maxChars` | 1,000 | Counted after cleaning: line endings made `\n`, control characters dropped, runs of blank lines cut to one, the ends trimmed |
| `messages.perParticipantPerDay` | 50 | Counts messages stored and messages refused, so retrying a refused one counts too. `null` for no limit |
| `messages.pageSize` | 200 | A first load returns the newest messages up to this many, with `hasOlder` set when there are more |

## The rules

The rules are the first and cheapest check: synchronous regular expressions, with no network involved. Every kind is
on by default.

```ts
// rules.ts
import { createChat, memoryStore } from "chaperone-chat";

export const chat = createChat({
  secret: process.env.CHAT_LINK_SECRET!,
  store: memoryStore(),
  jev: false,
  rules: {
    kinds: { address: false }, // street addresses are part of the deal here
    locales: ["en"], // English number words and asks only
    region: "us", // US phone numbers and street addresses
    apps: {
      groups: { payments: false }, // payment apps may be named
      extra: ["Acme Pay"], // one more name to refuse
      allow: ["Slack"], // a name that passes wherever it appears
    },
    domains: { allow: ["example.com"], extraTlds: ["dev"] },
    streets: { named: ["Broadway"] }, // "1600 Broadway" is an address
    platformNames: ["Example"], // "off Example" asks to move; Jev reads "this platform"
  },
  reasons: { phone: "Phone numbers stay out of this chat. Keep talking here." },
});
```

### What custom detectors see

A custom detector runs over the same normalized text as the built-in ones:
- invisible characters are dropped;
- NFKC is applied, so fullwidth "＠" and "９" become "@" and "9";
- every run of whitespace becomes one space;
- Cyrillic and Greek lookalikes become Latin letters.

Case is kept, so add the `i` flag when case doesn't matter. Every quantifier must have a ceiling (`\d{6}`,
`\s{1,3}`, `{2,40}`, never `+`, `*` or `{n,}`). A pattern without one is refused when the guard is built, with the
code `unbounded_pattern`, because an unbounded pattern can be made to run for a very long time.

```ts
// custom-detector.ts
import { createGuard } from "chaperone-chat/guard";

const guard = createGuard({
  // A member number: "M-" and six digits.
  custom: [{ kind: "handle", pattern: /\bm-\d{6}\b/i }],
});

console.log(await guard.block("I'm M-123456 on the members' board"));
// { kind: "handle", reason: "That looks like a username or a handle.", scrubberId: "rules" }
console.log(await guard.block("Order M-12 is ready")); // null
```

### The screen outside the chat

The same rules screen anything people type that others will read: a profile, a listing, a review.

```ts
// profile.ts
import { block, has, scrub } from "chaperone-chat/guard";

const bio = "Ten years of experience. Call 312 555 0142 for a quote. Weekends only.";

await has(bio); // true: refuse the field when it's saved
await block(bio); // { kind: "phone", reason: "That looks like a phone number.", scrubberId: "rules" }
await scrub(bio); // "Ten years of experience. Weekends only.": clean it when it's shown
```

## The split-message pass

`window: { maxEarlier: 5, hours: 24 }` reads the sender's own last five delivered messages from the past day
together with the new one. It looks for an email address or a phone number sent in pieces ("312", "555", "0142").
It only counts a phone number with its area code, because numbers in pieces are common in ordinary talk. `false`
turns it off.

## Jev and policies

`jev: { apiKey }` turns Jev on. The other `jev` options are:
- `apiKey` may be a function, read at each call, so you can rotate the key without a restart;
- `dailyCap` (2,000) is claimed before each call, across every conversation. Past it, the fallback decides, and
  the sweep can alert you ([notifications](notifications.md));
- `model` pins the version (`jev-1.13.0`), and the built-in cutoffs belong to it;
- `timeoutMs` (3,000) applies to each attempt. A 429 or 529 is tried once more, after `Retry-After` when that is
  2 seconds or less;
- `baseUrl` and `fetch` point the calls elsewhere, for a proxy or a test.

### The built-in policy and its scopes

`contactLeak()` asks whether the latest message tries to share a way to get in touch outside your platform. It has
two calibrated scopes:

| Scope | Counts | Rule kinds |
|---|---|---|
| `off-platform` (default) | Contact details; naming an app to talk, meet or pay on instead; asking to move or to be looked up | All |
| `details-only` | Only actual contact details: an email address, a phone number, a link, a handle or a street address | `app` and `ask` turn off |

Read [what is sent to Jev](jev-data.md) for the exact question and its lines.

### A policy of your own

`definePolicy` makes any other yes-or-no question about the latest message, such as payment outside the platform,
harassment or personal data. **Calibrate it before you add it to `policies`.** A policy without cutoffs for the
model in use is never sent to Jev: the fallback decides every message for it, so by default every message waits.

```ts
// payment-policy.ts
import { definePolicy } from "chaperone-chat/guard";

export default definePolicy({
  id: "payment",
  question: "Does the latest message ask to pay or be paid outside this platform?",
  counts: [
    { id: "direct", text: "Asking to pay or be paid directly: cash, a bank transfer or a payment app." },
    { id: "discount", text: "Offering a lower price for paying outside this platform." },
  ],
  doesntCount: [
    { id: "price", text: "Prices, totals and budgets." },
    { id: "here", text: "Paying through this platform." },
  ],
  reason: "Payments go through this platform.",
  // cutoffs: { model, fingerprint, block, review } from `npx chaperone-chat calibrate`
});
```

See [calibration](calibration.md) for the samples file and the command.

### What each verdict does

For every policy, Jev's probability `p` falls in a band, and the most severe result across policies wins (refuse,
then appealable, then hold, then send):

| | Default | Choices |
|---|---|---|
| `p ≥ block` | refused | `bands.block`: `"refuse"`, or `"hold"` for a moderator (`flagged`) |
| `review ≤ p < block` | refused, appealable | `bands.review`: `"appealable"`, `"hold"` for a moderator, or `"send"` |
| `p < review` | sent | |
| Jev can't answer | held for a later check (`unchecked`) | `fallback`: `"hold"`, `"send"` on the rules alone, or `"refuse"` with a "try again" sentence |

An appeal (`send(…, { appeal: true })`, the component's button) sends a review-band message again, and this time it
is held for a moderator (`appeal`) instead of refused. Set `appeals: false` to turn the button off.

`contextTurns` (8) is how many earlier delivered messages, from both sides, Jev reads with the new one.

### Observe mode

`mode: "observe"` delivers every message, even one the rules would refuse, and records what `enforce` would have
done as a `message_observed` event. Jev is still called for what the rules pass, so it still costs, and those
messages are still sent to TypeSafe. Read the events for a while, then switch to `enforce`. Until you do, contact
details get through, so observe before you open the chat to everyone.

### What senders read

`reasons` sets the sentence a sender sees for each rule kind, and for the split-message pass (`window.email`,
`window.phone`). Each policy has its own `reason` for Jev's refusals. `notes` sets what a sender reads on their own
message that wasn't delivered: `held` ("Waiting for a quick check before it's sent."), `refused` ("Not sent: a
moderator stopped it.") and `hidden` ("Removed by a moderator.").

## Outcomes and closing

An outcome is a way a conversation can end:
- `by` names the roles that may choose it, or `"*"` for everyone;
- with `requires: "any"` (the default), one choice closes the conversation;
- with `requires: "all"`, every participant who may choose it must do so: a double opt-in.

The default is `{ end: { by: "*" } }`, so anyone can end it.

- A participant chooses with `chat.resolve(participantId, outcome)`, or with the component's buttons.
- Your server closes with `chat.close(conversationId, outcome, { by })`. `by` defaults to `"moderator"`.
- At the deadline, the sweep closes with `expiredOutcome`.

Closing takes two steps around your `beforeClose` hook. First the close is claimed (open becomes `closing`), so of
two racing closes exactly one wins. Then your hook runs. Then the close finishes, or is undone if the hook says no.

| `beforeClose` returns | What happens |
|---|---|
| nothing, or `true` | The conversation closes |
| `false`, or `{ refuse: "why" }` | It opens again. The participant who chose the outcome reads your words |
| throws | It stays `closing`. After `staleClosingMs` (5 minutes), the sweep calls the hook again |

Because a hook can run more than once for one close, it must be safe to repeat: charge with an idempotency key, and
check before you send.

```ts
// closing.ts
import { createChat, memoryStore } from "chaperone-chat";

declare function invoicePaid(conversationId: string): Promise<boolean>; // yours

export const chat = createChat({
  secret: process.env.CHAT_LINK_SECRET!,
  store: memoryStore(),
  jev: false,
  outcomes: { hired: { by: ["client"] }, end: { by: "*" } },
  hooks: {
    async beforeClose({ outcome, conversation }) {
      if (outcome === "hired" && !(await invoicePaid(conversation.id))) {
        return { refuse: "Pay the invoice first, then choose Hired again." };
      }
    },
    onEvent(event) {
      // Ids and numbers, never message text: for your metrics or your audit log.
      console.log(event.type, event.conversationId, event.meta);
    },
  },
});
```

## Notices and retention

`notify` hands you a notice for each participant who should hear about something: a new message, a reminder before
the deadline, the close. It also alerts you when Jev needs attention. See [notifications](notifications.md).

| Option | Default | What it does |
|---|---|---|
| `retention.deleteMessagesAfterCloseDays` | 30 | Deletes a closed conversation's messages after this many days. The conversation, its participants and the events stay. `null` keeps them |
| `retention.pruneEventsAfterDays` | `null` | Deletes events older than this. They hold no message text |

Both run in the sweep. To delete everything about one conversation at once, call `store.deleteConversation(id)`
([storage](storage.md)).

## Another detection method

`scrubber` swaps the rules for another way of finding contact details, such as a hosted PII service: an object with
an `id` and a `find(text)` that returns findings, synchronously or not. It fails closed: if it throws or answers
nonsense, the rules decide that message. To run it on top of the rules rather than instead of them, combine the two:

```ts
// scrubber.ts
import { combine, createGuard, type Finding, type Scrubber } from "chaperone-chat/guard";

declare function detectPii(text: string): Promise<{ type: string }[]>; // yours: a hosted service

const service: Scrubber = {
  id: "pii-service",
  async find(text): Promise<Finding[]> {
    const found = await detectPii(text);
    return found.filter((f) => f.type === "EMAIL").map(() => ({ kind: "email" as const }));
  },
};

const rules = createGuard().rules;
export const scrubber = combine("rules+pii-service", [rules, service]);
// createChat({ ..., scrubber })
```
