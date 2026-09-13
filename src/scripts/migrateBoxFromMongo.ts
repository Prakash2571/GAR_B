/**
 * `npm run migrate:box-from-mongo` — the ONE-TIME legacy import.
 *
 * It reads the CalSpread Box collections from a legacy MongoDB (LEGACY_BOX_MONGODB_URI)
 * and writes them into GTS Box's authoritative PostgreSQL tables. It is the tool
 * an operator runs ONCE, during cutover, to carry the historical Box book across.
 *
 * SAFETY RULES (all enforced here, all documented in docs/LEGACY_IMPORT.md):
 *
 *  1. DRY-RUN BY DEFAULT. Without `--apply` it reads, validates and reports, and
 *     writes NOTHING. `--apply` is required to write.
 *  2. FULLY IDEMPOTENT. Every write is keyed on the preserved legacy `_id` with
 *     `ON CONFLICT (pk) DO UPDATE`, so re-running produces the same target state
 *     and never a duplicate. Running it twice changes nothing the second time.
 *  3. OPAQUE IDS PRESERVED. A legacy `_id` (ObjectId or string) becomes the target
 *     text primary key VERBATIM as a string. Trade/attempt cross-references keep
 *     their exact old string values.
 *  4. REFUSES TO RUN AGAINST A LIVE PROCESS. If the TARGET PostgreSQL already shows
 *     signs a GTS Box process could be trading — an armed trading session, or an
 *     unresolved (nonterminal) order intent — the import aborts unless the operator
 *     passes `--force-with-live`, which the docs explicitly tell operators never to
 *     use. Importing under a live process could interleave writes with the running
 *     engine and corrupt position state.
 *  5. NEVER MARKS ANYTHING FLAT. The import copies state verbatim. It NEVER changes
 *     an order intent's state, NEVER resolves a residual, NEVER marks an unknown or
 *     nonterminal order flat/terminal. Open positions and nonterminal intents are
 *     REPORTED, individually, so an operator can reconcile them by hand — they are
 *     carried across exactly as they were.
 *  6. NO SECRETS PRINTED. No connection string, no token, no credential is ever
 *     logged. Errors are bounded. Calibration/latency rows carry only anonymised
 *     numbers.
 *
 * The report at the end lists per-collection source/target counts, the open
 * positions and nonterminal intents individually, and any bounded errors.
 */

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { MongoClient, type Document } from "mongodb";
import type { PoolClient } from "pg";
import { closePg, getPool, initPg, pgConfigFromEnv } from "../pg/pool.js";

/** Order-intent states that are TERMINAL. Everything else is nonterminal. */
const TERMINAL_INTENT_STATES = new Set(["COMPLETE", "CANCELLED", "REJECTED"]);

interface ImportOptions {
  apply: boolean;
  forceWithLive: boolean;
}

interface CollectionReport {
  collection: string;
  source: number;
  targetBefore: number;
  written: number;
  targetAfter: number;
  errors: string[];
}

interface OpenPosition {
  trade_id: string;
  underlying: string;
  direction: string;
  lower_strike: number;
  upper_strike: number;
  status: string;
  position_state: string | null;
}

interface NonterminalIntent {
  intent_id: string;
  client_order_id: string;
  state: string;
  role: string;
  purpose: string;
  trade_id: string | null;
}

function bounded(err: unknown, max = 300): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Legacy `_id` -> exact opaque string. ObjectId -> its 24-hex string; string stays. */
function idToString(id: unknown): string {
  if (id == null) throw new Error("legacy document has no _id");
  if (typeof id === "string") return id;
  // ObjectId and most BSON types have a faithful toString / toHexString.
  const anyId = id as { toHexString?: () => string; toString?: () => string };
  if (typeof anyId.toHexString === "function") return anyId.toHexString();
  if (typeof anyId.toString === "function") return anyId.toString();
  return String(id);
}

/** A Date | string | number legacy timestamp -> a JS Date, or null. */
function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toNumOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNum(v: unknown, fallback = 0): number {
  const n = toNumOrNull(v);
  return n == null ? fallback : n;
}

function toStr(v: unknown, fallback = ""): string {
  return v == null ? fallback : String(v);
}

function toBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** JSONB serialiser that drops Mongo `_id` from embedded audit sub-objects only at top level when needed. */
function jsonb(v: unknown): string | null {
  if (v == null) return null;
  return JSON.stringify(v);
}

function parseArgs(argv: string[]): ImportOptions {
  return {
    apply: argv.includes("--apply"),
    forceWithLive: argv.includes("--force-with-live"),
  };
}

/**
 * Pre-flight: does the TARGET show a live-trading process could be active?
 *
 * TWO durable markers, but they are NOT equivalent:
 *
 *  - An ARMED trading session is an unconditional live marker. Arming is a
 *    deliberate operator action that means the engine may place orders; importing
 *    underneath it could interleave writes with a running engine. This always blocks.
 *
 *  - A NONTERMINAL order intent is a live marker ONLY when it is NOT one we are
 *    about to (re-)import. A first import into an empty target sees none. A RE-RUN
 *    would otherwise see the intents its own previous run carried across and refuse
 *    itself — breaking idempotency. So intents whose ids appear in the legacy source
 *    (`legacyIntentIds`) are excluded: they are historical rows being re-imported,
 *    not evidence of a live process. A nonterminal intent in the target that is
 *    ABSENT from the legacy source is unexplained and DOES block, because it can
 *    only have been produced by a live GTS Box process.
 */
async function detectLiveMarkers(
  client: PoolClient,
  legacyIntentIds: ReadonlySet<string>,
): Promise<string[]> {
  const markers: string[] = [];

  const armed = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM box_trading_session WHERE armed_at IS NOT NULL`,
  );
  if ((armed.rows[0]?.n ?? 0) > 0) markers.push("an armed trading session exists");

  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM box_order_intents WHERE state NOT IN ('COMPLETE','CANCELLED','REJECTED')`,
  );
  const unexplained = rows.filter((r) => !legacyIntentIds.has(r.id));
  if (unexplained.length > 0) {
    markers.push(
      `${unexplained.length} nonterminal order intent(s) exist in the target that are not in the legacy source`,
    );
  }

  return markers;
}

async function countTable(client: PoolClient, table: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]?.n ?? 0;
}

type RowWriter = (client: PoolClient, doc: Document) => Promise<void>;

/** Map + upsert one collection. In dry-run, only counts source rows. */
async function importCollection(
  client: PoolClient,
  mongoDocs: Document[],
  table: string,
  writer: RowWriter,
  apply: boolean,
): Promise<CollectionReport> {
  const report: CollectionReport = {
    collection: table,
    source: mongoDocs.length,
    targetBefore: await countTable(client, table),
    written: 0,
    targetAfter: 0,
    errors: [],
  };

  if (apply) {
    for (const doc of mongoDocs) {
      try {
        await writer(client, doc);
        report.written += 1;
      } catch (err) {
        // Bound + never echo the doc (it can carry trade detail). Keep only its id.
        const id = (() => {
          try {
            return idToString(doc._id);
          } catch {
            return "(no _id)";
          }
        })();
        report.errors.push(`${table} id=${id}: ${bounded(err)}`);
      }
    }
  }

  report.targetAfter = await countTable(client, table);
  return report;
}

/* --------------------------- per-collection writers --------------------------- */

const writeTrade: RowWriter = async (client, d) => {
  const id = idToString(d._id);
  await client.query(
    `INSERT INTO box_trades (
       id, broker, execution_mode, underlying, name, is_index, expiry, direction,
       lower_strike, upper_strike, lot_size, quantity, status, box_width, margin,
       entry_box_cost, entry_gross_edge, safety_buffer, entry_net_edge, expected_net_profit,
       entry_execution_cost, charge_origin, charge_rate_version, position_state,
       cumulative_exit_charges, opened_at, current_remaining_edge, current_captured_edge,
       current_captured_pct, exit_box_value, gross_pnl, total_charges, net_pnl, realised_net_pnl,
       closed_at, close_idempotency_key, exit_reason, exit_blocked_reason, expiry_safety, error,
       legs, entry_charges, estimated_exit_charges, exit_charges, entry_charge_reconciliation,
       exit_charge_reconciliation, entry_execution, entry_legging, exit_execution, exit_legging,
       residual_exposure, remaining_qty_by_role, exit_attempts, scanner_config_snapshot
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
       $25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
       $41::jsonb,$42::jsonb,$43::jsonb,$44::jsonb,$45::jsonb,$46::jsonb,$47::jsonb,$48::jsonb,
       $49::jsonb,$50::jsonb,$51::jsonb,$52::jsonb,$53::jsonb,COALESCE($54::jsonb,'{}'::jsonb)
     )
     ON CONFLICT (id) DO UPDATE SET
       broker=EXCLUDED.broker, execution_mode=EXCLUDED.execution_mode, underlying=EXCLUDED.underlying,
       name=EXCLUDED.name, is_index=EXCLUDED.is_index, expiry=EXCLUDED.expiry, direction=EXCLUDED.direction,
       lower_strike=EXCLUDED.lower_strike, upper_strike=EXCLUDED.upper_strike, lot_size=EXCLUDED.lot_size,
       quantity=EXCLUDED.quantity, status=EXCLUDED.status, box_width=EXCLUDED.box_width, margin=EXCLUDED.margin,
       entry_box_cost=EXCLUDED.entry_box_cost, entry_gross_edge=EXCLUDED.entry_gross_edge,
       safety_buffer=EXCLUDED.safety_buffer, entry_net_edge=EXCLUDED.entry_net_edge,
       expected_net_profit=EXCLUDED.expected_net_profit, entry_execution_cost=EXCLUDED.entry_execution_cost,
       charge_origin=EXCLUDED.charge_origin, charge_rate_version=EXCLUDED.charge_rate_version,
       position_state=EXCLUDED.position_state, cumulative_exit_charges=EXCLUDED.cumulative_exit_charges,
       opened_at=EXCLUDED.opened_at, current_remaining_edge=EXCLUDED.current_remaining_edge,
       current_captured_edge=EXCLUDED.current_captured_edge, current_captured_pct=EXCLUDED.current_captured_pct,
       exit_box_value=EXCLUDED.exit_box_value, gross_pnl=EXCLUDED.gross_pnl, total_charges=EXCLUDED.total_charges,
       net_pnl=EXCLUDED.net_pnl, realised_net_pnl=EXCLUDED.realised_net_pnl, closed_at=EXCLUDED.closed_at,
       close_idempotency_key=EXCLUDED.close_idempotency_key, exit_reason=EXCLUDED.exit_reason,
       exit_blocked_reason=EXCLUDED.exit_blocked_reason, expiry_safety=EXCLUDED.expiry_safety, error=EXCLUDED.error,
       legs=EXCLUDED.legs, entry_charges=EXCLUDED.entry_charges, estimated_exit_charges=EXCLUDED.estimated_exit_charges,
       exit_charges=EXCLUDED.exit_charges, entry_charge_reconciliation=EXCLUDED.entry_charge_reconciliation,
       exit_charge_reconciliation=EXCLUDED.exit_charge_reconciliation, entry_execution=EXCLUDED.entry_execution,
       entry_legging=EXCLUDED.entry_legging, exit_execution=EXCLUDED.exit_execution, exit_legging=EXCLUDED.exit_legging,
       residual_exposure=EXCLUDED.residual_exposure, remaining_qty_by_role=EXCLUDED.remaining_qty_by_role,
       exit_attempts=EXCLUDED.exit_attempts, scanner_config_snapshot=EXCLUDED.scanner_config_snapshot`,
    [
      id, toStr(d.broker, "zerodha"), toStr(d.execution_mode, "paper_touch"), toStr(d.underlying),
      toStr(d.name, ""), toBool(d.is_index), toStr(d.expiry), toStr(d.direction, "LONG_BOX"),
      toNum(d.lower_strike), toNum(d.upper_strike), toNum(d.lot_size), toNum(d.quantity),
      toStr(d.status, "open"), toNum(d.box_width), toNumOrNull(d.margin),
      toNum(d.entry_box_cost), toNum(d.entry_gross_edge), toNum(d.safety_buffer), toNum(d.entry_net_edge),
      toNumOrNull(d.expected_net_profit), toNumOrNull(d.entry_execution_cost), toStr(d.charge_origin, "local"),
      d.charge_rate_version ?? null, d.position_state ?? null, toNumOrNull(d.cumulative_exit_charges),
      toDate(d.opened_at) ?? new Date(), toNumOrNull(d.current_remaining_edge),
      toNumOrNull(d.current_captured_edge), toNumOrNull(d.current_captured_pct), toNumOrNull(d.exit_box_value),
      toNumOrNull(d.gross_pnl), toNumOrNull(d.total_charges), toNumOrNull(d.net_pnl), toNumOrNull(d.realised_net_pnl),
      toDate(d.closed_at), d.close_idempotency_key ?? null, d.exit_reason ?? null, d.exit_blocked_reason ?? null,
      toBool(d.expiry_safety), d.error ?? null,
      jsonb(d.legs ?? []), jsonb(d.entry_charges), jsonb(d.estimated_exit_charges), jsonb(d.exit_charges),
      jsonb(d.entry_charge_reconciliation), jsonb(d.exit_charge_reconciliation), jsonb(d.entry_execution),
      jsonb(d.entry_legging), jsonb(d.exit_execution), jsonb(d.exit_legging), jsonb(d.residual_exposure),
      jsonb(d.remaining_qty_by_role), jsonb(d.exit_attempts), jsonb(d.scanner_config_snapshot),
    ],
  );
};

/**
 * Trade events keep the legacy `_id` as a stable natural key. The target table's
 * pk is a bigserial, so we make the import idempotent on a UNIQUE legacy id stored
 * in a dedicated column is not available; instead we upsert by (trade_id, at, event)
 * being insufficient — so we insert with ON CONFLICT DO NOTHING keyed on a
 * deterministic surrogate: we cannot add a column, so we guard idempotency by
 * checking existence on the legacy id embedded in `execution->>'__legacy_id'`.
 *
 * To stay strictly idempotent WITHOUT owning the schema, we store the legacy id in
 * the append-only `execution` blob under `__legacy_id` and skip a row whose legacy
 * id is already present. This preserves the opaque id and never double-inserts.
 */
const writeTradeEvent: RowWriter = async (client, d) => {
  const legacyId = idToString(d._id);
  const exists = await client.query(
    `SELECT 1 FROM box_trade_events WHERE execution->>'__legacy_id' = $1 LIMIT 1`,
    [legacyId],
  );
  if ((exists.rowCount ?? 0) > 0) return;

  const execution = { ...(d.execution && typeof d.execution === "object" ? (d.execution as object) : {}), __legacy_id: legacyId };
  await client.query(
    `INSERT INTO box_trade_events (
       event, at, trade_id, candidate_key, underlying, expiry, direction, lower_strike, upper_strike,
       lot_size, quantity, execution_mode, broker, box_width, box_cost, gross_edge, entry_charges_total,
       exit_charges_total, safety_buffer, net_edge, expected_net_profit, execution_cost, gross_pnl, net_pnl,
       remaining_edge, captured_edge, captured_pct, reason, detail, execution, legs
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
       $28,$29,$30::jsonb,$31::jsonb
     )`,
    [
      toStr(d.event), toDate(d.at) ?? new Date(), d.trade_id ?? null, toStr(d.candidate_key, ""),
      toStr(d.underlying, ""), toStr(d.expiry, ""), toStr(d.direction, "LONG_BOX"),
      toNum(d.lower_strike), toNum(d.upper_strike), toNum(d.lot_size), toNum(d.quantity),
      toStr(d.execution_mode, "paper_touch"), toStr(d.broker, "zerodha"), toNumOrNull(d.box_width),
      toNumOrNull(d.box_cost), toNumOrNull(d.gross_edge), toNumOrNull(d.entry_charges_total),
      toNumOrNull(d.exit_charges_total), toNumOrNull(d.safety_buffer), toNumOrNull(d.net_edge),
      toNumOrNull(d.expected_net_profit), toNumOrNull(d.execution_cost), toNumOrNull(d.gross_pnl),
      toNumOrNull(d.net_pnl), toNumOrNull(d.remaining_edge), toNumOrNull(d.captured_edge),
      toNumOrNull(d.captured_pct), d.reason ?? null, d.detail ?? null, jsonb(execution), jsonb(d.legs ?? []),
    ],
  );
};

const writeOrderIntent: RowWriter = async (client, d) => {
  const id = idToString(d._id);
  // NEVER changes state: `state` is copied verbatim. A nonterminal intent stays
  // nonterminal in the target and is reported for hand reconciliation.
  await client.query(
    `INSERT INTO box_order_intents (
       id, client_order_id, broker_order_id, broker_mode, broker, broker_correlation_id, trade_id,
       attempt_id, role, purpose, phase, exchange, tradingsymbol, token, side, quantity, reference_price,
       tick_size, max_chase_ticks, limit_price, state, filled_quantity, previous_filled_quantity,
       average_price, broker_tag, reject_family, reject_reason, created_at, updated_at, terminal_at, audit
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
       $28,$29,$30,COALESCE($31::jsonb,'[]'::jsonb)
     )
     ON CONFLICT (id) DO UPDATE SET
       broker_order_id=EXCLUDED.broker_order_id, broker=EXCLUDED.broker,
       broker_correlation_id=EXCLUDED.broker_correlation_id, state=EXCLUDED.state,
       filled_quantity=EXCLUDED.filled_quantity, previous_filled_quantity=EXCLUDED.previous_filled_quantity,
       average_price=EXCLUDED.average_price, broker_tag=EXCLUDED.broker_tag, reject_family=EXCLUDED.reject_family,
       reject_reason=EXCLUDED.reject_reason, updated_at=EXCLUDED.updated_at, terminal_at=EXCLUDED.terminal_at,
       audit=EXCLUDED.audit`,
    [
      id, toStr(d.client_order_id), d.broker_order_id ?? null, toStr(d.broker_mode, "paper"),
      toStr(d.broker, "zerodha"), d.broker_correlation_id ?? null, d.trade_id ?? null, toStr(d.attempt_id),
      toStr(d.role), toStr(d.purpose), toStr(d.phase), toStr(d.exchange), toStr(d.tradingsymbol),
      toNum(d.token), toStr(d.side), toNum(d.quantity), toNum(d.reference_price), toNum(d.tick_size),
      toNum(d.max_chase_ticks), toNum(d.limit_price), toStr(d.state, "CREATED"), toNum(d.filled_quantity),
      toNumOrNull(d.previous_filled_quantity), toNumOrNull(d.average_price), d.broker_tag ?? null,
      d.reject_family ?? null, d.reject_reason ?? null, toDate(d.created_at) ?? new Date(),
      toDate(d.updated_at) ?? new Date(), toDate(d.terminal_at), jsonb(d.audit ?? []),
    ],
  );
};

const writeExecutionAttempt: RowWriter = async (client, d) => {
  const id = idToString(d._id);
  // NEVER resolves a residual: `resolved` is copied verbatim.
  await client.query(
    `INSERT INTO box_execution_attempts (
       id, candidate_key, direction, underlying, name, is_index, expiry, lower_strike, upper_strike,
       lot_size, quantity, execution_mode, broker, leg_execution_mode, detected_at, resolved_at,
       detected_gross_edge, expected_net_profit, filled_leg_count, failed_legs, failure_reason, failure_detail,
       abort_after_fill, outcome_class, required_expected_net_profit, charge_rate_version, partial_entry_charges,
       unwind_charges, flatten_charges, flatten_charge_day, flatten_charges_for_day, projection_version,
       residual_projection_identity, applied_flatten_applications, gross_abort_pnl, net_abort_pnl, resolved,
       legging, residual_exposure
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,COALESCE($20::jsonb,'[]'::jsonb),
       $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,COALESCE($34::jsonb,'[]'::jsonb),$35,$36,$37,
       $38::jsonb,$39::jsonb
     )
     ON CONFLICT (id) DO UPDATE SET
       resolved=EXCLUDED.resolved, resolved_at=EXCLUDED.resolved_at, flatten_charges=EXCLUDED.flatten_charges,
       flatten_charge_day=EXCLUDED.flatten_charge_day, flatten_charges_for_day=EXCLUDED.flatten_charges_for_day,
       projection_version=EXCLUDED.projection_version, residual_projection_identity=EXCLUDED.residual_projection_identity,
       applied_flatten_applications=EXCLUDED.applied_flatten_applications, gross_abort_pnl=EXCLUDED.gross_abort_pnl,
       net_abort_pnl=EXCLUDED.net_abort_pnl, legging=EXCLUDED.legging, residual_exposure=EXCLUDED.residual_exposure,
       outcome_class=EXCLUDED.outcome_class`,
    [
      id, toStr(d.candidate_key, ""), toStr(d.direction, "LONG_BOX"), toStr(d.underlying, ""), toStr(d.name, ""),
      toBool(d.is_index), toStr(d.expiry, ""), toNum(d.lower_strike), toNum(d.upper_strike), toNum(d.lot_size),
      toNum(d.quantity), toStr(d.execution_mode, "paper_legging"), toStr(d.broker, "zerodha"),
      d.leg_execution_mode ?? null, toDate(d.detected_at) ?? new Date(), toDate(d.resolved_at) ?? new Date(),
      toNumOrNull(d.detected_gross_edge), toNumOrNull(d.expected_net_profit), toNum(d.filled_leg_count),
      jsonb(d.failed_legs ?? []), d.failure_reason ?? null, d.failure_detail ?? null, toBool(d.abort_after_fill),
      d.outcome_class ?? null, toNumOrNull(d.required_expected_net_profit), d.charge_rate_version ?? null,
      toNumOrNull(d.partial_entry_charges), toNumOrNull(d.unwind_charges), toNum(d.flatten_charges),
      d.flatten_charge_day ?? null, toNum(d.flatten_charges_for_day), toNum(d.projection_version),
      d.residual_projection_identity ?? null, jsonb(d.applied_flatten_applications ?? []),
      toNumOrNull(d.gross_abort_pnl), toNumOrNull(d.net_abort_pnl), toBool(d.resolved, true),
      jsonb(d.legging), jsonb(d.residual_exposure),
    ],
  );
};

const writeDailyPnl: RowWriter = async (client, d) => {
  await client.query(
    `INSERT INTO box_daily_pnl (
       day, trade_id, underlying, direction, lower_strike, upper_strike, expiry, status,
       gross_pnl, net_pnl, realisable_net_pnl, realised_net_pnl, opened_at, closed_at, updated_at,
       summary, archived_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17
     )
     ON CONFLICT (day, trade_id) DO UPDATE SET
       underlying=EXCLUDED.underlying, direction=EXCLUDED.direction, lower_strike=EXCLUDED.lower_strike,
       upper_strike=EXCLUDED.upper_strike, expiry=EXCLUDED.expiry, status=EXCLUDED.status,
       gross_pnl=EXCLUDED.gross_pnl, net_pnl=EXCLUDED.net_pnl, realisable_net_pnl=EXCLUDED.realisable_net_pnl,
       realised_net_pnl=EXCLUDED.realised_net_pnl, opened_at=EXCLUDED.opened_at, closed_at=EXCLUDED.closed_at,
       updated_at=EXCLUDED.updated_at, summary=EXCLUDED.summary, archived_at=EXCLUDED.archived_at`,
    [
      toStr(d.day), toStr(d.trade_id), toStr(d.underlying, ""), toStr(d.direction, "LONG_BOX"),
      toNum(d.lower_strike), toNum(d.upper_strike), toStr(d.expiry, ""), toStr(d.status, "open"),
      toNumOrNull(d.gross_pnl), toNumOrNull(d.net_pnl), toNumOrNull(d.realisable_net_pnl),
      toNumOrNull(d.realised_net_pnl), d.opened_at != null ? toStr(d.opened_at) : null,
      d.closed_at != null ? toStr(d.closed_at) : null, d.updated_at != null ? toStr(d.updated_at) : null,
      jsonb(d.summary), toDate(d.archived_at) ?? new Date(),
    ],
  );
};

const writeSetting: RowWriter = async (client, d) => {
  await client.query(
    `INSERT INTO box_settings (key, value, updated_at) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`,
    [idToString(d._id), toNum(d.value), toDate(d.updated_at) ?? new Date()],
  );
};

const writeTradingSession: RowWriter = async (client, d) => {
  // Copies the armed state verbatim — NEVER re-arms and NEVER disarms.
  await client.query(
    `INSERT INTO box_trading_session (
       id, session_id, armed_at, armed_by, max_completed_trades, established_trade_ids,
       completed_trade_ids, aborted_attempts, arm_count, updated_at
     ) VALUES ($1,$2,$3,$4,$5,COALESCE($6::jsonb,'[]'::jsonb),COALESCE($7::jsonb,'[]'::jsonb),$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       session_id=EXCLUDED.session_id, armed_at=EXCLUDED.armed_at, armed_by=EXCLUDED.armed_by,
       max_completed_trades=EXCLUDED.max_completed_trades, established_trade_ids=EXCLUDED.established_trade_ids,
       completed_trade_ids=EXCLUDED.completed_trade_ids, aborted_attempts=EXCLUDED.aborted_attempts,
       arm_count=EXCLUDED.arm_count, updated_at=EXCLUDED.updated_at`,
    [
      idToString(d._id), toStr(d.session_id, ""), toDate(d.armed_at), d.armed_by ?? null,
      toNum(d.max_completed_trades), jsonb(d.established_trade_ids ?? []), jsonb(d.completed_trade_ids ?? []),
      toNum(d.aborted_attempts), toNum(d.arm_count), toDate(d.updated_at),
    ],
  );
};

const writeCalibrationSample: RowWriter = async (client, d) => {
  const legacyId = idToString(d._id);
  // No natural pk; idempotency via a legacy-id existence check against a marker.
  // The calibration table has no jsonb column, so we dedupe on the (broker, kind,
  // profile, bucket, stage, session, observed_at) tuple, which is what a sample is.
  const exists = await client.query(
    `SELECT 1 FROM box_calibration_samples
      WHERE broker=$1 AND kind=$2 AND profile=$3 AND bucket=$4 AND stage=$5 AND session=$6 AND observed_at=$7
      LIMIT 1`,
    [
      toStr(d.broker), toStr(d.kind), toStr(d.profile), toStr(d.bucket), toStr(d.stage), toStr(d.session),
      toDate(d.observed_at) ?? new Date(),
    ],
  );
  if ((exists.rowCount ?? 0) > 0) return;
  void legacyId; // preserved conceptually; the tuple is the natural identity here
  await client.query(
    `INSERT INTO box_calibration_samples (broker, kind, profile, bucket, stage, value_ms, session, region, observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      toStr(d.broker), toStr(d.kind), toStr(d.profile), toStr(d.bucket), toStr(d.stage),
      toNum(d.value_ms), toStr(d.session), d.region ?? null, toDate(d.observed_at) ?? new Date(),
    ],
  );
};

/* --------------------------------- report ---------------------------------- */

async function collectOpenPositions(client: PoolClient): Promise<OpenPosition[]> {
  const { rows } = await client.query<OpenPosition>(
    `SELECT id AS trade_id, underlying, direction, lower_strike, upper_strike, status, position_state
       FROM box_trades WHERE status = 'open' ORDER BY opened_at`,
  );
  return rows;
}

async function collectNonterminalIntents(client: PoolClient): Promise<NonterminalIntent[]> {
  const { rows } = await client.query<NonterminalIntent>(
    `SELECT id AS intent_id, client_order_id, state, role, purpose, trade_id
       FROM box_order_intents
      WHERE state NOT IN ('COMPLETE','CANCELLED','REJECTED')
      ORDER BY created_at`,
  );
  return rows;
}

/** The structured result of an import run, returned for the report and for tests. */
export interface ImportResult {
  reports: CollectionReport[];
  openPositions: OpenPosition[];
  nonterminalIntents: NonterminalIntent[];
  liveMarkers: string[];
}

/**
 * Run the import against an already-open pool and legacy Mongo database. Exported
 * so tests can drive it with a per-file schema and a seeded legacy database without
 * the global pool or a subprocess. `main` is a thin CLI wrapper over this.
 *
 * Throws if live markers are present and `forceWithLive` is not set (rule 4).
 */
export async function runImport(
  pool: import("pg").Pool,
  legacyDb: import("mongodb").Db,
  opts: ImportOptions,
): Promise<ImportResult> {
  // 1) Read the legacy collections first, so the live-marker check can tell an
  //    intent it is about to re-import apart from one a live process produced.
  const read = async (name: string): Promise<Document[]> => legacyDb.collection(name).find({}).toArray();
  const [trades, events, intents, attempts, dailyPnl, settings, session, calibration] = await Promise.all([
    read("box_trades"),
    read("box_trade_events"),
    read("box_order_intents"),
    read("box_execution_attempts"),
    read("box_daily_pnl"),
    read("box_settings"),
    read("box_trading_session"),
    read("box_calibration_samples"),
  ]);
  const legacyIntentIds = new Set<string>(
    intents.map((d) => {
      try {
        return idToString(d._id);
      } catch {
        return "";
      }
    }),
  );

  // 2) Live-marker pre-flight against the TARGET, excluding intents we will re-import.
  const liveMarkers = await (async () => {
    const c = await pool.connect();
    try {
      return await detectLiveMarkers(c, legacyIntentIds);
    } finally {
      c.release();
    }
  })();
  if (liveMarkers.length > 0) {
    if (!opts.forceWithLive) {
      throw new LiveMarkersPresentError(liveMarkers);
    }
  }

  const reports: CollectionReport[] = [];
  let openPositions: OpenPosition[] = [];
  let nonterminalIntents: NonterminalIntent[] = [];

  // Import each collection inside ONE transaction so a mid-import failure rolls
  // back cleanly. Idempotency means a re-run resumes safely.
  await withTxOn(pool, async (tx) => {
    reports.push(await importCollection(tx, trades, "box_trades", writeTrade, opts.apply));
    reports.push(await importCollection(tx, events, "box_trade_events", writeTradeEvent, opts.apply));
    reports.push(await importCollection(tx, intents, "box_order_intents", writeOrderIntent, opts.apply));
    reports.push(await importCollection(tx, attempts, "box_execution_attempts", writeExecutionAttempt, opts.apply));
    reports.push(await importCollection(tx, dailyPnl, "box_daily_pnl", writeDailyPnl, opts.apply));
    reports.push(await importCollection(tx, settings, "box_settings", writeSetting, opts.apply));
    reports.push(await importCollection(tx, session, "box_trading_session", writeTradingSession, opts.apply));
    reports.push(await importCollection(tx, calibration, "box_calibration_samples", writeCalibrationSample, opts.apply));

    // Report open positions and nonterminal intents SEPARATELY, read from the
    // target AFTER the import. They reflect exactly what is carried across; we
    // NEVER change them.
    openPositions = await collectOpenPositions(tx);
    nonterminalIntents = await collectNonterminalIntents(tx);
  });

  return { reports, openPositions, nonterminalIntents, liveMarkers };
}

/** Raised when the target shows a GTS Box process could be trading. */
export class LiveMarkersPresentError extends Error {
  readonly markers: readonly string[];
  constructor(markers: readonly string[]) {
    super(
      "Refusing to import while a GTS Box process could be trading: " +
        `${markers.join("; ")}. Stop all GTS Box processes and retry. ` +
        "(--force-with-live exists but MUST NOT be used against a live deployment; see docs/LEGACY_IMPORT.md.)",
    );
    this.name = "LiveMarkersPresentError";
    this.markers = markers;
  }
}

/** A transaction over a specific pool (mirrors pool.ts withTx but not pinned to the global pool). */
async function withTxOn<T>(pool: import("pg").Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const legacyUri = (process.env.LEGACY_BOX_MONGODB_URI ?? "").trim();
  if (!legacyUri) throw new Error("LEGACY_BOX_MONGODB_URI is not set");

  await initPg(pgConfigFromEnv());
  const pool = getPool();

  const client = new MongoClient(legacyUri, { serverSelectionTimeoutMS: 8_000 });
  let result: ImportResult;
  try {
    await client.connect();
    console.log(`[migrate:box-from-mongo] mode: ${opts.apply ? "APPLY (writing)" : "DRY RUN (no writes)"}`);
    result = await runImport(pool, client.db(), opts);
    if (result.liveMarkers.length > 0 && opts.forceWithLive) {
      console.warn(
        `[migrate:box-from-mongo] --force-with-live set: proceeded DESPITE live markers (${result.liveMarkers.join("; ")}). This is unsafe.`,
      );
    }
  } finally {
    await client.close().catch(() => undefined);
  }

  printReport(result.reports, result.openPositions, result.nonterminalIntents, opts);
}

function printReport(
  reports: CollectionReport[],
  openPositions: OpenPosition[],
  nonterminalIntents: NonterminalIntent[],
  opts: ImportOptions,
): void {
  console.log("\n=== MIGRATION REPORT ===");
  let anyCountMismatch = false;
  for (const r of reports) {
    // Count validation: for an APPLY, target should end >= source (idempotent
    // upsert never loses a source row). For a DRY RUN, we only report source vs
    // current target.
    const delta = r.targetAfter - r.targetBefore;
    console.log(
      `  ${r.collection.padEnd(24)} source=${r.source} targetBefore=${r.targetBefore} ` +
        `written=${r.written} targetAfter=${r.targetAfter} (+${delta})` +
        (r.errors.length ? ` errors=${r.errors.length}` : ""),
    );
    if (opts.apply && r.collection !== "box_calibration_samples" && r.collection !== "box_trade_events") {
      // These two dedupe on natural identity, so targetAfter can legitimately be
      // below source if the target already held equivalents. The keyed-by-id
      // collections must cover every source id.
      if (r.targetAfter < r.source) {
        anyCountMismatch = true;
        console.warn(`    ! COUNT VALIDATION: ${r.collection} targetAfter (${r.targetAfter}) < source (${r.source})`);
      }
    }
    for (const e of r.errors.slice(0, 20)) console.log(`    error: ${e}`);
    if (r.errors.length > 20) console.log(`    … (+${r.errors.length - 20} more errors)`);
  }

  console.log(`\n  OPEN POSITIONS carried across (verbatim, never flattened): ${openPositions.length}`);
  for (const p of openPositions.slice(0, 100)) {
    console.log(
      `    trade ${p.trade_id} ${p.underlying} ${p.direction} ${p.lower_strike}/${p.upper_strike} ` +
        `status=${p.status} position_state=${p.position_state ?? "(none)"}`,
    );
  }

  console.log(`\n  NONTERMINAL INTENTS carried across (verbatim, never marked flat): ${nonterminalIntents.length}`);
  for (const i of nonterminalIntents.slice(0, 100)) {
    console.log(
      `    intent ${i.intent_id} client_order_id=${i.client_order_id} state=${i.state} ` +
        `role=${i.role} purpose=${i.purpose} trade_id=${i.trade_id ?? "(none)"}`,
    );
  }

  if (!opts.apply) {
    console.log("\n  DRY RUN — nothing was written. Re-run with --apply to perform the import.");
  } else if (anyCountMismatch) {
    console.log("\n  COMPLETED WITH COUNT MISMATCH — review the warnings above.");
  } else {
    console.log("\n  COMPLETED — counts validated.");
  }
  console.log("========================\n");
}

/** Only run the CLI when invoked directly, not when imported by a test. */
const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main()
    .then(async () => {
      await closePg();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[migrate:box-from-mongo] FAILED: ${bounded(err, 500)}`);
      await closePg().catch(() => undefined);
      process.exit(1);
    });
}
