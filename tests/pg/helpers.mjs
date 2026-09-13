/**
 * Shared harness for the PostgreSQL integration tests.
 *
 * These tests run against a REAL PostgreSQL — the local instance at
 * DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/strikedge . They FAIL
 * LOUDLY if it is missing; they never skip silently, because the whole point of the
 * extraction is that PostgreSQL is the operational authority.
 *
 * ISOLATION: each test file gets its OWN uniquely-named schema. The shared `pg.Pool`
 * the repository uses is opened with `options=-csearch_path=<schema>`, so every pooled
 * connection defaults to that schema and the files can run in any order without
 * colliding. `setup()` applies migrations 001–004 into the schema; `teardown()` drops
 * it and closes the pool.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const BASE_URL = (process.env.DATABASE_URL ?? "postgres://strikedge:strikedge@127.0.0.1:55432/strikedge").trim();

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "..", "..", "migrations");
/**
 * EVERY migration, discovered from disk in lexical order — deliberately NOT a hardcoded list.
 *
 * It WAS a hardcoded list, and that is a maintenance trap rather than a convenience: a new migration
 * silently did not reach the test schema, so the suite exercised a schema the production migration
 * runner would never produce. It cost exactly that here — migration 010 added a column, the
 * repository wrote it, and the test failed with `column "entry_attempts" does not exist`, which looks
 * like a code defect and is not one. Worse, the failure mode is asymmetric: a migration that only
 * ADDS a table nothing in the suite touches would have been missed with no failure at all, leaving
 * the suite quietly green against the wrong schema.
 *
 * The lexical order of the `NNN_` prefix is the apply order, which is the same ordering
 * `src/pg/migrate.ts` uses, so the test schema is now built the way production builds it.
 */
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** A connection string that defaults every connection to `schema`. */
function urlForSchema(schema) {
  const u = new URL(BASE_URL);
  u.searchParams.set("options", `-csearch_path=${schema}`);
  return u.toString();
}

/**
 * Prove PostgreSQL is reachable up front. Throwing here (rather than skipping) is
 * deliberate: a missing database must fail the suite loudly.
 */
export async function requirePg() {
  const c = new pg.Client({ connectionString: BASE_URL });
  try {
    await c.connect();
    await c.query("SELECT 1");
  } catch (err) {
    throw new Error(
      `PostgreSQL is required for the pg integration tests but is not reachable at ${BASE_URL}: ${err.message}`,
    );
  } finally {
    await c.end().catch(() => {});
  }
}

/**
 * Create a fresh schema, apply the migrations into it, and initialise the repository's
 * pool pointed at that schema. Returns the schema name and the loaded pool module.
 */
export async function setup(tag) {
  await requirePg();
  const schema = `pgt_${tag}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path = ${schema}`);
  for (const file of MIGRATIONS) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
    await admin.query(sql);
  }
  await admin.end();

  const pool = await import("../../dist/pg/pool.js");
  await pool.initPg({
    connectionString: urlForSchema(schema),
    poolMax: 10,
    statementTimeoutMs: 5000,
    lockTimeoutMs: 4000,
    applicationName: `gts-test-${tag}`,
  });
  return { schema, pool };
}

export async function teardown(ctx) {
  if (!ctx) return;
  await ctx.pool.closePg().catch(() => {});
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${ctx.schema} CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
}

/** Load a fresh copy of the repository module (it reads the pool lazily via getPool). */
export async function loadRepository() {
  return import("../../dist/box/repository.js");
}

export async function loadPgStore() {
  return import("../../dist/box/reservations/pgStore.js");
}

/** A minimal valid live order intent for CAS tests. */
export function baseIntent(overrides = {}) {
  return {
    client_order_id: "BOX:cas:ENTRY:k1_ce:attempt-1",
    broker_order_id: null,
    broker_mode: "live",
    broker: "zerodha",
    broker_correlation_id: null,
    trade_id: "cas-trade",
    attempt_id: "attempt-1",
    role: "k1_ce",
    purpose: "ENTRY",
    phase: "entry",
    exchange: "NFO",
    tradingsymbol: "SYM-k1_ce",
    token: 1001,
    side: "BUY",
    quantity: 75,
    reference_price: 100,
    tick_size: 0.05,
    max_chase_ticks: 2,
    limit_price: 100.1,
    state: "SUBMITTING",
    filled_quantity: 0,
    average_price: null,
    broker_tag: null,
    reject_family: null,
    reject_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    terminal_at: null,
    audit: [],
    ...overrides,
  };
}

let auditSeq = 0;
export function audit(toState, overrides = {}) {
  auditSeq += 1;
  return {
    audit_id: `audit-${auditSeq}-${Math.random().toString(36).slice(2)}`,
    at: new Date(),
    from_state: null,
    to_state: toState,
    broker_order_id: null,
    message: null,
    fill_identity: null,
    payload: null,
    ...overrides,
  };
}

/** A minimal open-box trade payload. */
export function baseTrade(overrides = {}) {
  return {
    broker: "zerodha",
    execution_mode: "paper_touch",
    underlying: "NIFTY",
    name: "NIFTY",
    is_index: true,
    expiry: "2026-09-24",
    direction: "LONG_BOX",
    lower_strike: 25000,
    upper_strike: 25200,
    lot_size: 75,
    quantity: 75,
    status: "open",
    box_width: 200,
    entry_box_cost: 195,
    entry_gross_edge: 5,
    safety_buffer: 1,
    entry_net_edge: 4,
    charge_origin: "local",
    opened_at: new Date(),
    legs: [],
    scanner_config_snapshot: {},
    ...overrides,
  };
}
