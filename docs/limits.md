# Limits

What the tests cover and what they leave out, and what this version doesn't do.

- [What the tests prove, and what they don't](#what-the-tests-prove-and-what-they-dont)
- [Not in this version](#not-in-this-version)

## What the tests prove, and what they don't

The suite runs the rules on the labelled corpus. It checks the link tokens against fixed vectors and runs one
conformance suite on both stores: the memory store, and Postgres through PGlite (with 50-way races on a real
Postgres in `npm run test:pg`). It also covers:
- the engine, the lifecycle, moderation and the sweep, with the clock moved forward;
- the HTTP handlers, the browser client and the React component;
- a demo driven end to end over HTTP;
- Jev through a faked network, plus the committed calibration scores.

Every code block in the README and in `docs/` is compiled against the source.

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
  [security model](security.md).
