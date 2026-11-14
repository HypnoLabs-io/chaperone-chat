# Storage

Two stores ship: one in memory and one on Postgres. Both pass the same conformance suite, so the chat behaves the
same on either.

- [The memory store](#the-memory-store)
- [The Postgres store](#the-postgres-store)
- [The tables](#the-tables)
- [Deleting data](#deleting-data)
- [Writing your own store](#writing-your-own-store)

## The memory store

`memoryStore()` keeps everything in the process. Use it for tests, the demo and prototypes. Everything is lost on
restart, and it serves one process only. `memoryStore({ clock })` takes a clock, so a test can move time forward.

## The Postgres store

`postgresStore(query, options)` works over any driver. Pass a `query(text, params)` that returns `{ rows }` or an
array of rows:

```ts
// store.ts
import { postgresStore } from "chaperone-chat/postgres";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const store = postgresStore((text, params) => pool.query(text, params));
await store.migrate(); // creates what isn't there yet; safe on every boot
```

The test suite runs on `pg` and on PGlite, which is Postgres compiled to WebAssembly. PGlite suits tests, or an app
on a single process:

```ts
// pglite.ts
import { PGlite } from "@electric-sql/pglite";
import { postgresStore } from "chaperone-chat/postgres";

const db = new PGlite();

export const store = postgresStore((text, params) => db.query(text, params));
await store.migrate();
```

The same goes for any other driver that runs one statement with positional parameters (`$1`, `$2`): wrap it to
return the rows.

How the store works:

- **One statement per method.** There are no transactions, so drivers over HTTP work. Races are settled inside
  each statement: a close, a notice and a Jev call under the cap are each claimed by one conditional write. Of two
  servers sweeping at once, only one does each thing.
- **Every parameter is cast** (`$1::text`), and every count is `::int`, so drivers that send parameters as text
  read the same.
- **The database's clock is the only clock.** Deadlines, daily limits, the poll cursor and retention all read
  `now()` in Postgres, so servers whose clocks drift still agree. Timestamps keep milliseconds (`timestamptz(3)`).
- **`clock`** replaces `now()` with SQL of your own, so a test can move time:
  `postgresStore(query, { clock: "current_setting('app.now')::timestamptz" })`. It is written into the SQL as is,
  so pass only trusted text.

## The tables

Every table and index name starts with the prefix: `chat_` by default, or `prefix: "app_chat_"`. A prefix is
lowercase letters, digits and underscores.

| Table | What it holds |
|---|---|
| `chat_conversations` | The id, your `key`, the state (`open`, `closing`, `closed`), the outcome and who closed it, the deadline, your `context`, and when it opened, started closing and closed |
| `chat_participants` | The id, the conversation, the role, the alias, your `external_ref`, the position, and when they last read and were last told |
| `chat_messages` | The id, the order of insertion (`seq`), the conversation, the sender, the text, the status (`sent`, `held`, `refused`, `hidden`), why it is held, the deciding policy and score, what checked it, and when it was written, delivered and last changed |
| `chat_votes` | Who chose which outcome |
| `chat_events` | The id, the order, the type, the conversation and participant, a key that makes a claim happen once, and `meta`: ids, numbers and codes, never message text |
| `chat_meta` | The schema version |

Participants, messages and votes are deleted with their conversation. Events have no foreign keys, so the log
outlives a deleted conversation; it holds no text.

There are two ways to create the tables:

- `store.migrate()` runs every statement. Each is `IF NOT EXISTS`, so it is safe on every boot.
- `npx chaperone-chat schema --prefix chat_` prints the same statements as SQL, and so do `schemaSql(prefix)` and
  `schemaStatements(prefix)` from `chaperone-chat/postgres`. Pass them through your own migration tool, or run them
  directly: `npx chaperone-chat schema | psql "$DATABASE_URL"`.

## Deleting data

The sweep deletes on a schedule:
- `retention.deleteMessagesAfterCloseDays` (30) deletes a closed conversation's messages;
- `retention.pruneEventsAfterDays` deletes old events.

To delete one person's conversations, for example when they close their account, find them by your id and delete
each one. That deletes the conversation, its participants, its messages and its votes. Its events stay, and they
hold no text.

```ts
// forget.ts
import type { Store } from "chaperone-chat";

/** Deletes every conversation one of your users took part in. How many went. */
export async function forgetUser(store: Store, userId: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const found = await store.listConversations({ externalRef: userId, limit: 100 });
    let gone = 0;
    for (const { conversation } of found) if (await store.deleteConversation(conversation.id)) gone++;
    deleted += gone;
    if (found.length < 100 || gone === 0) return deleted;
  }
}
```

Deleting an open conversation ends it for everyone in it: their links stop working.

## Writing your own store

The `Store` interface (exported by `chaperone-chat`) is the contract. Each method has a comment that says what it
must do. A store of your own has to keep the same promises:

- one clock, its own `now()`, read by every method that compares times;
- insertion order (`seq`) to break ties between rows written in the same millisecond;
- every claim (closing, notices, the Jev cap) atomic, so that of two racing callers exactly one wins.

The conformance suite that both shipped stores pass is in the repository, at `test/store/conformance.ts`. Run it
against your store with a harness that gives a fresh store and moves its clock.
