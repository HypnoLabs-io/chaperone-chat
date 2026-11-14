/**
 * The Postgres store on a real server: `PG_URL=postgres://… npm run test:pg`. The conformance suite runs over one
 * connection (its clock is a session setting); the races run over a pool, so claims really do arrive at once.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresStore } from "../../src/postgres";
import type { Store } from "../../src/store/types";
import { storeConformance } from "../store/conformance";

const PG_URL = process.env.PG_URL;
if (!PG_URL) throw new Error("Set PG_URL to a Postgres you can create tables in, e.g. postgres://postgres:pw@localhost:54329/postgres");

const run = Date.now().toString(36);
const client = new pg.Client({ connectionString: PG_URL });
const pool = new pg.Pool({ connectionString: PG_URL, max: 20 });
const CONCURRENCY = 20;
let tables = 0;
let connected = false;

afterAll(async () => {
  await client.end();
  await pool.end();
});

storeConformance("postgresStore on a real server", async () => {
  if (!connected) {
    await client.connect();
    connected = true;
  }
  let now = new Date("2026-03-01T12:00:00.000Z").getTime();
  const setClock = () => client.query(`SET chaperone.now = '${new Date(now).toISOString()}'`);
  await setClock();
  const store = postgresStore((text, params) => client.query(text, params), {
    prefix: `c${run}_${++tables}_`,
    clock: "current_setting('chaperone.now')::timestamptz",
  });
  await store.migrate!();
  return {
    store,
    async advance(ms) {
      now += ms;
      await setClock();
    },
  };
});

describe("races, over a pool of connections", () => {
  let store: Store;
  let n = 0;
  const id = (prefix: string) => `${prefix}_${run}_${++n}`;
  const DAY = 86_400_000;

  beforeAll(async () => {
    store = postgresStore((text, params) => pool.query(text, params), { prefix: `r${run}_` });
    await store.migrate!();
  });

  async function pair() {
    const made = await store.createConversation({
      id: id("c"),
      deadlineInMs: DAY,
      context: {},
      participants: [
        { id: id("p"), role: "a", alias: "A" },
        { id: id("p"), role: "b", alias: "B" },
      ],
    });
    return { cid: made.conversation.id, a: made.participants[0]!.id, b: made.participants[1]!.id };
  }

  const fifty = <T>(fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: 50 }, (_, i) => fn(i)));

  it("50 close claims at once: one wins", async () => {
    const { cid, a, b } = await pair();
    const results = await fifty((i) =>
      store.claimClose({ conversationId: cid, outcome: i % 2 ? "keep" : "end", by: i % 2 ? a : b, requireBeforeDeadline: true }),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("50 notice claims at once: one wins, for each kind", async () => {
    const { cid, a, b } = await pair();
    await store.insertMessage({
      id: id("m"),
      conversationId: cid,
      participantId: a,
      body: "hello",
      status: "sent",
      holdReason: null,
      policy: null,
      score: null,
      checkedBy: "rules",
    });
    const params = { everyMs: 3_600_000, graceMs: 0, reminderBeforeMs: 2 * DAY, reminderMinLeftMs: 0, closedWithinMs: DAY };
    expect((await fifty(() => store.claimNotice("message", b, params))).filter(Boolean)).toHaveLength(1);
    expect((await fifty(() => store.claimNotice("reminder", b, params))).filter(Boolean)).toHaveLength(1);
    await store.claimClose({ conversationId: cid, outcome: "done", by: "system", requireBeforeDeadline: false });
    await store.finishClose({ conversationId: cid, outcome: "done" });
    expect((await fifty(() => store.claimNotice("closed", b, params))).filter(Boolean)).toHaveLength(1);
  });

  it("50 moves of one held message at once: it moves once", async () => {
    const { cid, a } = await pair();
    const held = await store.insertMessage({
      id: id("m"),
      conversationId: cid,
      participantId: a,
      body: "wait",
      status: "held",
      holdReason: "unchecked",
      policy: null,
      score: null,
      checkedBy: "rules",
    });
    const moved = await fifty(() =>
      store.transitionMessage({
        id: held!.id,
        from: { status: "held", holdReason: "unchecked" },
        to: { status: "sent", holdReason: null, stampSent: true },
        requireOpen: true,
      }),
    );
    expect(moved.filter(Boolean)).toHaveLength(1);
  });

  it("50 votes and 50 one-shot claims at once: each records once", async () => {
    const { cid, a } = await pair();
    expect((await fifty(() => store.castVote({ conversationId: cid, participantId: a, outcome: "keep" }))).filter(Boolean)).toHaveLength(1);
    const key = id("once");
    expect((await fifty(() => store.appendEvent({ id: id("e"), type: "claim", dedupeKey: key }))).filter(Boolean)).toHaveLength(1);
  });

  it("50 claims under a cap of 10 at once: overshoots by no more than the concurrency", async () => {
    const type = id("capped");
    const results = await fifty(() =>
      store.claimEventUnderCap({ id: id("e"), type }, { type, max: 10, windowMs: DAY }),
    );
    const won = results.filter(Boolean).length;
    expect(won).toBeGreaterThanOrEqual(10);
    expect(won).toBeLessThanOrEqual(10 + CONCURRENCY);
    // Once settled, the cap holds exactly.
    expect(await store.claimEventUnderCap({ id: id("e"), type }, { type, max: 10, windowMs: DAY })).toBe(false);
  });
});
