/**
 * chaperone-chat/postgres: the store on Postgres, over any driver.
 *
 *   import pg from "pg";
 *   const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 *   const store = postgresStore((text, params) => pool.query(text, params));
 *   await store.migrate(); // creates the tables if they aren't there; safe on every boot
 *
 * Or run `schemaSql()` (`npx chaperone-chat schema`) through a migration tool of your own.
 */
export { postgresStore, type PostgresStoreOptions, type Query, type QueryResult } from "./store";
export { checkPrefix, DEFAULT_PREFIX, SCHEMA_VERSION, schemaSql, schemaStatements } from "./schema";
export { ChaperoneError, isChaperoneError } from "../errors";
