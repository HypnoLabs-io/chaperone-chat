/**
 * The tables, with a validated prefix (default `chat_`). Idempotent: every statement is `IF NOT EXISTS`, so
 * `migrate()` can run on every boot. Timestamps keep milliseconds, the precision a JavaScript `Date` holds, so a
 * cursor or a time read back compares exactly. `seq` keeps insertion order for rows stamped in the same instant.
 */
import { ChaperoneError } from "../errors";

export const DEFAULT_PREFIX = "chat_";
export const SCHEMA_VERSION = 1;
const PREFIX = /^[a-z_][a-z0-9_]{0,40}$/;

/** The prefix, checked: lowercase letters, digits and underscores, since it is written into SQL as is. */
export function checkPrefix(prefix: string): string {
  if (typeof prefix !== "string" || !PREFIX.test(prefix)) {
    throw new ChaperoneError("invalid_option", "a table prefix is lowercase letters, digits and underscores (\"chat_\")");
  }
  return prefix;
}

/** The DDL, one statement each, in order. */
export function schemaStatements(prefix: string = DEFAULT_PREFIX): string[] {
  const p = checkPrefix(prefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${p}conversations (
  id text PRIMARY KEY,
  key text UNIQUE,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closing', 'closed')),
  outcome text,
  closed_by text,
  deadline timestamptz(3),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  closing_at timestamptz(3),
  closed_at timestamptz(3)
)`,
    `CREATE TABLE IF NOT EXISTS ${p}participants (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES ${p}conversations (id) ON DELETE CASCADE,
  role text NOT NULL,
  alias text NOT NULL,
  external_ref text,
  position smallint NOT NULL,
  read_at timestamptz(3),
  notified_at timestamptz(3),
  reminded_at timestamptz(3),
  closed_notified_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, position)
)`,
    `CREATE TABLE IF NOT EXISTS ${p}messages (
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  conversation_id text NOT NULL REFERENCES ${p}conversations (id) ON DELETE CASCADE,
  participant_id text NOT NULL REFERENCES ${p}participants (id) ON DELETE CASCADE,
  body text,
  status text NOT NULL CHECK (status IN ('sent', 'held', 'refused', 'hidden')),
  hold_reason text CHECK (hold_reason IN ('appeal', 'unchecked', 'flagged')),
  policy text,
  score real,
  checked_by text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  sent_at timestamptz(3),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
)`,
    `CREATE TABLE IF NOT EXISTS ${p}votes (
  conversation_id text NOT NULL REFERENCES ${p}conversations (id) ON DELETE CASCADE,
  participant_id text NOT NULL REFERENCES ${p}participants (id) ON DELETE CASCADE,
  outcome text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, participant_id, outcome)
)`,
    // Never any message text; no foreign keys, so the log outlives a deleted conversation.
    `CREATE TABLE IF NOT EXISTS ${p}events (
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  type text NOT NULL,
  conversation_id text,
  participant_id text,
  dedupe_key text UNIQUE,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz(3) NOT NULL DEFAULT now()
)`,
    `CREATE TABLE IF NOT EXISTS ${p}meta (key text PRIMARY KEY, value text NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ${p}conversations_deadline_idx ON ${p}conversations (deadline) WHERE state = 'open'`,
    `CREATE INDEX IF NOT EXISTS ${p}conversations_closing_idx ON ${p}conversations (closing_at) WHERE state = 'closing'`,
    `CREATE INDEX IF NOT EXISTS ${p}conversations_closed_idx ON ${p}conversations (closed_at) WHERE state = 'closed'`,
    `CREATE INDEX IF NOT EXISTS ${p}participants_external_ref_idx ON ${p}participants (external_ref)`,
    `CREATE INDEX IF NOT EXISTS ${p}messages_changes_idx ON ${p}messages (conversation_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS ${p}messages_sent_idx ON ${p}messages (conversation_id, sent_at) WHERE status = 'sent'`,
    `CREATE INDEX IF NOT EXISTS ${p}messages_held_idx ON ${p}messages (created_at) WHERE status = 'held'`,
    `CREATE INDEX IF NOT EXISTS ${p}messages_participant_idx ON ${p}messages (participant_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS ${p}events_type_idx ON ${p}events (type, created_at)`,
    `CREATE INDEX IF NOT EXISTS ${p}events_participant_idx ON ${p}events (participant_id, type, created_at)`,
    `CREATE INDEX IF NOT EXISTS ${p}events_created_idx ON ${p}events (created_at)`,
    `INSERT INTO ${p}meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}') ON CONFLICT (key) DO NOTHING`,
  ];
}

/** The DDL as one script, for review or a migration tool of your own (`npx chaperone-chat schema` prints it). */
export function schemaSql(prefix: string = DEFAULT_PREFIX): string {
  return `${schemaStatements(prefix).join(";\n\n")};\n`;
}
