# What is sent to Jev

Jev runs on TypeSafe's servers, so screening a message with Jev means sending that message to TypeSafe. This page
says when a request is made, what is in it, what never leaves your server, and what is kept on your side.

## When a request is made

A message is sent to Jev only when all of these hold:

- `jev` is set: with `jev: false`, nothing is ever sent;
- the rules and the split-message pass let it through, because a message they refuse never reaches Jev;
- the policy is calibrated for the model in use, because an uncalibrated policy is never asked;
- the daily cap has room, since each call is claimed under `dailyCap` before it is made.

Then each policy gets a request of its own, and the requests go in parallel. A message is sent again in two cases:
- when the sweep or `moderation.retry()` checks a held message again, it is sent as the conversation stood when it
  was written;
- when a sender appeals a refusal, the message is checked again.

`npx chaperone-chat calibrate` sends the samples you give it.

## The request

`POST https://api.typesafe.ai/v1/systemone` (or your `baseUrl`). Your key goes in the header as
`Authorization: Bearer <key>`, and the body is JSON.

This is the exact body for one message, with the default policy and `rules.platformNames: ["Acme"]`. It comes from
the package's own functions:

```json
{
  "model": "jev-1.13.0",
  "state": {
    "conversation": [
      { "from": "other", "text": "Hi! Is the desk still available?" },
      { "from": "sender", "text": "It is. I can hold it until Saturday." },
      { "from": "other", "text": "Great. Do you have a size chart on this platform?" },
      { "from": "sender", "text": "It's in the listing photos on this platform, second picture." }
    ],
    "latest_from": "sender"
  },
  "questions": {
    "contact": {
      "type": "noul",
      "instructions": "Does the latest message, alone or together with the same sender's earlier messages, share or try to share a way to contact them outside this platform, or ask for the other person's?",
      "criteria": {
        "true": "- An email address or phone number, whole or split across messages, including spelled-out, spaced-out, misspelled and disguised forms (\"jsmith at gee mail\", \"eight six seven…\", \"555 . 0199\").\n- A link, web address or domain.\n- A username or social handle.\n- A street address.\n- The name of an app or site to talk, meet or pay on instead, video calls included (\"Zoom or Google Meet works\").\n- Asking to move the conversation or the payment off this platform (\"text me\", \"let's take this offline\").\n- Asking the other person for their number, email, handle or last name.\n- Asking to be searched for or looked up (\"Google me\", \"search my name\", \"look me up on LinkedIn\").",
        "false": "- Prices, rates and budgets, times, days and dates, quantities, online or in person, and general areas: a city, a neighborhood, a cross street or a transit line, and travel time.\n- What the conversation is about: the need, the item, service or role, and who it is for (ages, levels, requirements).\n- A person's first name, experience, qualifications, education or employer.\n- A full name or business name, stated without asking to be looked up.\n- An app or site named in passing (\"I found you on Instagram\").\n- Arranging the next step here, on this platform.\n- Greetings, thanks and everyday talk about the matter at hand."
      }
    }
  }
}
```

- **`model`** is the pinned model.
- **`state.conversation`** is the new message, last, after up to `contextTurns` (8) earlier messages from everyone
  in the conversation, oldest first. Only delivered messages are included: held, refused and hidden ones never are.
  Each turn is `from: "sender"` (whoever wrote the new message) or `from: "other"` (anyone else), with its text.
  With three or more people, everyone else is `"other"`.
- **Your product's names** (`rules.platformNames`) become "this platform", as whole words in any case.
- **`questions`** holds the policy's question and its lines, the same words for everyone who uses the package. That
  is what lets one calibration hold for every adopter. The `details-only` scope asks a different question with
  fewer lines. `contactLeak({ scope: "details-only" })` builds that request.

## What is never sent

- An id of any kind: conversation, participant or message.
- An alias, a role or an `externalRef`.
- Your `context`, the conversation's `key`, its outcomes or its deadline.
- A timestamp.
- Your link secret.
- Anything from a refused, held or hidden message, except a held message's own text when that message is checked
  again.

Your TypeSafe key goes only in the `Authorization` header.

## The response

```json
{
  "model": "jev-1.13.0",
  "answers": { "contact": { "type": "noul", "noul": 0.03 } }
}
```

`noul` is the probability that the answer is yes, from 0 to 1. The response may also carry `usage`, with
`input_tokens` and `output_tokens`, which the `jev_call` event records. One message with the default policy came to
about 670 input tokens in the calibration. The answer is refused, and the fallback decides,
when:
- it names any model other than the pinned one;
- the question's answer is missing;
- the probability falls outside 0 to 1.

Each attempt times out after `timeoutMs` (3 seconds by default). A 429 or 529 is tried once more, after
`Retry-After` when that is 2 seconds or less.

## What is kept on your side

- **On the message:** the deciding policy, its score rounded to three places, and `checked_by` (for example
  `rules+jev-1.13.0`).
- **A `jev_call` event for each request:** the policy, the score, the model and the token counts, or why the call
  failed. Never the text.
- **Nothing in a log.** The client logs nothing, and its errors name a cause and a status code, never the content.

## Your side of it

- What TypeSafe does with what you send is covered by your agreement with them. Read their terms and their data
  policies before you turn Jev on.
- Tell the people who use your chat that a third-party service screens their messages, and name it in your
  privacy policy.
- To send nothing to TypeSafe, set `jev: false` and the rules work alone. `mode: "observe"` still sends.

chaperone-chat is not affiliated with TypeSafe. See the [README](../README.md#jev).
