# Contributing

Thank you for helping. A few rules keep this package trustworthy for the people whose messages pass through it.
Please read them before you open a pull request.

## Setup

You need Node 22 or later.

```bash
npm ci                 # installs, and builds dist/
npm test               # every test, then the leak check
npm run typecheck      # the server side, and the browser side with the DOM
npm run build
npm run lint:package   # publint, and are-the-types-wrong on the packed package
```

The Postgres race tests need a server you can create tables in:

```bash
docker run --rm -d --name chat-pg -e POSTGRES_PASSWORD=pw -p 54329:5432 postgres:17
PG_URL=postgres://postgres:pw@localhost:54329/postgres npm run test:pg
```

`npm run demo` starts the demo (see the README).

Before a release, run `npm run smoke:pack`. It installs the packed package in an empty folder, the way someone else
would, then runs four checks:
- the README's quickstart, comparing its output with the README's;
- every entry, from ESM and from CommonJS;
- TypeScript under node16 and bundler resolution;
- the command line.

It needs the network.

## The rules of the codebase

- **Runtime-neutral entries.** Outside `src/cli/index.ts` and `src/http/node.ts`, nothing uses `process`,
  `require`, `Buffer` or `__dirname`, or imports from `node:`. The package runs on Node, Bun, Deno and edge
  workers. `test/runtime-neutral.test.ts` enforces it.
- **Bounded patterns.** Every quantifier in a regular expression has a ceiling: `\s{1,3}`, `{2,40}`, never `+`,
  `*` or `{n,}`. The guard refuses a pattern without one.
- **No message text** goes in events, logs, errors or notices.
- **Fail closed.** When something can't be checked, the message waits. It is never delivered unchecked.
- **Tests.**
  - Assert exact values through the public API.
  - Fake only what is outside the package: the network, which means Jev, and the clock.
  - A bug fix comes with a test that fails without it.
- **Docs that compile.** Every TypeScript and JavaScript block in `README.md` and `docs/` is compiled against the
  source (`test/docs/code-blocks.test.ts`). A block that starts with a path comment (`// lib/chat.ts`) is that
  file, so blocks can import each other. Add `nocheck` after the language for a block that shows a shape, not
  code.

## Changing the rules

- Add made-up samples to `corpus/contact.json`, for what the change should catch and for what it must let through.
  Each sample's `rules` field pins what the rules find in it, and `test/guard/corpus.test.ts` reads every one.
  Update the pins in the same change, and say in the pull request why each one moved.
- Never put a real person's message, number, address or handle in a sample or a test.

## Changing a policy's question or lines

Any change to a question or one of its lines changes the policy's fingerprint. The built-in cutoffs then stop
applying, and `test/guard/policy.test.ts` fails until the policy is calibrated again. Calibration calls TypeSafe
and costs money, so a maintainer runs it with their own key. Say in the pull request what changed and why.

## The leak check

`npm test` ends with `scripts/check-leaks.sh`. It looks for words from a local word list that git ignores. Without
that list it checks nothing, so it won't get in your way.

## Pull requests

Keep each one to one change, with its tests. Describe what changed from the point of view of someone using the
package, and add a line to `CHANGELOG.md` under "Unreleased".
