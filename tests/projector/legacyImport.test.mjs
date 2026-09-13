/**
 * Legacy Box import tests.
 *
 * Drives the exported `runImport` against a per-file PostgreSQL schema (holding the
 * target Box tables) and a per-file legacy MongoDB database seeded with legacy Box
 * documents. Proves: dry-run writes nothing; --apply is idempotent across two runs;
 * counts validate; open positions and nonterminal intents are reported and NEVER
 * marked flat; and the import refuses to run against a live-marked target.
 *
 * Fails loudly if PostgreSQL or MongoDB is missing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { MongoClient } from "mongodb";
import { runImport, LiveMarkersPresentError } from "../../dist/scripts/migrateBoxFromMongo.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://strikedge:strikedge@127.0.0.1:55432/strikedge";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:57017/strikedge_test";

/** Minimal target DDL: the columns the import writes. Mirrors migrations 002/003. */
const TARGET_DDL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'box_broker') THEN
    CREATE DOMAIN box_broker AS text CHECK (VALUE IN ('zerodha','dhan'));
  END IF;
END$$;

CREATE TABLE box_trades (
  id text PRIMARY KEY, broker box_broker NOT NULL DEFAULT 'zerodha', execution_mode text NOT NULL DEFAULT 'paper_touch',
  underlying text NOT NULL, name text NOT NULL DEFAULT '', is_index boolean NOT NULL DEFAULT false, expiry text NOT NULL,
  direction text NOT NULL DEFAULT 'LONG_BOX', lower_strike numeric NOT NULL, upper_strike numeric NOT NULL,
  lot_size numeric NOT NULL, quantity numeric NOT NULL, status text NOT NULL DEFAULT 'open', box_width numeric NOT NULL,
  margin numeric, entry_box_cost numeric NOT NULL, entry_gross_edge numeric NOT NULL, safety_buffer numeric NOT NULL DEFAULT 0,
  entry_net_edge numeric NOT NULL, expected_net_profit numeric, entry_execution_cost numeric,
  charge_origin text NOT NULL DEFAULT 'local', charge_rate_version text, position_state text, cumulative_exit_charges numeric,
  opened_at timestamptz NOT NULL DEFAULT now(), current_remaining_edge numeric, current_captured_edge numeric,
  current_captured_pct numeric, exit_box_value numeric, gross_pnl numeric, total_charges numeric, net_pnl numeric,
  realised_net_pnl numeric, closed_at timestamptz, close_idempotency_key text, exit_reason text, exit_blocked_reason text,
  expiry_safety boolean NOT NULL DEFAULT false, error text, legs jsonb NOT NULL DEFAULT '[]'::jsonb, entry_charges jsonb,
  estimated_exit_charges jsonb, exit_charges jsonb, entry_charge_reconciliation jsonb, exit_charge_reconciliation jsonb,
  entry_execution jsonb, entry_legging jsonb, exit_execution jsonb, exit_legging jsonb, residual_exposure jsonb,
  remaining_qty_by_role jsonb, exit_attempts jsonb, scanner_config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE box_trade_events (
  id bigserial PRIMARY KEY, event text NOT NULL, at timestamptz NOT NULL DEFAULT now(), trade_id text,
  candidate_key text NOT NULL DEFAULT '', underlying text NOT NULL DEFAULT '', expiry text NOT NULL DEFAULT '',
  direction text NOT NULL DEFAULT 'LONG_BOX', lower_strike numeric NOT NULL DEFAULT 0, upper_strike numeric NOT NULL DEFAULT 0,
  lot_size numeric NOT NULL DEFAULT 0, quantity numeric NOT NULL DEFAULT 0, execution_mode text NOT NULL DEFAULT 'paper_touch',
  broker box_broker NOT NULL DEFAULT 'zerodha', box_width numeric, box_cost numeric, gross_edge numeric,
  entry_charges_total numeric, exit_charges_total numeric, safety_buffer numeric, net_edge numeric, expected_net_profit numeric,
  execution_cost numeric, gross_pnl numeric, net_pnl numeric, remaining_edge numeric, captured_edge numeric, captured_pct numeric,
  reason text, detail text, execution jsonb, legs jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE box_order_intents (
  id text PRIMARY KEY, client_order_id text NOT NULL, broker_order_id text, broker_mode text NOT NULL,
  broker box_broker NOT NULL DEFAULT 'zerodha', broker_correlation_id text, trade_id text, attempt_id text NOT NULL,
  role text NOT NULL, purpose text NOT NULL, phase text NOT NULL, exchange text NOT NULL, tradingsymbol text NOT NULL,
  token numeric NOT NULL, side text NOT NULL, quantity numeric NOT NULL, reference_price numeric NOT NULL,
  tick_size numeric NOT NULL, max_chase_ticks numeric NOT NULL, limit_price numeric NOT NULL, state text NOT NULL DEFAULT 'CREATED',
  filled_quantity numeric NOT NULL DEFAULT 0, previous_filled_quantity numeric, average_price numeric, broker_tag text,
  reject_family text, reject_reason text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, terminal_at timestamptz,
  audit jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE box_execution_attempts (
  id text PRIMARY KEY, candidate_key text NOT NULL DEFAULT '', direction text NOT NULL DEFAULT 'LONG_BOX',
  underlying text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '', is_index boolean NOT NULL DEFAULT false,
  expiry text NOT NULL DEFAULT '', lower_strike numeric NOT NULL DEFAULT 0, upper_strike numeric NOT NULL DEFAULT 0,
  lot_size numeric NOT NULL DEFAULT 0, quantity numeric NOT NULL DEFAULT 0, execution_mode text NOT NULL DEFAULT 'paper_legging',
  broker box_broker NOT NULL DEFAULT 'zerodha', leg_execution_mode text, detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NOT NULL DEFAULT now(), detected_gross_edge numeric, expected_net_profit numeric,
  filled_leg_count numeric NOT NULL DEFAULT 0, failed_legs jsonb NOT NULL DEFAULT '[]'::jsonb, failure_reason text,
  failure_detail text, abort_after_fill boolean NOT NULL DEFAULT false, outcome_class text, required_expected_net_profit numeric,
  charge_rate_version text, partial_entry_charges numeric, unwind_charges numeric, flatten_charges numeric NOT NULL DEFAULT 0,
  flatten_charge_day text, flatten_charges_for_day numeric NOT NULL DEFAULT 0, projection_version numeric NOT NULL DEFAULT 0,
  residual_projection_identity text, applied_flatten_applications jsonb NOT NULL DEFAULT '[]'::jsonb, gross_abort_pnl numeric,
  net_abort_pnl numeric, resolved boolean NOT NULL DEFAULT true, legging jsonb, residual_exposure jsonb
);

CREATE TABLE box_daily_pnl (
  day text NOT NULL, trade_id text NOT NULL, underlying text NOT NULL DEFAULT '', direction text NOT NULL DEFAULT 'LONG_BOX',
  lower_strike numeric NOT NULL DEFAULT 0, upper_strike numeric NOT NULL DEFAULT 0, expiry text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open', gross_pnl numeric, net_pnl numeric, realisable_net_pnl numeric, realised_net_pnl numeric,
  opened_at text, closed_at text, updated_at text, summary jsonb, archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, trade_id)
);

CREATE TABLE box_settings (key text PRIMARY KEY, value numeric NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE box_trading_session (
  id text PRIMARY KEY, session_id text NOT NULL DEFAULT '', armed_at timestamptz, armed_by text,
  max_completed_trades numeric NOT NULL DEFAULT 0, established_trade_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_trade_ids jsonb NOT NULL DEFAULT '[]'::jsonb, aborted_attempts numeric NOT NULL DEFAULT 0,
  arm_count numeric NOT NULL DEFAULT 0, updated_at timestamptz
);

CREATE TABLE box_calibration_samples (
  id bigserial PRIMARY KEY, broker text NOT NULL, kind text NOT NULL, profile text NOT NULL, bucket text NOT NULL,
  stage text NOT NULL, value_ms numeric NOT NULL, session text NOT NULL, region text, observed_at timestamptz NOT NULL
);
`;

function replaceMongoDb(uri, dbName) {
  const [beforeQuery, query] = uri.split("?");
  const withoutDb = beforeQuery.replace(/\/[^/]*$/, "");
  const rebuilt = `${withoutDb}/${dbName}`;
  return query ? `${rebuilt}?${query}` : rebuilt;
}

async function createLegacyHarness() {
  const suffix = `${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const schema = `t_legacy_${suffix}`;
  const legacyDbName = `legacy_${suffix}`;
  const legacyUri = replaceMongoDb(MONGODB_URI, legacyDbName);

  pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
  pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

  let pool;
  try {
    const bootstrap = new pg.Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end().catch(() => undefined);
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6, connectionTimeoutMillis: 5_000, options: `-c search_path=${schema}` });
    await pool.query(TARGET_DDL);
  } catch (err) {
    if (pool) await pool.end().catch(() => undefined);
    throw new Error(`PostgreSQL is required for the legacy-import tests: ${err && err.message ? err.message : err}`);
  }

  let mongo;
  try {
    mongo = new MongoClient(legacyUri, { serverSelectionTimeoutMS: 5_000 });
    await mongo.connect();
    await mongo.db(legacyDbName).command({ ping: 1 });
  } catch (err) {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw new Error(`MongoDB is required for the legacy-import tests: ${err && err.message ? err.message : err}`);
  }

  return {
    pool,
    schema,
    legacyDb: mongo.db(legacyDbName),
    async cleanup() {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await pool.end().catch(() => undefined);
      await mongo.db(legacyDbName).dropDatabase().catch(() => undefined);
      await mongo.close().catch(() => undefined);
    },
  };
}

/** Seed a small legacy Box dataset: one open trade, one nonterminal intent, settings, session, pnl. */
async function seedLegacy(db) {
  await db.collection("box_trades").insertMany([
    { _id: "trade-open-1", underlying: "NIFTY", expiry: "2026-09-24", direction: "LONG_BOX", lower_strike: 24000,
      upper_strike: 24500, lot_size: 75, quantity: 75, status: "open", box_width: 500, entry_box_cost: 480,
      entry_gross_edge: 20, entry_net_edge: 15, position_state: "BOX", opened_at: new Date(), legs: [{ role: "k1_ce" }] },
    { _id: "trade-closed-1", underlying: "BANKNIFTY", expiry: "2026-09-24", direction: "SHORT_BOX", lower_strike: 51000,
      upper_strike: 51500, lot_size: 35, quantity: 35, status: "closed", box_width: 500, entry_box_cost: 505,
      entry_gross_edge: -5, entry_net_edge: -8, net_pnl: -8, opened_at: new Date(), closed_at: new Date(), legs: [] },
  ]);
  await db.collection("box_order_intents").insertMany([
    // NONTERMINAL: state OPEN — must be reported and never marked flat.
    { _id: "intent-open-1", client_order_id: "co-1", broker_mode: "live", trade_id: "trade-open-1", attempt_id: "a1",
      role: "k1_ce", purpose: "ENTRY", phase: "entry", exchange: "NFO", tradingsymbol: "NIFTY24500CE", token: 111,
      side: "BUY", quantity: 75, reference_price: 10, tick_size: 0.05, max_chase_ticks: 3, limit_price: 10.15,
      state: "OPEN", filled_quantity: 0, created_at: new Date(), updated_at: new Date(), audit: [] },
    // TERMINAL: COMPLETE.
    { _id: "intent-done-1", client_order_id: "co-2", broker_mode: "live", trade_id: "trade-closed-1", attempt_id: "a2",
      role: "k1_pe", purpose: "EXIT", phase: "exit", exchange: "NFO", tradingsymbol: "BANKNIFTY51000PE", token: 222,
      side: "SELL", quantity: 35, reference_price: 12, tick_size: 0.05, max_chase_ticks: 3, limit_price: 11.85,
      state: "COMPLETE", filled_quantity: 35, created_at: new Date(), updated_at: new Date(), terminal_at: new Date(), audit: [] },
  ]);
  await db.collection("box_execution_attempts").insertOne({
    _id: "attempt-1", candidate_key: "NIFTY:24000:24500", underlying: "NIFTY", expiry: "2026-09-24", lower_strike: 24000,
    upper_strike: 24500, filled_leg_count: 2, resolved: true, resolved_at: new Date(), detected_at: new Date(),
  });
  await db.collection("box_daily_pnl").insertMany([
    { _id: "p1", day: "2026-09-08", trade_id: "trade-closed-1", underlying: "BANKNIFTY", status: "closed", net_pnl: -8 },
    { _id: "p2", day: "2026-09-08", trade_id: "__summary__", status: "summary", summary: { net: -8 } },
  ]);
  await db.collection("box_settings").insertOne({ _id: "min_expected_net_profit", value: 10, updated_at: new Date() });
  await db.collection("box_trading_session").insertOne({
    _id: "current", session_id: "s1", armed_at: null, max_completed_trades: 1, established_trade_ids: [],
    completed_trade_ids: [], aborted_attempts: 0, arm_count: 0, updated_at: new Date(),
  });
  await db.collection("box_calibration_samples").insertOne({
    _id: "cal-1", broker: "zerodha", kind: "ack", profile: "default", bucket: "b1", stage: "submit", value_ms: 42,
    session: "2026-09-08", region: "mum", observed_at: new Date(),
  });
}

test("legacy import: DRY RUN writes nothing", async (t) => {
  const h = await createLegacyHarness();
  t.after(() => h.cleanup());
  await seedLegacy(h.legacyDb);

  const result = await runImport(h.pool, h.legacyDb, { apply: false, forceWithLive: false });

  // Source counts were read, but nothing was written.
  const tradeReport = result.reports.find((r) => r.collection === "box_trades");
  assert.equal(tradeReport.source, 2, "read 2 source trades");
  assert.equal(tradeReport.written, 0, "dry-run wrote nothing");

  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM box_trades`);
  assert.equal(rows[0].n, 0, "target box_trades is still empty after dry-run");
});

test("legacy import: --apply is idempotent across two runs; counts validate", async (t) => {
  const h = await createLegacyHarness();
  t.after(() => h.cleanup());
  await seedLegacy(h.legacyDb);

  const r1 = await runImport(h.pool, h.legacyDb, { apply: true, forceWithLive: false });
  const tradesAfter1 = (await h.pool.query(`SELECT count(*)::int AS n FROM box_trades`)).rows[0].n;
  const intentsAfter1 = (await h.pool.query(`SELECT count(*)::int AS n FROM box_order_intents`)).rows[0].n;
  const pnlAfter1 = (await h.pool.query(`SELECT count(*)::int AS n FROM box_daily_pnl`)).rows[0].n;
  const calAfter1 = (await h.pool.query(`SELECT count(*)::int AS n FROM box_calibration_samples`)).rows[0].n;
  const eventsAfter1 = (await h.pool.query(`SELECT count(*)::int AS n FROM box_trade_events`)).rows[0].n;

  assert.equal(tradesAfter1, 2, "both trades imported");
  assert.equal(intentsAfter1, 2, "both intents imported");
  assert.equal(pnlAfter1, 2, "both pnl rows imported");
  assert.equal(calAfter1, 1, "calibration sample imported");

  // Count validation: keyed-by-id collections cover every source id.
  const tradeReport = r1.reports.find((r) => r.collection === "box_trades");
  assert.ok(tradeReport.targetAfter >= tradeReport.source, "target covers source");

  // Second run: idempotent — no duplicates, same counts.
  await runImport(h.pool, h.legacyDb, { apply: true, forceWithLive: false });
  const tradesAfter2 = (await h.pool.query(`SELECT count(*)::int AS n FROM box_trades`)).rows[0].n;
  const intentsAfter2 = (await h.pool.query(`SELECT count(*)::int AS n FROM box_order_intents`)).rows[0].n;
  const pnlAfter2 = (await h.pool.query(`SELECT count(*)::int AS n FROM box_daily_pnl`)).rows[0].n;
  const calAfter2 = (await h.pool.query(`SELECT count(*)::int AS n FROM box_calibration_samples`)).rows[0].n;
  const eventsAfter2 = (await h.pool.query(`SELECT count(*)::int AS n FROM box_trade_events`)).rows[0].n;

  assert.equal(tradesAfter2, tradesAfter1, "trades unchanged on re-run");
  assert.equal(intentsAfter2, intentsAfter1, "intents unchanged on re-run");
  assert.equal(pnlAfter2, pnlAfter1, "pnl unchanged on re-run");
  assert.equal(calAfter2, calAfter1, "calibration NOT duplicated on re-run (natural-key dedupe)");
  assert.equal(eventsAfter2, eventsAfter1, "events NOT duplicated on re-run (legacy-id dedupe)");
});

test("legacy import: nonterminal intent + open position are reported and NEVER marked flat", async (t) => {
  const h = await createLegacyHarness();
  t.after(() => h.cleanup());
  await seedLegacy(h.legacyDb);

  const result = await runImport(h.pool, h.legacyDb, { apply: true, forceWithLive: false });

  // Reported separately.
  assert.equal(result.openPositions.length, 1, "one open position reported");
  assert.equal(result.openPositions[0].trade_id, "trade-open-1");
  assert.equal(result.nonterminalIntents.length, 1, "one nonterminal intent reported");
  assert.equal(result.nonterminalIntents[0].intent_id, "intent-open-1");
  assert.equal(result.nonterminalIntents[0].state, "OPEN", "state carried across verbatim");

  // The intent's state in the target is EXACTLY what it was — never marked flat/terminal.
  const { rows } = await h.pool.query(`SELECT state, terminal_at FROM box_order_intents WHERE id = 'intent-open-1'`);
  assert.equal(rows[0].state, "OPEN", "nonterminal intent NOT marked flat");
  assert.equal(rows[0].terminal_at, null, "nonterminal intent has no terminal timestamp");

  // The open position stays open.
  const { rows: t2 } = await h.pool.query(`SELECT status FROM box_trades WHERE id = 'trade-open-1'`);
  assert.equal(t2[0].status, "open", "open position NOT flattened");
});

test("legacy import: refuses to run against a live-marked target (armed session) without --force-with-live", async (t) => {
  const h = await createLegacyHarness();
  t.after(() => h.cleanup());
  await seedLegacy(h.legacyDb);

  // Mark the target live: an armed trading session.
  await h.pool.query(
    `INSERT INTO box_trading_session (id, session_id, armed_at, max_completed_trades) VALUES ('current','live',now(),1)`,
  );

  await assert.rejects(
    () => runImport(h.pool, h.legacyDb, { apply: true, forceWithLive: false }),
    LiveMarkersPresentError,
    "must refuse while a GTS Box process could be trading",
  );

  // Nothing was written because it aborted before the import transaction.
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM box_trades`);
  assert.equal(rows[0].n, 0, "no import happened under the live block");
});
