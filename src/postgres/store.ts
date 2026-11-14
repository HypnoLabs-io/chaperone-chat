/**
 * The Postgres store, over any driver: pass a `query(text, params)` that returns `{ rows }` or an array of rows
 * (`pg`'s `pool.query`, PGlite's `db.query`, Neon's serverless driver, postgres.js through `sql.unsafe`). Every
 * method is one statement, so HTTP drivers without transactions work; races are settled inside each statement.
 * Every parameter is cast and every count is `::int`, so drivers that send parameters as text read the same.
 */
import { ChaperoneError } from "../errors";
import { EVENT } from "../chat/event-types";
import type {
  ConversationRow,
  ConversationWithParticipants,
  Json,
  MessageRow,
  NoticeKind,
  NoticeParams,
  ParticipantRow,
  Store,
} from "../store/types";
import { checkPrefix, DEFAULT_PREFIX, schemaStatements } from "./schema";

type Row = Record<string, unknown>;
export type QueryResult = { rows: Row[] } | Row[];
export type Query = (text: string, params?: unknown[]) => Promise<QueryResult>;

export interface PostgresStoreOptions {
  /** Prefix for every table and index. Default "chat_". */
  prefix?: string;
  /**
   * The SQL the store reads as its clock. Default `now()`. Trusted SQL from your own code: tests set it to move
   * time (`current_setting('app.now')::timestamptz`).
   */
  clock?: string;
}

const date = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
};
const must = (v: unknown): Date => date(v) as Date;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const ms = (n: number) => n / 1000;

function conversationFrom(r: Row): ConversationRow {
  return {
    id: String(r.id),
    key: str(r.key),
    state: String(r.state) as ConversationRow["state"],
    outcome: str(r.outcome),
    closedBy: str(r.closed_by),
    deadline: date(r.deadline),
    context: (typeof r.context === "string" ? JSON.parse(r.context) : (r.context ?? {})) as Json,
    createdAt: must(r.created_at),
    closingAt: date(r.closing_at),
    closedAt: date(r.closed_at),
  };
}

function participantFrom(r: Row): ParticipantRow {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    role: String(r.role),
    alias: String(r.alias),
    externalRef: str(r.external_ref),
    position: Number(r.position),
    readAt: date(r.read_at),
    notifiedAt: date(r.notified_at),
    remindedAt: date(r.reminded_at),
    closedNotifiedAt: date(r.closed_notified_at),
    createdAt: must(r.created_at),
  };
}

function messageFrom(r: Row): MessageRow {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    participantId: String(r.participant_id),
    body: str(r.body),
    status: String(r.status) as MessageRow["status"],
    holdReason: str(r.hold_reason) as MessageRow["holdReason"],
    policy: str(r.policy),
    score: num(r.score),
    checkedBy: String(r.checked_by),
    createdAt: must(r.created_at),
    sentAt: date(r.sent_at),
    updatedAt: must(r.updated_at),
    seq: Number(r.seq),
  };
}

const json = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);
const list = (v: unknown): Row[] => ((json(v) ?? []) as Row[]) ?? [];

/** The Postgres store: a `Store` whose `migrate()` is always there. */
export interface PostgresStore extends Store {
  /** Creates the tables and indexes that aren't there yet. Every statement is `IF NOT EXISTS`: safe on every boot. */
  migrate(): Promise<void>;
}

export function postgresStore(query: Query, options: PostgresStoreOptions = {}): PostgresStore {
  if (typeof query !== "function") {
    throw new ChaperoneError("invalid_option", "postgresStore needs a query(text, params) function");
  }
  const p = checkPrefix(options.prefix ?? DEFAULT_PREFIX);
  const T = options.clock?.trim() ? `(${options.clock.trim()})` : "now()";

  async function rows(text: string, params: unknown[] = []): Promise<Row[]> {
    const result = await query(text, params);
    return Array.isArray(result) ? result : (result?.rows ?? []);
  }
  async function one(text: string, params: unknown[] = []): Promise<Row | null> {
    return (await rows(text, params))[0] ?? null;
  }
  const at = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  /** A conversation with its participants, from a row holding `conversation`, `participants` and `now`. */
  function withParticipants(r: Row): ConversationWithParticipants {
    const conversation = conversationFrom(json(r.conversation) as Row);
    const now = must(r.now);
    return {
      conversation,
      participants: list(r.participants).map(participantFrom),
      open:
        conversation.state === "open" && (conversation.deadline === null || conversation.deadline.getTime() > now.getTime()),
      msLeft: conversation.deadline ? Math.max(0, conversation.deadline.getTime() - now.getTime()) : null,
      now,
    };
  }

  const PARTICIPANTS = (alias: string) =>
    `coalesce((SELECT jsonb_agg(row_to_json(x) ORDER BY x.position) FROM ${p}participants x WHERE x.conversation_id = ${alias}.id), '[]'::jsonb)`;
  const OPEN = (alias: string) => `(${alias}.state = 'open' AND (${alias}.deadline IS NULL OR ${alias}.deadline > ${T}))`;

  /** The notice rules for `kind`, over `pp` (a participant) and `c` (its conversation), with params from `$base`. */
  function noticeRule(kind: NoticeKind, base: number): { sql: string; params: (n: NoticeParams) => unknown[] } {
    if (kind === "message") {
      return {
        sql: `${OPEN("c")}
          AND (pp.notified_at IS NULL OR pp.notified_at <= ${T} - make_interval(secs => $${base}::float8))
          AND EXISTS (
            SELECT 1 FROM ${p}messages m
            WHERE m.conversation_id = pp.conversation_id AND m.participant_id <> pp.id AND m.status = 'sent'
              AND m.sent_at > coalesce(pp.read_at, '-infinity'::timestamptz)
              -- The last notice covered what was old enough then: a message from the grace period before it counts.
              AND m.sent_at > coalesce(pp.notified_at - make_interval(secs => $${base + 1}::float8), '-infinity'::timestamptz)
              AND m.sent_at <= ${T} - make_interval(secs => $${base + 1}::float8))`,
        params: (n) => [ms(n.everyMs), ms(n.graceMs)],
      };
    }
    if (kind === "reminder") {
      return {
        sql: `c.state = 'open' AND c.deadline IS NOT NULL
          AND c.deadline > ${T} + make_interval(secs => $${base}::float8)
          AND c.deadline <= ${T} + make_interval(secs => $${base + 1}::float8)
          AND pp.reminded_at IS NULL`,
        params: (n) => [ms(n.reminderMinLeftMs), ms(n.reminderBeforeMs)],
      };
    }
    return {
      sql: `c.state = 'closed' AND c.closed_at >= ${T} - make_interval(secs => $${base}::float8) AND pp.closed_notified_at IS NULL`,
      params: (n) => [ms(n.closedWithinMs)],
    };
  }
  const STAMP: Record<NoticeKind, string> = { message: "notified_at", reminder: "reminded_at", closed: "closed_notified_at" };

  return {
    async migrate() {
      for (const statement of schemaStatements(p)) await rows(statement);
    },

    async now() {
      return must((await one(`SELECT ${T} AS now`))?.now);
    },

    async createConversation(input) {
      const people = JSON.stringify(
        input.participants.map((x, position) => ({
          id: x.id,
          role: x.role,
          alias: x.alias,
          external_ref: x.externalRef ?? null,
          position,
        })),
      );
      const created = await one(
        `WITH c AS (
           INSERT INTO ${p}conversations (id, key, deadline, context, created_at)
           VALUES ($1::text, $2::text,
                   CASE WHEN $3::float8 IS NULL THEN NULL ELSE ${T} + make_interval(secs => $3::float8 / 1000) END,
                   $4::jsonb, ${T})
           ON CONFLICT (key) DO NOTHING
           RETURNING *
         ), pp AS (
           INSERT INTO ${p}participants (id, conversation_id, role, alias, external_ref, position, created_at)
           SELECT x.id, c.id, x.role, x.alias, x.external_ref, x.position, ${T}
           FROM c CROSS JOIN jsonb_to_recordset($5::jsonb) AS x(id text, role text, alias text, external_ref text, position int)
           RETURNING *
         )
         SELECT row_to_json(c)::jsonb AS conversation,
                coalesce((SELECT jsonb_agg(row_to_json(pp) ORDER BY pp.position) FROM pp), '[]'::jsonb) AS participants
         FROM c`,
        [input.id, input.key ?? null, input.deadlineInMs ?? null, JSON.stringify(input.context ?? {}), people],
      );
      if (created) {
        return {
          created: true,
          conversation: conversationFrom(json(created.conversation) as Row),
          participants: list(created.participants).map(participantFrom),
        };
      }
      const existing = await one(
        `SELECT row_to_json(c)::jsonb AS conversation, ${PARTICIPANTS("c")} AS participants
         FROM ${p}conversations c WHERE c.key = $1::text`,
        [input.key ?? null],
      );
      if (!existing) throw new ChaperoneError("store_error", "the conversation could not be created");
      return {
        created: false,
        conversation: conversationFrom(json(existing.conversation) as Row),
        participants: list(existing.participants).map(participantFrom),
      };
    },

    async getConversation(id) {
      const r = await one(
        `SELECT row_to_json(c)::jsonb AS conversation, ${PARTICIPANTS("c")} AS participants, ${T} AS now
         FROM ${p}conversations c WHERE c.id = $1::text`,
        [id],
      );
      return r ? withParticipants(r) : null;
    },

    async getParticipantContext(participantId, opts = {}) {
      const r = await one(
        `WITH upd AS (
           UPDATE ${p}participants SET read_at = ${T} WHERE id = $1::text AND $2::boolean RETURNING *
         ), me AS (
           SELECT * FROM upd
           UNION ALL
           SELECT * FROM ${p}participants WHERE id = $1::text AND NOT EXISTS (SELECT 1 FROM upd)
         )
         SELECT row_to_json(me)::jsonb AS participant, row_to_json(c)::jsonb AS conversation,
                coalesce((SELECT jsonb_agg(CASE WHEN x.id = me.id THEN row_to_json(me) ELSE row_to_json(x) END ORDER BY x.position)
                          FROM ${p}participants x WHERE x.conversation_id = c.id), '[]'::jsonb) AS participants,
                ${T} AS now
         FROM me JOIN ${p}conversations c ON c.id = me.conversation_id`,
        [participantId, opts.markRead === true],
      );
      if (!r) return null;
      return { ...withParticipants(r), participant: participantFrom(json(r.participant) as Row) };
    },

    async listConversations({ externalRef, state, limit }) {
      const found = await rows(
        `SELECT row_to_json(c)::jsonb AS conversation, ${PARTICIPANTS("c")} AS participants, ${T} AS now
         FROM ${p}conversations c
         WHERE ($1::text IS NULL OR c.state = $1::text)
           AND ($2::text IS NULL OR EXISTS (
             SELECT 1 FROM ${p}participants y WHERE y.conversation_id = c.id AND y.external_ref = $2::text))
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT $3::int`,
        [state ?? null, externalRef ?? null, limit],
      );
      return found.map(withParticipants);
    },

    async deleteConversation(id) {
      return (await rows(`DELETE FROM ${p}conversations WHERE id = $1::text RETURNING id`, [id])).length > 0;
    },

    async insertMessage(input) {
      const r = await one(
        `INSERT INTO ${p}messages
           (id, conversation_id, participant_id, body, status, hold_reason, policy, score, checked_by, created_at, sent_at, updated_at)
         SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::real, $9::text, ${T},
                CASE WHEN $5::text = 'sent' THEN ${T} END, ${T}
         WHERE EXISTS (SELECT 1 FROM ${p}conversations c WHERE c.id = $2::text AND ${OPEN("c")})
           AND EXISTS (SELECT 1 FROM ${p}participants x WHERE x.id = $3::text AND x.conversation_id = $2::text)
         RETURNING *`,
        [
          input.id,
          input.conversationId,
          input.participantId,
          input.body,
          input.status,
          input.holdReason,
          input.policy,
          input.score,
          input.checkedBy,
        ],
      );
      return r ? messageFrom(r) : null;
    },

    async listMessages({ conversationId, viewerId, changedSince, limit }) {
      if (changedSince) {
        const r = await one(
          `WITH page AS (
             SELECT m.id, m.conversation_id, m.participant_id,
                    CASE WHEN m.status = 'sent' OR m.participant_id = $2::text THEN m.body END AS body,
                    m.status, m.hold_reason, m.policy, m.score, m.checked_by, m.created_at, m.sent_at, m.updated_at, m.seq,
                    NOT (m.status = 'sent' OR m.participant_id = $2::text) AS removed
             FROM ${p}messages m
             WHERE m.conversation_id = $1::text AND m.updated_at > $3::timestamptz
               AND (m.status = 'sent' OR m.participant_id = $2::text OR (m.status = 'hidden' AND m.sent_at IS NOT NULL))
             ORDER BY m.updated_at, m.seq
             LIMIT $4::int + 1
           )
           SELECT ${T} AS now,
                  coalesce((SELECT jsonb_agg(row_to_json(page) ORDER BY page.updated_at, page.seq) FROM page), '[]'::jsonb) AS rows`,
          [conversationId, viewerId, at(changedSince), limit],
        );
        const found = list(r?.rows).map((x) => ({ ...messageFrom(x), removed: x.removed === true }));
        return { messages: found.slice(0, limit), hasMore: found.length > limit, now: must(r?.now) };
      }
      const r = await one(
        `WITH page AS (
           SELECT m.*, false AS removed FROM ${p}messages m
           WHERE m.conversation_id = $1::text AND (m.status = 'sent' OR m.participant_id = $2::text)
           ORDER BY coalesce(m.sent_at, m.created_at) DESC, m.seq DESC
           LIMIT $3::int + 1
         )
         SELECT ${T} AS now,
                coalesce((SELECT jsonb_agg(row_to_json(page) ORDER BY coalesce(page.sent_at, page.created_at), page.seq) FROM page),
                         '[]'::jsonb) AS rows`,
        [conversationId, viewerId, limit],
      );
      const found = list(r?.rows).map((x) => ({ ...messageFrom(x), removed: false }));
      const hasMore = found.length > limit;
      return { messages: hasMore ? found.slice(1) : found, hasMore, now: must(r?.now) };
    },

    async recentTurns({ conversationId, senderId, contextTurns, windowMax, windowMs, before }) {
      const r = await one(
        `WITH d AS (
           SELECT id, participant_id, body, sent_at, seq FROM ${p}messages
           WHERE conversation_id = $1::text AND status = 'sent' AND body IS NOT NULL
             AND sent_at <= coalesce($6::timestamptz, ${T})
         ), ctx AS (
           SELECT * FROM d ORDER BY sent_at DESC, seq DESC LIMIT $3::int
         ), win AS (
           SELECT * FROM d
           WHERE participant_id = $2::text
             AND sent_at >= coalesce($6::timestamptz, ${T}) - make_interval(secs => $5::float8 / 1000)
           ORDER BY sent_at DESC, seq DESC LIMIT $4::int
         )
         SELECT ${T} AS now,
                coalesce((SELECT jsonb_agg(row_to_json(t) ORDER BY t.sent_at, t.seq)
                          FROM (SELECT * FROM ctx UNION SELECT * FROM win) t), '[]'::jsonb) AS rows`,
        [conversationId, senderId, Math.max(0, contextTurns), Math.max(0, windowMax), windowMs, at(before)],
      );
      return {
        turns: list(r?.rows).map((x) => ({ participantId: String(x.participant_id), body: String(x.body), sentAt: must(x.sent_at) })),
        now: must(r?.now),
      };
    },

    async countActivity({ participantId, windowMs }) {
      const r = await one(
        `SELECT
           (SELECT count(*)::int FROM ${p}messages
            WHERE participant_id = $1::text AND created_at > ${T} - make_interval(secs => $2::float8 / 1000))
         + (SELECT count(*)::int FROM ${p}events
            WHERE participant_id = $1::text AND type = $3::text AND created_at > ${T} - make_interval(secs => $2::float8 / 1000))
           AS n`,
        [participantId, windowMs, EVENT.messageBlocked],
      );
      return Number(r?.n ?? 0);
    },

    async getMessage(id) {
      const r = await one(
        `SELECT m.*, ${OPEN("c")} AS conversation_open
         FROM ${p}messages m JOIN ${p}conversations c ON c.id = m.conversation_id WHERE m.id = $1::text`,
        [id],
      );
      return r ? { ...messageFrom(r), conversationOpen: r.conversation_open === true } : null;
    },

    async listThread({ conversationId, limit }) {
      return (
        await rows(
          `SELECT * FROM (
             SELECT * FROM ${p}messages WHERE conversation_id = $1::text
             ORDER BY coalesce(sent_at, created_at) DESC, seq DESC LIMIT $2::int
           ) x ORDER BY coalesce(sent_at, created_at), seq`,
          [conversationId, limit],
        )
      ).map(messageFrom);
    },

    async transitionMessage({ id, from, to, requireOpen }) {
      const r = await one(
        `UPDATE ${p}messages m SET
           status = $2::text,
           hold_reason = CASE WHEN $5::boolean THEN $6::text ELSE m.hold_reason END,
           sent_at = CASE WHEN $7::boolean THEN ${T} ELSE m.sent_at END,
           body = CASE WHEN $8::boolean THEN NULL ELSE m.body END,
           score = CASE WHEN $9::boolean THEN $10::real ELSE m.score END,
           policy = CASE WHEN $11::boolean THEN $12::text ELSE m.policy END,
           checked_by = coalesce($13::text, m.checked_by),
           updated_at = ${T}
         WHERE m.id = $1::text AND m.status = $3::text
           AND (NOT $4::boolean OR m.hold_reason IS NOT DISTINCT FROM $14::text)
           AND (NOT $15::boolean OR EXISTS (SELECT 1 FROM ${p}conversations c WHERE c.id = m.conversation_id AND ${OPEN("c")}))
         RETURNING *`,
        [
          id,
          to.status,
          from.status,
          from.holdReason !== undefined,
          to.holdReason !== undefined,
          to.holdReason ?? null,
          to.stampSent === true,
          to.clearBody === true,
          to.score !== undefined,
          to.score ?? null,
          to.policy !== undefined,
          to.policy ?? null,
          to.checkedBy ?? null,
          from.holdReason ?? null,
          requireOpen === true,
        ],
      );
      return r ? messageFrom(r) : null;
    },

    async listHeld({ holdReason, onlyOpen, conversationId, limit }) {
      return (
        await rows(
          `SELECT m.* FROM ${p}messages m JOIN ${p}conversations c ON c.id = m.conversation_id
           WHERE m.status = 'held'
             AND ($1::text IS NULL OR m.hold_reason = $1::text)
             AND ($2::text IS NULL OR m.conversation_id = $2::text)
             AND (NOT $3::boolean OR ${OPEN("c")})
           ORDER BY m.created_at, m.seq
           LIMIT $4::int`,
          [holdReason ?? null, conversationId ?? null, onlyOpen === true, limit],
        )
      ).map(messageFrom);
    },

    async deleteMessagesAfterClose({ olderThanMs, limit }) {
      const r = await one(
        `WITH gone AS (
           DELETE FROM ${p}messages WHERE id IN (
             SELECT m.id FROM ${p}messages m JOIN ${p}conversations c ON c.id = m.conversation_id
             WHERE c.state = 'closed' AND c.closed_at <= ${T} - make_interval(secs => $1::float8 / 1000)
             ORDER BY m.created_at, m.seq LIMIT $2::int
           ) RETURNING 1
         ) SELECT count(*)::int AS n FROM gone`,
        [olderThanMs, limit],
      );
      return Number(r?.n ?? 0);
    },

    async castVote({ conversationId, participantId, outcome }) {
      const r = await rows(
        `INSERT INTO ${p}votes (conversation_id, participant_id, outcome, created_at)
         SELECT $1::text, $2::text, $3::text, ${T}
         WHERE EXISTS (SELECT 1 FROM ${p}conversations c WHERE c.id = $1::text AND ${OPEN("c")})
           AND EXISTS (SELECT 1 FROM ${p}participants x WHERE x.id = $2::text AND x.conversation_id = $1::text)
         ON CONFLICT DO NOTHING
         RETURNING 1 AS ok`,
        [conversationId, participantId, outcome],
      );
      return r.length > 0;
    },

    async listVotes(conversationId) {
      return (
        await rows(
          `SELECT participant_id, outcome, created_at FROM ${p}votes WHERE conversation_id = $1::text ORDER BY created_at, seq`,
          [conversationId],
        )
      ).map((r) => ({ participantId: String(r.participant_id), outcome: String(r.outcome), createdAt: must(r.created_at) }));
    },

    async claimClose({ conversationId, outcome, by, requireBeforeDeadline }) {
      const r = await one(
        `UPDATE ${p}conversations SET state = 'closing', outcome = $2::text, closed_by = $3::text, closing_at = ${T}
         WHERE id = $1::text AND state = 'open' AND (NOT $4::boolean OR deadline IS NULL OR deadline > ${T})
         RETURNING *`,
        [conversationId, outcome, by, requireBeforeDeadline],
      );
      return r ? conversationFrom(r) : null;
    },

    async finishClose({ conversationId, outcome }) {
      const r = await one(
        `UPDATE ${p}conversations SET state = 'closed', closed_at = ${T}
         WHERE id = $1::text AND state = 'closing' AND outcome = $2::text RETURNING *`,
        [conversationId, outcome],
      );
      return r ? conversationFrom(r) : null;
    },

    async revertClose({ conversationId, outcome }) {
      const r = await rows(
        `UPDATE ${p}conversations SET state = 'open', outcome = NULL, closed_by = NULL, closing_at = NULL
         WHERE id = $1::text AND state = 'closing' AND outcome = $2::text RETURNING id`,
        [conversationId, outcome],
      );
      return r.length > 0;
    },

    async findExpired(limit) {
      return (
        await rows(
          `SELECT id FROM ${p}conversations
           WHERE state = 'open' AND deadline IS NOT NULL AND deadline <= ${T}
           ORDER BY deadline, id LIMIT $1::int`,
          [limit],
        )
      ).map((r) => String(r.id));
    },

    async findStaleClosing({ olderThanMs, limit }) {
      return (
        await rows(
          `SELECT id, outcome, closed_by FROM ${p}conversations
           WHERE state = 'closing' AND closing_at <= ${T} - make_interval(secs => $1::float8 / 1000)
           ORDER BY closing_at, id LIMIT $2::int`,
          [olderThanMs, limit],
        )
      ).map((r) => ({ id: String(r.id), outcome: String(r.outcome), by: String(r.closed_by) }));
    },

    async findNoticeTargets(kind, params) {
      const rule = noticeRule(kind, 2);
      return (
        await rows(
          `SELECT pp.id, pp.conversation_id FROM ${p}participants pp JOIN ${p}conversations c ON c.id = pp.conversation_id
           WHERE ${rule.sql}
           ORDER BY pp.created_at, pp.conversation_id, pp.position
           LIMIT $1::int`,
          [params.limit, ...rule.params(params)],
        )
      ).map((r) => ({ participantId: String(r.id), conversationId: String(r.conversation_id) }));
    },

    async claimNotice(kind, participantId, params) {
      const rule = noticeRule(kind, 2);
      const r = await rows(
        `UPDATE ${p}participants pp SET ${STAMP[kind]} = ${T}
         FROM ${p}conversations c
         WHERE pp.id = $1::text AND c.id = pp.conversation_id AND ${rule.sql}
         RETURNING pp.id`,
        [participantId, ...rule.params(params)],
      );
      return r.length > 0;
    },

    async appendEvent(event) {
      const r = await rows(
        `INSERT INTO ${p}events (id, type, conversation_id, participant_id, dedupe_key, meta, created_at)
         VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb, ${T})
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id`,
        [
          event.id,
          event.type,
          event.conversationId ?? null,
          event.participantId ?? null,
          event.dedupeKey ?? null,
          JSON.stringify(event.meta ?? {}),
        ],
      );
      return r.length > 0;
    },

    async claimEventUnderCap(event, cap) {
      const r = await rows(
        `INSERT INTO ${p}events (id, type, conversation_id, participant_id, meta, created_at)
         SELECT $1::text, $2::text, $3::text, $4::text, $5::jsonb, ${T}
         WHERE (
           SELECT count(*) FROM ${p}events e
           WHERE e.type = $6::text AND ($7::text IS NULL OR e.participant_id = $7::text)
             AND e.created_at > ${T} - make_interval(secs => $8::float8 / 1000)
         ) < $9::int
         RETURNING id`,
        [
          event.id,
          event.type,
          event.conversationId ?? null,
          event.participantId ?? null,
          JSON.stringify(event.meta ?? {}),
          cap.type,
          cap.participantId ?? null,
          cap.windowMs,
          cap.max,
        ],
      );
      return r.length > 0;
    },

    async setEventMeta(id, meta) {
      await rows(`UPDATE ${p}events SET meta = meta || $2::jsonb WHERE id = $1::text`, [id, JSON.stringify(meta)]);
    },

    async judgeHealth({ type, windowMs, streak, settleMs }) {
      const r = await one(
        `WITH last AS (
           SELECT meta FROM ${p}events
           WHERE type = $1::text AND created_at < ${T} - make_interval(secs => $4::float8 / 1000)
           ORDER BY created_at DESC, seq DESC LIMIT $3::int
         )
         SELECT
           (SELECT count(*)::int FROM ${p}events
            WHERE type = $1::text AND created_at > ${T} - make_interval(secs => $2::float8 / 1000)) AS calls,
           (SELECT count(*)::int FROM last) AS recent,
           (SELECT count(*)::int FROM last WHERE last.meta->>'p' IS NULL) AS failed`,
        [type, windowMs, Math.max(0, streak), settleMs],
      );
      return { calls: Number(r?.calls ?? 0), recent: Number(r?.recent ?? 0), failed: Number(r?.failed ?? 0) };
    },

    async pruneEvents({ olderThanMs, limit }) {
      const r = await one(
        `WITH gone AS (
           DELETE FROM ${p}events WHERE id IN (
             SELECT id FROM ${p}events WHERE created_at <= ${T} - make_interval(secs => $1::float8 / 1000)
             ORDER BY created_at, seq LIMIT $2::int
           ) RETURNING 1
         ) SELECT count(*)::int AS n FROM gone`,
        [olderThanMs, limit],
      );
      return Number(r?.n ?? 0);
    },
  };
}
