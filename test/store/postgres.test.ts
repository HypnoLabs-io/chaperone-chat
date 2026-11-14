/**
 * The Postgres store on PGlite: real Postgres compiled to WebAssembly, in process, so the SQL runs on every
 * `npm test` with no server. The clock is a session setting the harness moves.
 */
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { isChaperoneError } from "../../src";
import { postgresStore, schemaSql, schemaStatements } from "../../src/postgres";
import { storeConformance } from "./conformance";

let db: PGlite | null = null;
let tables = 0;
const CLOCK = "current_setting('chaperone.now')::timestamptz";

async function setClock(ms: number) {
  await db!.query(`SET chaperone.now = '${new Date(ms).toISOString()}'`);
}

storeConformance("postgresStore on PGlite", async () => {
  db ??= new PGlite();
  let now = new Date("2026-03-01T12:00:00.000Z").getTime();
  await setClock(now);
  // A fresh set of tables for each test.
  const store = postgresStore((text, params) => db!.query(text, params), { prefix: `t${++tables}_`, clock: CLOCK });
  await store.migrate!();
  return {
    store,
    async advance(ms) {
      now += ms;
      await setClock(now);
    },
  };
});

describe("the schema", () => {
  it("is idempotent: migrating twice changes nothing", async () => {
    const pg = new PGlite();
    const store = postgresStore((text, params) => pg.query(text, params), { prefix: "twice_" });
    await store.migrate!();
    await store.migrate!();
    const tablesFound = await pg.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'twice_%' ORDER BY table_name",
    );
    expect(tablesFound.rows.map((r) => r.table_name)).toEqual([
      "twice_conversations",
      "twice_events",
      "twice_messages",
      "twice_meta",
      "twice_participants",
      "twice_votes",
    ]);
    const version = await pg.query<{ value: string }>("SELECT value FROM twice_meta WHERE key = 'schema_version'");
    expect(version.rows).toEqual([{ value: "1" }]);
  });

  it("prints as one script with the prefix given", () => {
    const sql = schemaSql("app_chat_");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS app_chat_conversations");
    expect(sql.split(";\n\n")).toHaveLength(schemaStatements("app_chat_").length);
  });

  it.each(["Chat_", "chat-", "x; DROP TABLE y", ""])("refuses the prefix %j", (prefix) => {
    let error: unknown;
    try {
      postgresStore(async () => ({ rows: [] }), { prefix });
    } catch (e) {
      error = e;
    }
    expect(isChaperoneError(error, "invalid_option")).toBe(true);
  });

  it("reads rows from drivers that answer with an array, as postgres.js does", async () => {
    const pg = new PGlite();
    const store = postgresStore(async (text, params) => (await pg.query(text, params)).rows as Record<string, unknown>[], {
      prefix: "arr_",
    });
    await store.migrate!();
    const made = await store.createConversation({
      id: "c1",
      deadlineInMs: null,
      context: { a: 1 },
      participants: [
        { id: "p1", role: "a", alias: "A" },
        { id: "p2", role: "b", alias: "B" },
      ],
    });
    expect(made.created).toBe(true);
    expect((await store.getConversation("c1"))!.conversation.context).toEqual({ a: 1 });
  });
});
