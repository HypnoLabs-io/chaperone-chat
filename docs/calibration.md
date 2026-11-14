# Calibration

Jev answers a policy's question with a probability. A policy's **cutoffs** turn that probability into an action:
- at or above `block`: refused;
- at or above `review`: refused with an appeal;
- below `review`: sent.

Cutoffs are measured on labelled samples, for one model and one question, and they carry both:

```ts nocheck
{ model: "jev-1.13.0", fingerprint: "6ce551c1", block: 0.5, review: 0.2 }
```

The fingerprint is a hash of the model, the shape of the state Jev is sent, and the question with every one of its
lines. Change any of them and the cutoffs no longer apply. The policy then reads as uncalibrated, and the fallback
decides each message instead of a guess.

- [The corpus](#the-corpus)
- [The bar](#the-bar)
- [The results](#the-results)
- [Why the shipped cutoffs differ from the suggestion](#why-the-shipped-cutoffs-differ-from-the-suggestion)
- [The state's shape](#the-states-shape)
- [Reprinting the tables](#reprinting-the-tables)
- [Calibrating a policy of your own](#calibrating-a-policy-of-your-own)
- [Moving to another Jev version](#moving-to-another-jev-version)

## The corpus

`corpus/contact.json` holds 554 single messages and 41 threads, 595 items in all, written for this package. The
names, numbers and addresses in it are made up. The items cover:

| Area | Single messages | Threads |
|---|---|---|
| Marketplace | 121 | 11 |
| Dating | 89 | 5 |
| Recruiting | 86 | 5 |
| Rentals | 72 | 8 |
| Peer support | 57 | 5 |
| General, any setting | 129 | 7 |

Each item cites the line of the policy it illustrates, so its label follows the scope. For example, "my calendly
link" counts under `off-platform` (it names an app to move to) and doesn't under `details-only` (it holds no actual
detail). A thread's last message is judged after the ones before it, from its sender's side.

`corpus/contact-scores.json` keeps Jev's score for every item, under each question's fingerprint: one entry per
scope, for `jev-1.13.0`.

## The bar

The tables count only the items that **reach Jev in the chat**: those the rules and the split-message pass let
through. A scope ships calibrated only if, among them:

1. no clean message is refused outright;
2. no contact detail is sent, apart from misses listed here by name;
3. no more than 10% of the clean messages land in the appeal band.

Both scopes pass.

## The results

On `jev-1.13.0`, with state shape 1:

| | `off-platform` | `details-only` |
|---|---|---|
| Items that reach Jev | 357: 290 clean, 67 positive | 477: 435 clean, 42 positive |
| Highest clean score | 0.44 | 0.46 |
| Lowest positive score, apart from hd-16 | 0.28 | 0.33 |
| **Cutoffs** | **block 0.5, review 0.2** | **block 0.5, review 0.25** |
| Clean, refused outright | 0 | 0 |
| Clean, refused with an appeal | 5 (1.7%) | 7 (1.6%) |
| Positive, sent | 1: hd-16 | 1: hd-16 |

**The known miss.** hd-16 is "I'm hikingwithdana everywhere.": a username with nothing around it to mark it as one.
Jev scores it 0.03 (0.04 under `details-only`), lower than most clean messages, so no `review` cutoff catches it
without sending a large share of clean messages to the appeal band. It is listed, and left.

**The clean messages refused with an appeal.** If the sender appeals, each of these is held for a moderator:

- `off-platform`:
  - "Slack is what our team uses internally." (0.44)
  - "It's on 5th Avenue, near the park." (0.42)
  - "Search me, I don't know what the fee covers." (0.42)
  - "Message me here if anything changes." (0.31)
  - "Our team uses Slack and Jira internally." (0.26)
- `details-only`:
  - "My cell is on the listing flyer if you need it." (0.46)
  - "It's on 5th Avenue, near the park." (0.41)
  - "my calendly link" (0.32)
  - "mi número" (0.30)
  - a thread ending "between 3rd and 4th St" (0.29)
  - "The place is 2 blocks off Maple Ave." (0.26)
  - "2 classes a week on Maple Ave." (0.25)

**Before Jev: the rules' own refusals.** The rules refuse a few clean messages before Jev reads them:
- `off-platform`, 5 of 295 clean messages:
  - an app named in passing: "I used to be on Upwork but not anymore.", "Thumbtack sent me a few clients
    before." and "My sister uses Venmo for everything.";
  - "Text me here when you're on your way.", read as an ask to text;
  - a thread of prices, "680 / 720 / 1400 total", which the split-message pass joins into a ten-digit number.
- `details-only`, 1 of 436: the same thread of prices.

The sender reads why each was refused and can rephrase. `apps.allow` lets a name through.

## Why the shipped cutoffs differ from the suggestion

The command line prints a suggested pair of cutoffs:
- `block`: just above the highest clean score;
- `review`: at the lowest positive score that reaches Jev, then raised until no more than 10% of the clean messages
  land between the two.

For the contact policy it suggests:

| | Suggested | Clean messages in the appeal band |
|---|---|---|
| `off-platform` | block 0.45, review 0.07 | 9.3% |
| `details-only` | block 0.47, review 0.08 | 8.5% |

The suggestion is a starting point. The shipped cutoffs depart from it in two places:

- **`block` keeps a margin.** 0.5 sits 0.06 above the highest clean score under `off-platform`, and 0.04 under
  `details-only`; the suggestion sits 0.01 above it. A clean message that scores a little higher than any in the
  corpus then lands in the appeal band instead of being refused outright.
- **`review` lets hd-16 go.** The suggestion starts at hd-16's score and stops at the 10% ceiling, still above
  hd-16, so it catches nothing more for that cost. The shipped `review` sits 0.08 under the next-lowest positive
  (0.28 and 0.33). On the corpus it catches every positive the suggestion catches, with about a fifth as many clean
  messages in the appeal band: 1.7% against 9.3%, and 1.6% against 8.5%.

## The state's shape

Two layouts of the conversation were scored:
- shape 1 is one list ending with the latest message, with `latest_from: "sender"`;
- shape 2 keeps the earlier messages and the latest one apart.

The measure is how many clean messages score at or above the lowest positive (apart from hd-16), which is how much
the two sides overlap:

| | Shape 1 | Shape 2 |
|---|---|---|
| `off-platform` | 4 of 290 | 3 of 290 |
| `details-only` | 2 of 435 | 8 of 435 |

Shape 1 is about even on `off-platform` and clearly better on `details-only`, so the chat sends shape 1
(`STATE_VERSION`). A change of shape is a change of question, and moves every fingerprint.

**The cost.** Two scopes by two shapes, 595 calls each: 2,380 calls of about 670 input tokens, about 7¢ in all at
the price TypeSafe quoted at the time. Scores are kept by fingerprint, so a run pays only for items not scored yet.

## Reprinting the tables

The scores ship with the package, so the tables print again without a key and without a call:

```bash
npx chaperone-chat calibrate --report
npx chaperone-chat calibrate --report --scope details-only
```

## Calibrating a policy of your own

**1. Write the policy** as a module the command can import, with `definePolicy` as its default export:

```js
// payment-policy.mjs
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
});
```

**2. Write labelled samples.** The file is JSON:
- `samples`: `{ id, text }`, labelled with `positive: true | false` or with `cites`, the id of one of the policy's
  lines;
- `threads`: `{ id, turns: [{ from, text }] }`, labelled the same way, with the last turn judged.

Write them yourself. Real people's messages don't belong in a test file, and every sample is sent to TypeSafe.
Cover both sides of every line, the hard cases especially.

```json
{
  "samples": [
    { "id": "p-1", "text": "Can I just pay you cash when we meet?", "cites": "direct" },
    { "id": "p-2", "text": "It's $40 for the hour.", "cites": "price" },
    { "id": "p-3", "text": "I'll pay through the app tonight.", "cites": "here" }
  ],
  "threads": [
    {
      "id": "t-1",
      "turns": [
        { "from": "a", "text": "That comes to $120." },
        { "from": "b", "text": "Do you take a bank transfer instead? Saves the fee." }
      ],
      "cites": "discount"
    }
  ]
}
```

**3. Score them.** The command makes only the calls it needs:
- it says how many calls it will make, and scores only the items without a score;
- it stops at `--max-calls` (2,000);
- it saves as it goes, then prints the tables.

The first line of the tables names the fingerprint.

```bash
TYPESAFE_API_KEY=… npx chaperone-chat calibrate \
  --policy ./payment-policy.mjs --samples ./payment-samples.json --scores ./payment-scores.json
```

The tables count what reaches Jev in the chat. Items the rules would refuse first are scored, but they don't decide
the cutoffs.

**4. Choose the cutoffs** from the tables, and add them to the policy with the model and the fingerprint:

```js nocheck
  cutoffs: { model: "jev-1.13.0", fingerprint: "<from the tables' first line>", block: 0.6, review: 0.3 },
```

**5. Score again after any change.** Edit the question or a line and the fingerprint changes: the policy reads as
uncalibrated, and the fallback decides, until you score it again. Nothing already scored is paid for twice.

## Moving to another Jev version

The model is pinned because cutoffs belong to one model's scores. To move, score both scopes on the new model.
Pass `--scores` so the scores land in a file of yours, rather than next to the corpus inside `node_modules`:

```bash
TYPESAFE_API_KEY=… npx chaperone-chat calibrate --model <new-model> --scores ./contact-scores.json
TYPESAFE_API_KEY=… npx chaperone-chat calibrate --model <new-model> --scope details-only --scores ./contact-scores.json
```

Then pin the new model, and give the policy the cutoffs you chose:

```ts
// new-model.ts
import { createChat, memoryStore } from "chaperone-chat";
import { contactLeak } from "chaperone-chat/guard";

const model = "<new-model>";

export const chat = createChat({
  secret: process.env.CHAT_LINK_SECRET!,
  store: memoryStore(),
  jev: { apiKey: process.env.TYPESAFE_API_KEY!, model },
  policies: [contactLeak({ cutoffs: { model, fingerprint: "<from the tables>", block: 0.5, review: 0.2 } })],
});
```
