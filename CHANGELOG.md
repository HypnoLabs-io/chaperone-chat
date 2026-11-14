# Changelog

## 0.1.0 (2026-11-14)

The first release.

- `createChat()`: anonymous conversations of 2 to 50 people through signed links, with aliases, deadlines,
  outcomes (one vote or a double opt-in), a two-step close around a `beforeClose` hook, notices, retention and an
  idempotent sweep.
- The screen:
  - rules for email addresses, phone numbers, links, handles, street addresses, app names and asks to move, in
    English and Spanish, with US phone and address formats;
  - a split-message pass;
  - then TypeSafe's Jev, one request per policy, with bands, appeals, a fallback that holds by default, and an
    observe mode.
- `contactLeak()`, calibrated for `jev-1.13.0` in two scopes, `off-platform` and `details-only`, on a corpus of 595
  labelled messages and threads that ships with the package. `definePolicy()` makes your own.
- Moderation: the held queue, whole threads, and approve, refuse, hide and retry.
- `chaperone-chat/http`: a Web-standard handler for participants, one for moderators, a Node adapter and a rate
  limiter.
- `chaperone-chat/postgres`: a store over any Postgres driver, and its schema. `memoryStore()` for tests and
  prototypes.
- `chaperone-chat/client` and `chaperone-chat/react`: the participant's side, framework-free or as `<ChatThread>`
  and `useChatThread()`, styled with CSS variables.
- `chaperone-chat/guard`, `chaperone-chat/jev` and `chaperone-chat/links` on their own.
- `npx chaperone-chat calibrate` and `npx chaperone-chat schema`.
