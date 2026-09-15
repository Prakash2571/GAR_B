/**
 * PostgreSQL persistence for box trades and the box event ledger — this backend's
 * operational authority.
 *
 * This is the rewrite of the predecessor codebase's Mongoose repository. Its EXPORTED NAMES,
 * SIGNATURES AND OBSERVABLE SEMANTICS are frozen: the Box domain (engine,
 * orderManager, positionMonitor, executionGateway, …) reaches durable state only
 * through this module, and the ported unit tests are written against this surface.
 * Only the implementation moved from Mongoose to `pg`.
 *
 * TWO BEHAVIOURAL ADDITIONS, both required by the extraction:
 *  1. Every mutation that must reach MongoDB Atlas enqueues an outbox row via
 *     `enqueueOutbox(client, …)` on the SAME PoolClient inside the SAME transaction.
 *  2. `updateBoxOrderIntent` returns the authoritative DURABLE pre-write and
 *     post-write cumulative filled quantities, read under a row lock — never derived
 *     from a caller snapshot.
 *
 * Mongo stays OUT of the hot path exactly as before: the scanner and monitor work
 * from an in-memory view, and this module is called only when something happens.
 */

import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import {
  getPool,
  isPgReady,
  isUniqueViolation,
  query,
  withClient,
  withTx,
} from "../pg/pool.js";
import { enqueueOutbox, enqueueOutboxSnapshot } from "../outbox/writer.js";
import type { BoxMarginSource } from "./brokerContext.js";
import { LEGACY_BROKER, type BrokerId } from "../brokers/types.js";
import {
  MAX_FLATTEN_APPLICATION_IDS,
  residualProjectionIdentity,
  type BoxExecutionAttemptProjectionCommand,
  type BoxExecutionAttemptProjectionResult,
} from "./executionAttemptProjection.js";
import {
  BoxPnlDayProofBuilder,
  SUMMARY_FIELD,
  boxPnlDayProofsEqual,
  boxPnlSummariesEqual,
  boxPnlSummaryMatchesRows,
  buildBoxPnlDayProof,
  type BoxPnlDayProof,
} from "./pnlSnapshot.js";
import {
  isBoxEventLedgerEnabled,
  type BoxDailyPnlRecord,
  type BoxExecutionAttemptRecord,
  type BoxOrderIntentRecord,
  type BoxTradeRecord,
  type IBoxDailyPnl,
  type IBoxSetting,
  type IBoxTradingSessionDoc,
} from "./model.js";
import type {
  BoxChargeReconciliation,
  BoxDirection,
  BoxEventLeg,
  BoxEventType,
  BoxExecutionRecord,
  BoxOrderIntentAudit,
  BoxOrderIntentPatch,
  BoxOrderIntentState,
  BoxPositionState,
  ExecutionMode,
  IBoxExecutionAttempt,
  IBoxOrderIntent,
  IBoxTrade,
  IBoxTradeEvent,
} from "./types.js";
import type { BoxSessionRecord } from "./tradingSession.js";

/** Projection schema version stamped on every outbox payload this module produces. */
const BOX_PROJECTION_SCHEMA_VERSION = 1;

export const BOX_RECOVERY_UNIQUE_INDEX = "box_single_unresolved_crash_recovery";
export const BOX_RECOVERY_KEY = "boot-recovery";

/** How long a failed re-verification waits before the next readiness request may retry. */
export const BOX_RECOVERY_REVERIFY_BACKOFF_MS = 30_000;

/* --------------------------- crash-recovery gate --------------------------- */

interface BoxExecutionAttemptIndexDescription {
  name?: string;
  unique?: boolean;
  key?: Record<string, unknown>;
  partialFilterExpression?: Record<string, unknown>;
}

function exactRecord(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
): boolean {
  if (!actual) return false;
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(actual, key) &&
      actual[key] === expected[key]);
}

/**
 * Pure validation used by startup and offline tests. Any duplicate unresolved recovery
 * rows, or drift in the safety-critical index, is an operator-repair condition — never
 * something to guess through by selecting one row. Ported verbatim from the predecessor codebase; the
 * index it validates is now the PostgreSQL partial unique index
 * `box_single_unresolved_crash_recovery`, presented in the same descriptor shape.
 */
export function boxRecoveryPersistenceValidationError(
  indexes: readonly BoxExecutionAttemptIndexDescription[],
  unresolvedRecoveryIds: readonly string[],
): string | null {
  if (unresolvedRecoveryIds.length > 1) {
    return `duplicate unresolved ${BOX_RECOVERY_KEY} rows: ${unresolvedRecoveryIds.join(", ")}`;
  }
  const index = indexes.find((candidate) => candidate.name === BOX_RECOVERY_UNIQUE_INDEX);
  if (!index) return `missing ${BOX_RECOVERY_UNIQUE_INDEX} index`;
  if (index.unique !== true) return `${BOX_RECOVERY_UNIQUE_INDEX} is not unique`;
  if (!exactRecord(index.key, { candidate_key: 1 })) {
    return `${BOX_RECOVERY_UNIQUE_INDEX} has incompatible keys`;
  }
  if (!exactRecord(index.partialFilterExpression, {
    candidate_key: BOX_RECOVERY_KEY,
    resolved: false,
  })) {
    return `${BOX_RECOVERY_UNIQUE_INDEX} has an incompatible partial filter`;
  }
  return null;
}

/**
 * Readiness gate for the crash-recovery uniqueness boundary. Ported verbatim: it is a
 * pure state machine over injected connection/establisher/clock doubles, so the
 * reconnect path is still exercised offline. See the predecessor codebase for the full rationale.
 */
export class BoxRecoveryPersistenceGate {
  private verified = false;
  private establishedOnce = false;
  private inFlight: Promise<void> | null = null;
  private nextAttemptAtMs = 0;

  constructor(private readonly deps: {
    isConnected: () => boolean;
    establish: () => Promise<void>;
    now?: () => number;
    reverifyBackoffMs?: number;
  }) {}

  isReady(): boolean {
    if (!this.deps.isConnected()) {
      this.verified = false;
      return false;
    }
    if (!this.verified) this.requestReverification();
    return this.verified;
  }

  async establishNow(): Promise<void> {
    await this.verifyOnce();
  }

  pendingVerification(): Promise<void> {
    return (this.inFlight ?? Promise.resolve()).catch(() => undefined);
  }

  private verifyOnce(): Promise<void> {
    this.verified = false;
    let started: Promise<void>;
    try {
      started = this.deps.establish();
    } catch (error) {
      started = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const attempt = started.then(() => {
      this.verified = true;
      this.establishedOnce = true;
    });
    const tracked: Promise<void> = attempt.finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private requestReverification(): void {
    if (!this.establishedOnce || this.inFlight) return;
    const now = this.deps.now?.() ?? Date.now();
    if (now < this.nextAttemptAtMs) return;
    this.nextAttemptAtMs = now + (this.deps.reverifyBackoffMs ?? BOX_RECOVERY_REVERIFY_BACKOFF_MS);
    void this.verifyOnce().catch((error) => {
      console.warn(
        "[Box] crash-recovery persistence could not be re-verified after a Box connection change; " +
          `crash-only recovery stays quarantined: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

const boxRecoveryPersistenceGate = new BoxRecoveryPersistenceGate({
  isConnected: () => isPgReady(),
  establish: () => establishBoxExecutionAttemptPersistence(),
});

/** Ready only while connected and explicitly verified since the last observed disconnect. */
export function isBoxRecoveryPersistenceReady(): boolean {
  return boxRecoveryPersistenceGate.isReady();
}

/**
 * Establish and verify the single-unresolved crash-recovery boundary before any worker
 * can adopt or create one. Existing duplicates are quarantined for operator repair.
 */
export async function initialiseBoxExecutionAttemptPersistence(): Promise<void> {
  await boxRecoveryPersistenceGate.establishNow();
}

/**
 * The PostgreSQL round trip. The partial unique index that guarantees a single
 * unresolved crash-recovery attempt is created by migration 002; here we PROVE it
 * exists with the right definition and that no duplicate unresolved rows sneaked in
 * before it did. Readiness bookkeeping belongs to the gate above.
 */
async function establishBoxExecutionAttemptPersistence(): Promise<void> {
  if (!isPgReady()) throw new Error("PostgreSQL is not ready");

  const unresolved = await query<{ id: string }>(
    `SELECT id FROM box_execution_attempts WHERE candidate_key = $1 AND resolved = false`,
    [BOX_RECOVERY_KEY],
  );
  const unresolvedIds = unresolved.rows.map((row) => String(row.id));
  if (unresolvedIds.length > 1) {
    throw new Error(
      `cannot initialise Box crash recovery: duplicate unresolved rows require quarantine/repair (${unresolvedIds.join(", ")})`,
    );
  }

  const indexes = await describeRecoveryIndex();
  const validationError = boxRecoveryPersistenceValidationError(indexes, unresolvedIds);
  if (validationError) throw new Error(`Box crash-recovery persistence is unsafe: ${validationError}`);
}

/**
 * Read the crash-recovery partial unique index back from the catalog and present it in
 * the same descriptor shape `boxRecoveryPersistenceValidationError` expects, so the
 * pure validator is reused unchanged against a real SQL index.
 *
 * SCOPED TO **OUR** TABLE, DELIBERATELY. `pg_index`/`pg_class` are database-wide catalogs, so
 * matching on `relname` alone would match a table of the same name in ANY schema. Two things go
 * wrong when it does:
 *
 *   1. CORRECTNESS. The validator picks its descriptor by index NAME
 *      (`boxRecoveryPersistenceValidationError` → `indexes.find`). A same-named index on a
 *      same-named table in another schema can therefore be validated INSTEAD of ours, so the
 *      crash-recovery uniqueness boundary would be judged against a relation we do not write to.
 *      For a guard whose whole purpose is to prove "exactly one unresolved recovery row can
 *      exist", reading someone else's index is the one thing it must never do.
 *   2. ROBUSTNESS. `pg_get_indexdef(oid)` resolves the relation at call time, so a row for a
 *      schema being dropped concurrently raises `could not open relation with OID` (XX000) and
 *      takes down an unrelated startup check with it.
 *
 * `to_regclass` resolves the bare name through the CURRENT `search_path` and yields exactly one
 * relation — the one this connection actually reads and writes — or NULL when it is absent, which
 * degrades to zero rows and the honest `missing … index` verdict. That is both the correct scope
 * and the fix for the concurrent-drop race.
 */
async function describeRecoveryIndex(): Promise<BoxExecutionAttemptIndexDescription[]> {
  const { rows } = await query<{ indexname: string; indisunique: boolean; def: string }>(
    `SELECT i.relname AS indexname, ix.indisunique AS indisunique,
            pg_get_indexdef(ix.indexrelid) AS def
     FROM pg_index ix
     JOIN pg_class i ON i.oid = ix.indexrelid
     WHERE ix.indrelid = to_regclass($1) AND i.relname = $2`,
    ["box_execution_attempts", BOX_RECOVERY_UNIQUE_INDEX],
  );
  return rows.map((row) => {
    const def = row.def ?? "";
    // Present the index in the Mongo-style descriptor the pure validator checks.
    const key = /\(candidate_key\)/.test(def) ? { candidate_key: 1 } : {};
    const partial =
      /candidate_key = 'boot-recovery'/.test(def) && /resolved = false/.test(def)
        ? { candidate_key: BOX_RECOVERY_KEY, resolved: false }
        : {};
    return { name: row.indexname, unique: row.indisunique === true, key, partialFilterExpression: partial };
  });
}

/* ------------------------------- primitives ------------------------------- */

/** True when box persistence is available — PostgreSQL is configured and ready. */
export function isBoxDbEnabled(): boolean {
  return isPgReady();
}

/** Duplicate-key detection preserved for callers that branch on it. */
export function isDuplicateKeyError(err: unknown): boolean {
  return isUniqueViolation(err);
}

/**
 * A box id is an opaque 24-hex string. Accepts both legacy Mongo ObjectId strings
 * (24 lowercase hex) and whatever `allocateBoxTradeId` mints (also 24-hex), so legacy
 * data imports unchanged. Nothing downstream may parse it beyond this test.
 */
export function isValidBoxId(id: string): boolean {
  return typeof id === "string" && /^[0-9a-f]{24}$/.test(id);
}

/** Allocate the final durable identity before any live order intent is submitted. */
export function allocateBoxTradeId(): string {
  return randomBytes(12).toString("hex");
}

/* ------------------------------ serialization -----------------------------
 * The wire format lives in serialize.ts (pure, unit-tested); re-exported here so
 * callers have one import for "everything about stored box trades".
 */
export {
  serializeBoxTrade,
  toEventLegs,
  tradeKey,
  type SerializedBoxTrade,
} from "./serialize.js";

/**
 * Verify the pool is up and migrations are applied. Called by engine boot in place of
 * the predecessor codebase's `initBoxConnection`. It does NOT open the pool (boot owns that) — it
 * proves the operational authority is usable before any position is read or written.
 */
export async function ensureBoxPersistenceReady(): Promise<void> {
  if (!isPgReady()) {
    throw new Error("[Box] PostgreSQL is not ready; the operational authority is not optional.");
  }
  // A cheap probe that also fails loudly if migration 002 has not run.
  await query("SELECT 1 FROM box_trades LIMIT 1");
}

/* =========================================================================
 * MAPPERS — row <-> record. Scalar columns are normalised; nested/audit shapes
 * ride in JSONB. `pg` already parses numeric/int8 to numbers and timestamptz to
 * Date, so money and timestamps round-trip as the Box code expects.
 * ========================================================================= */

/** Resolve a broker value with the legacy default, exactly like `brokerOf`. */
function brokerValue(broker: BrokerId | null | undefined): BrokerId {
  return broker === "zerodha" || broker === "dhan" ? broker : LEGACY_BROKER;
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** All box_trades columns in one place, so INSERT and the mapper cannot drift. */
const BOX_TRADE_COLUMNS = [
  "id", "broker", "execution_mode", "underlying", "name", "is_index", "expiry", "direction",
  "lower_strike", "upper_strike", "lot_size", "quantity", "status", "box_width", "margin",
  "entry_box_cost", "entry_gross_edge", "safety_buffer", "entry_net_edge", "expected_net_profit",
  "entry_execution_cost", "charge_origin", "charge_rate_version", "position_state",
  "cumulative_exit_charges", "opened_at", "current_remaining_edge", "current_captured_edge",
  "current_captured_pct", "exit_box_value", "gross_pnl", "total_charges", "net_pnl",
  "realised_net_pnl", "closed_at", "close_idempotency_key", "exit_reason", "exit_blocked_reason",
  "expiry_safety", "error", "legs", "entry_charges", "estimated_exit_charges", "exit_charges",
  "entry_charge_reconciliation", "exit_charge_reconciliation", "entry_execution", "entry_legging",
  "exit_execution", "exit_legging", "residual_exposure", "remaining_qty_by_role", "exit_attempts",
  "scanner_config_snapshot",
] as const;

function tradeInsertValues(id: string, t: IBoxTrade): unknown[] {
  return [
    id,
    brokerValue(t.broker),
    t.execution_mode ?? "paper_touch",
    t.underlying,
    t.name ?? "",
    t.is_index ?? false,
    t.expiry,
    t.direction ?? "LONG_BOX",
    t.lower_strike,
    t.upper_strike,
    t.lot_size,
    t.quantity,
    t.status ?? "open",
    t.box_width,
    t.margin ?? null,
    t.entry_box_cost,
    t.entry_gross_edge,
    t.safety_buffer ?? 0,
    t.entry_net_edge,
    t.expected_net_profit ?? null,
    t.entry_execution_cost ?? null,
    t.charge_origin ?? "local",
    t.charge_rate_version ?? null,
    t.position_state ?? null,
    t.cumulative_exit_charges ?? null,
    asDate(t.opened_at) ?? new Date(),
    t.current_remaining_edge ?? null,
    t.current_captured_edge ?? null,
    t.current_captured_pct ?? null,
    t.exit_box_value ?? null,
    t.gross_pnl ?? null,
    t.total_charges ?? null,
    t.net_pnl ?? null,
    t.realised_net_pnl ?? null,
    asDate(t.closed_at),
    t.close_idempotency_key ?? null,
    t.exit_reason ?? null,
    t.exit_blocked_reason ?? null,
    t.expiry_safety ?? false,
    t.error ?? null,
    jsonb(t.legs ?? []),
    jsonb(t.entry_charges ?? null),
    jsonb(t.estimated_exit_charges ?? null),
    jsonb(t.exit_charges ?? null),
    jsonb(t.entry_charge_reconciliation ?? null),
    jsonb(t.exit_charge_reconciliation ?? null),
    jsonb(t.entry_execution ?? null),
    jsonb(t.entry_legging ?? null),
    jsonb(t.exit_execution ?? null),
    jsonb(t.exit_legging ?? null),
    jsonb(t.residual_exposure ?? null),
    jsonb(t.remaining_qty_by_role ?? null),
    jsonb(t.exit_attempts ?? null),
    jsonb(t.scanner_config_snapshot ?? {}),
  ];
}

/** JSON.stringify with `undefined` collapsing to SQL NULL for jsonb params. */
function jsonb(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function rowToTrade(row: Record<string, unknown>): BoxTradeRecord {
  const record: Record<string, unknown> = {
    _id: String(row.id),
    broker: brokerValue(row.broker as BrokerId),
    execution_mode: row.execution_mode,
    underlying: row.underlying,
    name: row.name,
    is_index: row.is_index,
    expiry: row.expiry,
    direction: row.direction,
    lower_strike: num(row.lower_strike),
    upper_strike: num(row.upper_strike),
    lot_size: num(row.lot_size),
    quantity: num(row.quantity),
    status: row.status,
    box_width: num(row.box_width),
    margin: numOrNull(row.margin),
    margin_source: (row.margin_source as BoxTradeRecord["margin_source"]) ?? null,
    entry_box_cost: num(row.entry_box_cost),
    entry_gross_edge: num(row.entry_gross_edge),
    safety_buffer: num(row.safety_buffer),
    entry_net_edge: num(row.entry_net_edge),
    expected_net_profit: numOrNull(row.expected_net_profit),
    entry_execution_cost: numOrNull(row.entry_execution_cost),
    charge_origin: row.charge_origin,
    charge_rate_version: row.charge_rate_version ?? null,
    position_state: (row.position_state as BoxPositionState | null) ?? null,
    cumulative_exit_charges: numOrNull(row.cumulative_exit_charges),
    opened_at: asDate(row.opened_at),
    current_remaining_edge: numOrNull(row.current_remaining_edge),
    current_captured_edge: numOrNull(row.current_captured_edge),
    current_captured_pct: numOrNull(row.current_captured_pct),
    exit_box_value: numOrNull(row.exit_box_value),
    gross_pnl: numOrNull(row.gross_pnl),
    total_charges: numOrNull(row.total_charges),
    net_pnl: numOrNull(row.net_pnl),
    realised_net_pnl: numOrNull(row.realised_net_pnl),
    closed_at: asDate(row.closed_at),
    close_idempotency_key: row.close_idempotency_key ?? null,
    exit_reason: row.exit_reason ?? null,
    exit_blocked_reason: row.exit_blocked_reason ?? null,
    expiry_safety: row.expiry_safety ?? false,
    error: row.error ?? null,
    legs: reviveDates((row.legs as unknown[]) ?? []),
    entry_charges: reviveDates(row.entry_charges),
    estimated_exit_charges: reviveDates(row.estimated_exit_charges),
    exit_charges: reviveDates(row.exit_charges),
    entry_charge_reconciliation: reviveDates(row.entry_charge_reconciliation),
    exit_charge_reconciliation: reviveDates(row.exit_charge_reconciliation),
    entry_execution: row.entry_execution ?? null,
    entry_legging: row.entry_legging ?? null,
    exit_execution: row.exit_execution ?? null,
    exit_legging: row.exit_legging ?? null,
    residual_exposure: row.residual_exposure ?? null,
    remaining_qty_by_role: row.remaining_qty_by_role ?? null,
    exit_attempts: row.exit_attempts ?? null,
    scanner_config_snapshot: row.scanner_config_snapshot ?? {},
  };
  return record as unknown as BoxTradeRecord;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

/**
 * Revive ISO-8601 strings that JSONB stored from `Date` values back into `Date`s, so a
 * leg's `entry_quote_at` reads as a `Date` exactly as it did through Mongoose. Applied
 * only to fields the Box code declares as `Date`.
 */
const DATE_KEYS = new Set([
  "entry_quote_at", "exit_quote_at", "at", "quote_at",
]);
function reviveDates<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => reviveDates(v)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DATE_KEYS.has(k) && typeof v === "string") {
        const d = new Date(v);
        out[k] = Number.isNaN(d.getTime()) ? v : d;
      } else {
        out[k] = reviveDates(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

const TRADE_STAR = "*";

/**
 * Enqueue a box_trade projection on the transaction's client. `eventId` is derived
 * from durable facts (trade id + a caller-supplied discriminator) so a retry upserts.
 */
async function enqueueTradeProjection(
  client: PoolClient,
  trade: BoxTradeRecord,
  eventType: string,
): Promise<void> {
  await enqueueOutbox(client, {
    eventId: `box_trade:${trade._id}:${eventType}`,
    aggregateType: "box_trade",
    aggregateId: trade._id,
    eventType,
    schemaVersion: BOX_PROJECTION_SCHEMA_VERSION,
    payload: tradeProjectionPayload(trade),
  });
}

/**
 * The projected box_trade payload. Carries the required provenance: broker, charge
 * origin, charge rate version, execution mode, the PostgreSQL source id and the
 * projection schema version. Secrets are structurally impossible here (a trade never
 * holds a token) and the outbox writer throws if one ever appears.
 */
function tradeProjectionPayload(trade: BoxTradeRecord): Record<string, unknown> {
  return {
    ...trade,
    source_id: trade._id,
    broker: brokerValue(trade.broker),
    charge_origin: trade.charge_origin ?? "local",
    charge_rate_version: trade.charge_rate_version ?? null,
    /**
     * The REAL provenance, from the persisted column.
     *
     * This used to be derived as `margin === null ? "unknown" : "broker"`, which told a
     * reader only whether a number existed — not whether it was a netted basket figure or
     * a summed per-leg upper bound. Those differ by roughly an order of magnitude on a
     * hedged Box, so the derived value made the projected history unanalysable. `null` is
     * preserved as `null` (predates provenance capture) rather than being flattened into
     * `"unavailable"`, which means something different.
     */
    margin_source: trade.margin_source ?? null,
    execution_mode: trade.execution_mode,
    projection_schema_version: BOX_PROJECTION_SCHEMA_VERSION,
  };
}

/* -------------------------------- queries -------------------------------- */

export async function loadOpenBoxTrades(): Promise<BoxTradeRecord[]> {
  if (!isBoxDbEnabled()) return [];
  const { rows } = await query(
    `SELECT ${TRADE_STAR} FROM box_trades WHERE status = 'open' ORDER BY opened_at DESC`,
  );
  return rows.map(rowToTrade);
}

export async function loadBoxTrades(limit = 300): Promise<BoxTradeRecord[]> {
  if (!isBoxDbEnabled()) return [];
  const { rows } = await query(
    `SELECT ${TRADE_STAR} FROM box_trades ORDER BY opened_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(rowToTrade);
}

const CLOSED_STATUSES = ["closed", "error"] as const;

/**
 * The audit-blob columns excluded from LIST queries. In Mongo these were projected
 * out to keep the history response small; in PostgreSQL they are separate JSONB
 * columns, so a list SELECT simply names the scalar/small columns and passes NULL for
 * the fat ones. `rowToTrade` fills them as null, matching the Mongo projection.
 */
const LIST_COLUMNS = BOX_TRADE_COLUMNS.filter(
  (c) => !["entry_execution", "entry_legging", "exit_execution", "exit_legging", "exit_attempts"].includes(c),
).join(", ");

export async function loadClosedBoxTrades(
  limit = 300,
  sinceMs?: number,
): Promise<BoxTradeRecord[]> {
  if (!isBoxDbEnabled()) return [];
  const params: unknown[] = [CLOSED_STATUSES];
  let where = `status = ANY($1)`;
  if (sinceMs !== undefined) {
    params.push(new Date(sinceMs));
    where += ` AND closed_at >= $${params.length}`;
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT ${LIST_COLUMNS} FROM box_trades WHERE ${where}
     ORDER BY closed_at DESC NULLS LAST, opened_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(rowToTrade);
}

export async function findBoxTradeById(id: string): Promise<BoxTradeRecord | null> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return null;
  const { rows } = await query(`SELECT ${TRADE_STAR} FROM box_trades WHERE id = $1`, [id]);
  return rows[0] ? rowToTrade(rows[0]) : null;
}

export async function filterExistingBoxTradeIds(ids: string[]): Promise<string[]> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  const validIds = [...new Set(ids.filter(isValidBoxId))];
  if (validIds.length === 0) return [];
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM box_trades WHERE id = ANY($1::text[])`,
    [validIds],
  );
  return rows.map((r) => String(r.id));
}

/* ------------------------------- mutations ------------------------------- */

/**
 * Insert a new open box. Returns null when the partial unique index rejects the
 * insert — the duplicate case (another tick already opened this pair/direction for
 * this broker). Enqueues a `trade_opened` projection in the same transaction.
 */
export async function insertBoxTrade(
  payload: IBoxTrade,
  preallocatedId?: string,
): Promise<BoxTradeRecord | null> {
  if (!isBoxDbEnabled()) return null;
  const id = preallocatedId && isValidBoxId(preallocatedId) ? preallocatedId : allocateBoxTradeId();
  const cols = BOX_TRADE_COLUMNS.join(", ");
  const placeholders = BOX_TRADE_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  try {
    return await withTx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO box_trades (${cols}) VALUES (${placeholders}) RETURNING ${TRADE_STAR}`,
        tradeInsertValues(id, payload),
      );
      const trade = rowToTrade(rows[0]);
      await enqueueTradeProjection(client, trade, "trade_opened");
      return trade;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      if (preallocatedId && isValidBoxId(preallocatedId)) {
        const existing = await findBoxTradeById(preallocatedId);
        if (existing) return existing;
      }
      return null;
    }
    throw err;
  }
}

/** Patch the basket margin onto a trade once fetched off the hot path. */
/**
 * Store a trade's margin AND the model that produced it.
 *
 * `source` is optional so the frozen the predecessor codebase call signature still compiles, but callers
 * should always pass it: without provenance an inflated `dhan_per_leg_fallback` sum is
 * indistinguishable from a real netted basket figure once written, which is precisely the
 * confusion this column exists to prevent.
 */
export async function setBoxTradeMargin(
  id: string,
  margin: number,
  source?: BoxMarginSource,
): Promise<void> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return;
  try {
    await withTx(async (client) => {
      const { rows } = await client.query(
        // COALESCE so an omitted source never ERASES provenance a previous write recorded.
        `UPDATE box_trades SET margin = $2, margin_source = COALESCE($3, margin_source)
           WHERE id = $1 RETURNING ${TRADE_STAR}`,
        [id, margin, source ?? null],
      );
      if (rows[0]) await enqueueTradeProjection(client, rowToTrade(rows[0]), "trade_margin");
    });
  } catch (err) {
    console.warn("[Box] margin update failed for", id, err);
  }
}

/** Persist the live convergence figure for an open trade (periodic, not hot). */
export async function updateBoxTradeLive(
  id: string,
  fields: {
    current_remaining_edge: number | null;
    current_captured_edge?: number | null;
    current_captured_pct?: number | null;
    exit_blocked_reason?: string | null;
    expiry_safety?: boolean;
  },
): Promise<void> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return;
  const sets: string[] = [];
  const values: unknown[] = [id];
  const put = (col: string, v: unknown) => { values.push(v); sets.push(`${col} = $${values.length}`); };
  put("current_remaining_edge", fields.current_remaining_edge);
  if (fields.current_captured_edge !== undefined) put("current_captured_edge", fields.current_captured_edge);
  if (fields.current_captured_pct !== undefined) put("current_captured_pct", fields.current_captured_pct);
  if (fields.exit_blocked_reason !== undefined) put("exit_blocked_reason", fields.exit_blocked_reason);
  if (fields.expiry_safety !== undefined) put("expiry_safety", fields.expiry_safety);
  try {
    await query(`UPDATE box_trades SET ${sets.join(", ")} WHERE id = $1`, values);
  } catch (err) {
    console.warn("[Box] live update failed for", id, err);
  }
}

/**
 * Store the verdict of an asynchronous charge reconciliation. When Zerodha agreed,
 * the charge record's `computed_by` is promoted to "local_verified"; the totals
 * themselves are never rewritten.
 */
export async function setBoxChargeReconciliation(
  id: string,
  phase: "entry" | "exit",
  verdict: BoxChargeReconciliation,
): Promise<void> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return;
  const reconCol = `${phase}_charge_reconciliation`;
  const chargeCol = phase === "entry" ? "entry_charges" : "exit_charges";
  try {
    await withTx(async (client) => {
      const sets = [`${reconCol} = $2::jsonb`];
      const values: unknown[] = [id, jsonb(verdict)];
      if (verdict.status === "verified") {
        // Promote computed_by inside the JSONB charge doc without rewriting totals.
        sets.push(`${chargeCol} = jsonb_set(COALESCE(${chargeCol}, '{}'::jsonb), '{computed_by}', '"local_verified"'::jsonb, true)`);
        if (phase === "entry") sets.push(`charge_origin = 'local_verified'`);
      }
      const { rows } = await client.query(
        `UPDATE box_trades SET ${sets.join(", ")} WHERE id = $1 RETURNING ${TRADE_STAR}`,
        values,
      );
      if (rows[0]) await enqueueTradeProjection(client, rowToTrade(rows[0]), `charge_recon_${phase}`);
    });
  } catch (err) {
    console.warn("[Box] reconciliation update failed for", id, err);
  }
}

/**
 * Close a box trade, but ONLY if it is still open. The `status = 'open'` guard makes
 * the close atomic: a manual close racing the monitor cannot double-close.
 */
export async function closeBoxTrade(
  id: string,
  fields: Partial<IBoxTrade>,
  idempotencyKey?: string,
): Promise<BoxTradeRecord | null> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return null;
  const { sets, values } = buildTradePatch(fields);
  if (sets.length === 0) sets.push(`id = id`); // no-op guard, still runs the WHERE
  return withTx(async (client) => {
    const { rows } = await client.query(
      `UPDATE box_trades SET ${sets.join(", ")} WHERE id = $1 AND status = 'open' RETURNING ${TRADE_STAR}`,
      [id, ...values],
    );
    if (rows[0]) {
      const trade = rowToTrade(rows[0]);
      await enqueueTradeProjection(client, trade, "trade_closed");
      return trade;
    }
    if (!idempotencyKey) return null;
    const existing = await client.query(
      `SELECT ${TRADE_STAR} FROM box_trades
       WHERE id = $1 AND status = 'closed' AND close_idempotency_key = $2`,
      [id, idempotencyKey],
    );
    return existing.rows[0] ? rowToTrade(existing.rows[0]) : null;
  });
}

/**
 * Build a partial UPDATE fragment for arbitrary IBoxTrade fields. Scalar fields set
 * their column; nested fields set their JSONB column. Parameters start at $2 because
 * $1 is always the id.
 */
/**
 * A dotted per-leg patch key, e.g. `legs.0.exit_price`.
 *
 * The engine's close path writes individual leg fields this way (a Mongo-era shape kept because it
 * expresses "touch only this leg's exit evidence" precisely). The index is captured as digits only and
 * the field must appear in {@link PATCHABLE_LEG_FIELDS}, which is what makes it safe to build a
 * `jsonb_set` path literal from them.
 */
const LEG_PATCH_KEY = /^legs\.(\d+)\.([a-z][a-z0-9_]*)$/;

/**
 * Leg fields a dotted patch may write. WHITELIST, not a filter — an unlisted field is a bug in the
 * caller, and silently writing it into the document would let a typo create a phantom leg property
 * that no reader ever checks.
 */
const PATCHABLE_LEG_FIELDS: ReadonlySet<string> = new Set([
  "exit_price", "exit_bid", "exit_bid_qty", "exit_ask", "exit_ask_qty",
  "exit_quote_at", "exit_depth", "exit_detected_price", "exit_slippage",
]);

/**
 * A value for `jsonb_set`, where SQL NULL is NOT an option.
 *
 * `jsonb_set(doc, path, NULL)` returns NULL for the WHOLE DOCUMENT — it would erase all four legs
 * rather than clear one field. An absent observation must therefore be the JSON literal `null`.
 */
function jsonbSetValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return JSON.stringify(value instanceof Date ? value.toISOString() : value);
}

/**
 * Build a partial UPDATE fragment for arbitrary IBoxTrade fields.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS FIXES — a fully executed exit could not be persisted, deterministically.
 *
 * The engine's close payload contains dotted per-leg keys (`legs.0.exit_price`, …). This function
 * used to interpolate EVERY key straight into the SET list:
 *
 * ```ts
 * sets.push(`${key} = $${values.length + 1}`);      // → "legs.0.exit_price = $2"
 * ```
 *
 * PostgreSQL rejects that with `syntax error at or near ".0"`. So a live box whose four entry legs and
 * four exit legs had all executed at the broker could not be marked closed: the durable trade stayed
 * `open`, the in-memory position went to RECOVERY, and the retry re-issued the identical invalid SQL
 * forever. The operator is then flat at the broker while the backend insists it is not — which is the
 * worst possible disagreement to carry into a restart, because recovery reconciles an open projection
 * against exposure that no longer exists.
 *
 * Dotted keys are now folded into ONE `jsonb_set` chain on the `legs` column. The path literal is
 * assembled from a digits-only index and a whitelisted field name, so it carries no caller-controlled
 * text; the value always travels as a bound parameter.
 */
function buildTradePatch(fields: Partial<IBoxTrade>): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  const JSON_FIELDS = new Set([
    "legs", "entry_charges", "estimated_exit_charges", "exit_charges",
    "entry_charge_reconciliation", "exit_charge_reconciliation", "entry_execution",
    "entry_legging", "exit_execution", "exit_legging", "residual_exposure",
    "remaining_qty_by_role", "exit_attempts", "scanner_config_snapshot",
  ]);
  const DATE_FIELDS = new Set(["opened_at", "closed_at"]);
  const legPatches: Array<{ index: string; field: string; value: unknown }> = [];

  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    if (key === "_id") continue;

    const legMatch = LEG_PATCH_KEY.exec(key);
    if (legMatch) {
      const [, index, field] = legMatch;
      if (!PATCHABLE_LEG_FIELDS.has(field!)) {
        throw new Error(
          `Refusing to patch box trade leg field "${field}" (from "${key}"): not in the patchable set. ` +
          `Add it to PATCHABLE_LEG_FIELDS deliberately, or correct the caller.`,
        );
      }
      legPatches.push({ index: index!, field: field!, value: raw });
      continue;
    }
    if (key.includes(".")) {
      // Any other dotted path would have produced invalid SQL. Fail loudly at the boundary rather
      // than at the database, where it reads as a mysterious syntax error mid-close.
      throw new Error(`Unsupported dotted patch key "${key}" for box_trades.`);
    }

    let value: unknown = raw;
    if (key === "broker") value = brokerValue(raw as BrokerId);
    if (DATE_FIELDS.has(key)) value = asDate(raw as never);
    if (JSON_FIELDS.has(key)) {
      values.push(jsonb(raw));
      sets.push(`${key} = $${values.length + 1}::jsonb`);
    } else {
      values.push(value);
      sets.push(`${key} = $${values.length + 1}`);
    }
  }

  if (legPatches.length > 0) {
    // A whole-array `legs` replacement in the same patch becomes the BASE the per-leg writes apply
    // on top of. Emitting both as separate assignments would be "multiple assignments to same
    // column", and picking one arbitrarily would silently discard the other.
    const existing = sets.findIndex((s) => s.startsWith("legs = "));
    let expr = "legs";
    if (existing >= 0) {
      expr = sets[existing]!.slice("legs = ".length);
      sets.splice(existing, 1);
    }
    for (const patch of legPatches) {
      values.push(jsonbSetValue(patch.value));
      // Path text is digits + a whitelisted identifier; the VALUE is always a bound parameter.
      expr = `jsonb_set(${expr}, '{${patch.index},${patch.field}}', $${values.length + 1}::jsonb, true)`;
    }
    sets.push(`legs = ${expr}`);
  }

  return { sets, values };
}

/**
 * Durably record a PARTIAL exit in ONE atomic update, guarded on `status = 'open'`.
 * The trade stays OPEN. Returns whether a row matched.
 */
export async function applyBoxPartialExit(
  id: string,
  patch: {
    remaining_qty_by_role: Record<string, number>;
    position_state: BoxPositionState;
    cumulative_exit_charges: number;
    exit_attempts: unknown[];
    residual_exposure: unknown[] | null;
    exit_legging: unknown | null;
    current_remaining_edge?: number | null;
  },
): Promise<boolean> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return false;
  return withTx(async (client) => {
    const sets = [
      `remaining_qty_by_role = $2::jsonb`,
      `position_state = $3`,
      `cumulative_exit_charges = $4`,
      `exit_attempts = $5::jsonb`,
      `residual_exposure = $6::jsonb`,
      `exit_legging = $7::jsonb`,
    ];
    const values: unknown[] = [
      id,
      jsonb(patch.remaining_qty_by_role),
      patch.position_state,
      patch.cumulative_exit_charges,
      jsonb(patch.exit_attempts),
      jsonb(patch.residual_exposure),
      jsonb(patch.exit_legging),
    ];
    if (patch.current_remaining_edge !== undefined) {
      values.push(patch.current_remaining_edge);
      sets.push(`current_remaining_edge = $${values.length}`);
    }
    const { rows } = await client.query(
      `UPDATE box_trades SET ${sets.join(", ")} WHERE id = $1 AND status = 'open' RETURNING ${TRADE_STAR}`,
      values,
    );
    if (rows[0]) {
      await enqueueTradeProjection(client, rowToTrade(rows[0]), "trade_partial_exit");
      return true;
    }
    return false;
  });
}

/**
 * PERMANENTLY delete a box trade — paper trades only. The `execution_mode <> 'live'`
 * guard is the whole protection and is enforced IN THE QUERY. Returns rows removed.
 */
export async function deleteBoxTrade(id: string): Promise<number> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return 0;
  const { rowCount } = await query(
    `DELETE FROM box_trades WHERE id = $1 AND execution_mode <> 'live'`,
    [id],
  );
  return rowCount ?? 0;
}

export async function applyBoxReconciledProjection(
  id: string,
  remaining: Record<string, number>,
  state: BoxPositionState,
): Promise<boolean> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return false;
  const { rowCount } = await query(
    `UPDATE box_trades SET remaining_qty_by_role = $2::jsonb, position_state = $3
     WHERE id = $1 AND status = 'open'`,
    [id, jsonb(remaining), state],
  );
  return (rowCount ?? 0) > 0;
}

export async function markBoxTradeRecovery(id: string, message: string): Promise<void> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return;
  await query(
    `UPDATE box_trades SET position_state = 'RECOVERY', error = $2, exit_blocked_reason = $2
     WHERE id = $1 AND status = 'open'`,
    [id, message],
  );
}

export async function markBoxTradeError(id: string, message: string): Promise<void> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return;
  try {
    await query(`UPDATE box_trades SET error = $2 WHERE id = $1`, [id, message]);
  } catch {
    /* best-effort */
  }
}

/**
 * Every trade closed on a given IST day, for a full statistics rebuild.
 */
export async function loadBoxTradesClosedBetween(
  fromMs: number,
  toMs: number,
): Promise<BoxTradeRecord[]> {
  if (!isBoxDbEnabled()) return [];
  const { rows } = await query(
    `SELECT ${LIST_COLUMNS} FROM box_trades
     WHERE status = ANY($1) AND closed_at >= $2 AND closed_at < $3
     ORDER BY closed_at DESC NULLS LAST, opened_at DESC`,
    [CLOSED_STATUSES, new Date(fromMs), new Date(toMs)],
  );
  return rows.map(rowToTrade);
}

/** Open/closed trade intervals for a peak-concurrent-margin REPLAY. */
export async function loadBoxMarginIntervalsSince(sinceMs: number): Promise<
  { id: string; opened_at: Date; closed_at: Date | null; margin: number | null }[]
> {
  if (!isBoxDbEnabled()) return [];
  const { rows } = await query<{ id: string; opened_at: Date; closed_at: Date | null; margin: unknown }>(
    `SELECT id, opened_at, closed_at, margin FROM box_trades
     WHERE status = 'open' OR closed_at >= $1`,
    [new Date(sinceMs)],
  );
  return rows.map((r) => ({
    id: String(r.id),
    opened_at: r.opened_at,
    closed_at: r.closed_at ?? null,
    margin: numOrNull(r.margin),
  }));
}

export async function loadBoxTradesClosedSince(sinceMs: number): Promise<BoxTradeRecord[]> {
  if (!isBoxDbEnabled()) return [];
  const { rows } = await query(
    `SELECT ${LIST_COLUMNS} FROM box_trades
     WHERE status = ANY($1) AND closed_at >= $2
     ORDER BY closed_at DESC NULLS LAST`,
    [CLOSED_STATUSES, new Date(sinceMs)],
  );
  return rows.map(rowToTrade);
}

/** Which of the given trade ids are durably FLAT (fully closed). */
export async function loadFlatBoxTradeIds(tradeIds: readonly string[]): Promise<string[]> {
  if (!isBoxDbEnabled() || tradeIds.length === 0) return [];
  const ids = [...new Set(tradeIds.filter(isValidBoxId))];
  if (ids.length === 0) return [];
  try {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM box_trades WHERE id = ANY($1::text[]) AND status = 'closed'`,
      [ids],
    );
    return rows.map((r) => String(r.id));
  } catch (err) {
    console.warn("[Box] failed to read flat trade ids for session reconciliation:", err);
    return [];
  }
}

/* ------------------------------- event ledger ----------------------------- */

export interface BoxEventInput {
  event: BoxEventType;
  candidate_key: string;
  underlying: string;
  expiry: string;
  direction?: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  trade_id?: string | null;
  box_width?: number | null;
  box_cost?: number | null;
  gross_edge?: number | null;
  entry_charges_total?: number | null;
  exit_charges_total?: number | null;
  safety_buffer?: number | null;
  net_edge?: number | null;
  expected_net_profit?: number | null;
  execution_cost?: number | null;
  gross_pnl?: number | null;
  net_pnl?: number | null;
  remaining_edge?: number | null;
  captured_edge?: number | null;
  captured_pct?: number | null;
  execution?: BoxExecutionRecord | null;
  execution_mode?: ExecutionMode;
  broker?: BrokerId;
  legs?: BoxEventLeg[];
  reason?: string | null;
  detail?: string | null;
}

/**
 * Append one immutable decision snapshot to the box ledger. Best-effort by design:
 * a write failure is logged and swallowed. Enqueues a box_trade_event projection in
 * the same transaction, keyed by the durable row id so a retry upserts.
 */
export async function appendBoxEvent(input: BoxEventInput): Promise<void> {
  if (!isBoxEventLedgerEnabled()) return;
  const at = new Date();
  try {
    await withTx(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO box_trade_events (
           event, at, trade_id, candidate_key, underlying, expiry, direction, lower_strike,
           upper_strike, lot_size, quantity, execution_mode, broker, box_width, box_cost,
           gross_edge, entry_charges_total, exit_charges_total, safety_buffer, net_edge,
           expected_net_profit, execution_cost, gross_pnl, net_pnl, remaining_edge, captured_edge,
           captured_pct, execution, legs, reason, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                 $23,$24,$25,$26,$27,$28::jsonb,$29::jsonb,$30,$31)
         RETURNING id`,
        [
          input.event, at, input.trade_id ?? null, input.candidate_key, input.underlying,
          input.expiry, input.direction ?? "LONG_BOX", input.lower_strike, input.upper_strike,
          input.lot_size, input.quantity, input.execution_mode ?? "paper_touch",
          brokerValue(input.broker), input.box_width ?? null, input.box_cost ?? null,
          input.gross_edge ?? null, input.entry_charges_total ?? null, input.exit_charges_total ?? null,
          input.safety_buffer ?? null, input.net_edge ?? null, input.expected_net_profit ?? null,
          input.execution_cost ?? null, input.gross_pnl ?? null, input.net_pnl ?? null,
          input.remaining_edge ?? null, input.captured_edge ?? null, input.captured_pct ?? null,
          jsonb(input.execution ?? null), jsonb(input.legs ?? []), input.reason ?? null,
          input.detail ?? null,
        ],
      );
      const id = String(rows[0]!.id);
      await enqueueOutbox(client, {
        eventId: `box_trade_event:${id}`,
        aggregateType: "box_trade_event",
        aggregateId: input.trade_id ?? input.candidate_key ?? id,
        eventType: input.event,
        schemaVersion: BOX_PROJECTION_SCHEMA_VERSION,
        payload: {
          source_id: id,
          event: input.event,
          at: at.toISOString(),
          trade_id: input.trade_id ?? null,
          candidate_key: input.candidate_key,
          underlying: input.underlying,
          expiry: input.expiry,
          direction: input.direction ?? "LONG_BOX",
          lower_strike: input.lower_strike,
          upper_strike: input.upper_strike,
          lot_size: input.lot_size,
          quantity: input.quantity,
          execution_mode: input.execution_mode ?? "paper_touch",
          broker: brokerValue(input.broker),
          box_width: input.box_width ?? null,
          box_cost: input.box_cost ?? null,
          gross_edge: input.gross_edge ?? null,
          entry_charges_total: input.entry_charges_total ?? null,
          exit_charges_total: input.exit_charges_total ?? null,
          safety_buffer: input.safety_buffer ?? null,
          net_edge: input.net_edge ?? null,
          expected_net_profit: input.expected_net_profit ?? null,
          execution_cost: input.execution_cost ?? null,
          gross_pnl: input.gross_pnl ?? null,
          net_pnl: input.net_pnl ?? null,
          remaining_edge: input.remaining_edge ?? null,
          captured_edge: input.captured_edge ?? null,
          captured_pct: input.captured_pct ?? null,
          execution: input.execution ?? null,
          legs: input.legs ?? [],
          reason: input.reason ?? null,
          detail: input.detail ?? null,
          projection_schema_version: BOX_PROJECTION_SCHEMA_VERSION,
        },
      });
    });
  } catch (err) {
    console.warn("[Box] failed to append", input.event, "event:", err);
  }
}

/** Recent ledger rows, newest first (for the audit view). */
export async function loadBoxEvents(limit = 200): Promise<IBoxTradeEvent[]> {
  if (!isBoxEventLedgerEnabled()) return [];
  try {
    const { rows } = await query(
      `SELECT * FROM box_trade_events ORDER BY at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(rowToEvent);
  } catch {
    return [];
  }
}

function rowToEvent(row: Record<string, unknown>): IBoxTradeEvent {
  return {
    event: row.event as BoxEventType,
    at: asDate(row.at) as Date,
    trade_id: (row.trade_id as string | null) ?? null,
    candidate_key: row.candidate_key as string,
    underlying: row.underlying as string,
    expiry: row.expiry as string,
    direction: row.direction as BoxDirection,
    lower_strike: num(row.lower_strike),
    upper_strike: num(row.upper_strike),
    lot_size: num(row.lot_size),
    quantity: num(row.quantity),
    execution_mode: row.execution_mode as ExecutionMode,
    broker: brokerValue(row.broker as BrokerId),
    box_width: numOrNull(row.box_width),
    box_cost: numOrNull(row.box_cost),
    gross_edge: numOrNull(row.gross_edge),
    entry_charges_total: numOrNull(row.entry_charges_total),
    exit_charges_total: numOrNull(row.exit_charges_total),
    safety_buffer: numOrNull(row.safety_buffer),
    net_edge: numOrNull(row.net_edge),
    expected_net_profit: numOrNull(row.expected_net_profit),
    execution_cost: numOrNull(row.execution_cost),
    gross_pnl: numOrNull(row.gross_pnl),
    net_pnl: numOrNull(row.net_pnl),
    remaining_edge: numOrNull(row.remaining_edge),
    captured_edge: numOrNull(row.captured_edge),
    captured_pct: numOrNull(row.captured_pct),
    execution: (row.execution as BoxExecutionRecord | null) ?? null,
    legs: reviveDates((row.legs as BoxEventLeg[]) ?? []),
    reason: (row.reason as string | null) ?? null,
    detail: (row.detail as string | null) ?? null,
  } as IBoxTradeEvent;
}

/* ----------------------------- order intents ------------------------------ */

const NONTERMINAL_ORDER_STATES: readonly BoxOrderIntentState[] = [
  "CREATED", "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED",
  "CANCEL_REQUESTED", "UNKNOWN", "RECONCILIATION_REQUIRED",
];

const INTENT_COLUMNS = [
  "id", "client_order_id", "broker_order_id", "broker_mode", "broker", "broker_correlation_id",
  // The account that placed the order. Nullable: a pre-migration row genuinely does not know, and
  // is never backfilled — see migration 011.
  "broker_account",
  "trade_id", "attempt_id", "role", "purpose", "phase", "exchange", "tradingsymbol", "token",
  "side", "quantity", "reference_price", "tick_size", "max_chase_ticks", "limit_price", "state",
  "filled_quantity", "previous_filled_quantity", "average_price", "broker_tag", "reject_family",
  "reject_reason", "created_at", "updated_at", "terminal_at", "audit",
] as const;

function intentInsertValues(id: string, intent: IBoxOrderIntent): unknown[] {
  return [
    id,
    intent.client_order_id,
    intent.broker_order_id ?? null,
    intent.broker_mode,
    brokerValue(intent.broker),
    intent.broker_correlation_id ?? null,
    intent.broker_account ?? null,
    intent.trade_id ?? null,
    intent.attempt_id,
    intent.role,
    intent.purpose,
    intent.phase,
    intent.exchange,
    intent.tradingsymbol,
    intent.token,
    intent.side,
    intent.quantity,
    intent.reference_price,
    intent.tick_size,
    intent.max_chase_ticks,
    intent.limit_price,
    intent.state ?? "CREATED",
    intent.filled_quantity ?? 0,
    intent.previous_filled_quantity ?? null,
    intent.average_price ?? null,
    intent.broker_tag ?? null,
    intent.reject_family ?? null,
    intent.reject_reason ?? null,
    asDate(intent.created_at) ?? new Date(),
    asDate(intent.updated_at) ?? new Date(),
    asDate(intent.terminal_at),
    jsonb(intent.audit ?? []),
  ];
}

function rowToIntent(row: Record<string, unknown>): BoxOrderIntentRecord {
  return {
    _id: String(row.id),
    client_order_id: row.client_order_id as string,
    broker_order_id: (row.broker_order_id as string | null) ?? null,
    broker_mode: row.broker_mode as "paper" | "live",
    broker: brokerValue(row.broker as BrokerId),
    broker_correlation_id: (row.broker_correlation_id as string | null) ?? null,
    broker_account: (row.broker_account as string | null) ?? null,
    trade_id: (row.trade_id as string | null) ?? null,
    attempt_id: row.attempt_id as string,
    role: row.role as IBoxOrderIntent["role"],
    purpose: row.purpose as IBoxOrderIntent["purpose"],
    phase: row.phase as IBoxOrderIntent["phase"],
    exchange: row.exchange as string,
    tradingsymbol: row.tradingsymbol as string,
    token: num(row.token),
    side: row.side as IBoxOrderIntent["side"],
    quantity: num(row.quantity),
    reference_price: num(row.reference_price),
    tick_size: num(row.tick_size),
    max_chase_ticks: num(row.max_chase_ticks),
    limit_price: num(row.limit_price),
    state: row.state as BoxOrderIntentState,
    filled_quantity: num(row.filled_quantity),
    previous_filled_quantity: numOrNull(row.previous_filled_quantity),
    average_price: numOrNull(row.average_price),
    broker_tag: (row.broker_tag as string | null) ?? null,
    reject_family: (row.reject_family as string | null) ?? null,
    reject_reason: (row.reject_reason as string | null) ?? null,
    created_at: asDate(row.created_at) as Date,
    updated_at: asDate(row.updated_at) as Date,
    terminal_at: asDate(row.terminal_at),
    audit: reviveIntentAudit((row.audit as BoxOrderIntentAudit[]) ?? []),
  };
}

function reviveIntentAudit(audit: BoxOrderIntentAudit[]): BoxOrderIntentAudit[] {
  return audit.map((entry) => ({
    ...entry,
    at: (typeof entry.at === "string" ? new Date(entry.at) : entry.at) as Date,
  }));
}

async function enqueueIntentProjection(
  client: PoolClient,
  intent: BoxOrderIntentRecord,
  eventType: string,
  auditId: string,
): Promise<void> {
  await enqueueOutbox(client, {
    // Derived from durable facts: intent id + audit id, so a replayed transition upserts.
    eventId: `box_order_intent:${intent._id}:${auditId}`,
    aggregateType: "box_order_intent",
    aggregateId: intent._id,
    eventType,
    schemaVersion: BOX_PROJECTION_SCHEMA_VERSION,
    payload: {
      source_id: intent._id,
      client_order_id: intent.client_order_id,
      broker_order_id: intent.broker_order_id,
      broker: brokerValue(intent.broker),
      broker_mode: intent.broker_mode,
      trade_id: intent.trade_id,
      attempt_id: intent.attempt_id,
      role: intent.role,
      purpose: intent.purpose,
      phase: intent.phase,
      state: intent.state,
      filled_quantity: intent.filled_quantity,
      previous_filled_quantity: intent.previous_filled_quantity,
      average_price: intent.average_price,
      reject_family: intent.reject_family,
      reject_reason: intent.reject_reason,
      execution_mode: intent.broker_mode === "live" ? "live" : "paper",
      audit: intent.audit,
      projection_schema_version: BOX_PROJECTION_SCHEMA_VERSION,
    },
  });
}

/**
 * Create the durable intent before transport submission. Repeating the same client id
 * returns the original row and never creates a second broker intent (ON CONFLICT).
 */
export async function createBoxOrderIntent(
  intent: IBoxOrderIntent,
): Promise<BoxOrderIntentRecord> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is unavailable; live order intent was not created.");
  }
  const id = allocateBoxTradeId();
  const cols = INTENT_COLUMNS.join(", ");
  const placeholders = INTENT_COLUMNS.map((c, i) => (c === "audit" ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ");
  const row = await withTx(async (client) => {
    const inserted = await client.query(
      `INSERT INTO box_order_intents (${cols}) VALUES (${placeholders})
       ON CONFLICT (client_order_id) DO NOTHING
       RETURNING *`,
      intentInsertValues(id, intent),
    );
    if (inserted.rows[0]) {
      const created = rowToIntent(inserted.rows[0]);
      await enqueueIntentProjection(client, created, "intent_created", `create:${created._id}`);
      return created;
    }
    // Already existed: return the original, no new broker intent.
    const existing = await client.query(
      `SELECT * FROM box_order_intents WHERE client_order_id = $1`,
      [intent.client_order_id],
    );
    return existing.rows[0] ? rowToIntent(existing.rows[0]) : null;
  });
  if (!row) throw new Error(`Failed to create order intent ${intent.client_order_id}.`);
  assertIntentImmutableMatch(row, intent);
  return row;
}

export async function findBoxOrderIntentByClientId(
  clientOrderId: string,
): Promise<BoxOrderIntentRecord | null> {
  if (!isBoxDbEnabled()) return null;
  const { rows } = await query(`SELECT * FROM box_order_intents WHERE client_order_id = $1`, [clientOrderId]);
  return rows[0] ? rowToIntent(rows[0]) : null;
}

export async function findBoxOrderIntentByBrokerId(
  brokerOrderId: string,
): Promise<BoxOrderIntentRecord | null> {
  if (!isBoxDbEnabled()) return null;
  const { rows } = await query(`SELECT * FROM box_order_intents WHERE broker_order_id = $1`, [brokerOrderId]);
  return rows[0] ? rowToIntent(rows[0]) : null;
}

export async function loadNonterminalBoxOrderIntents(): Promise<BoxOrderIntentRecord[]> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is unavailable while loading nonterminal live order intents.");
  }
  const { rows } = await query(
    `SELECT * FROM box_order_intents WHERE state = ANY($1) ORDER BY updated_at ASC`,
    [NONTERMINAL_ORDER_STATES],
  );
  return rows.map(rowToIntent);
}

/**
 * Count unresolved LIVE order intents belonging to ONE broker. Broker-scoped on
 * purpose. Legacy intents have no broker field and are Zerodha's, so a "zerodha"
 * query matches rows where broker is 'zerodha' (the column DEFAULT already stores
 * that for legacy imports).
 */
export async function countUnresolvedBoxOrderIntentsForBroker(broker: string): Promise<number> {
  if (!isBoxDbEnabled()) return 0;
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM box_order_intents
     WHERE broker_mode = 'live' AND state = ANY($1) AND broker = $2`,
    [NONTERMINAL_ORDER_STATES, broker],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function loadOwnedBoxOrderIntents(): Promise<BoxOrderIntentRecord[]> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is unavailable while loading owned live order intents.");
  }
  const { rows } = await query(
    `SELECT * FROM box_order_intents WHERE broker_mode = 'live' ORDER BY created_at DESC`,
  );
  return rows.map(rowToIntent);
}

const INTENT_STATE_PREDECESSORS: Readonly<Record<BoxOrderIntentState, readonly BoxOrderIntentState[]>> = {
  CREATED: ["CREATED"],
  SUBMITTING: ["CREATED", "SUBMITTING"],
  ACKNOWLEDGED: ["SUBMITTING", "ACKNOWLEDGED", "UNKNOWN", "RECONCILIATION_REQUIRED"],
  OPEN: ["SUBMITTING", "ACKNOWLEDGED", "OPEN", "UNKNOWN", "RECONCILIATION_REQUIRED"],
  /*
   * SUBMITTING IS A LEGITIMATE PREDECESSOR OF EVERY OBSERVED OUTCOME.
   *
   * The manager writes SUBMITTING, then awaits the adapter's whole lifecycle (place, poll, possibly
   * protective-cancel), then persists the snapshot it gets back. That snapshot can legitimately be
   * PARTIALLY_FILLED, CANCEL_REQUESTED or CANCELLED without any intermediate state ever having been
   * written — nothing is obliged to persist an interim label, and the periodic reconciler may not have
   * run in between.
   *
   * Omitting SUBMITTING here did not make anything safer; it made the durable record WRONG. The guard
   * refused the write, the intent stayed at SUBMITTING with a possibly-null broker order id, and a
   * cancelled leg carrying a PARTIAL FILL had its attribution withheld — which is what blocks the
   * unwind of exactly the exposure that most needs unwinding. A refused transition is not a safe
   * no-op when the broker has already acted.
   */
  PARTIALLY_FILLED: [
    "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED", "UNKNOWN", "RECONCILIATION_REQUIRED",
  ],
  COMPLETE: [
    "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED", "CANCEL_REQUESTED",
    "CANCELLED", "UNKNOWN", "RECONCILIATION_REQUIRED", "COMPLETE",
  ],
  // SUBMITTING included for the same reason as PARTIALLY_FILLED above: a protective cancel can be
  // requested inside the adapter call, before any interim state was ever persisted.
  CANCEL_REQUESTED: [
    "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED", "CANCEL_REQUESTED", "UNKNOWN",
    "RECONCILIATION_REQUIRED",
  ],
  CANCELLED: [
    "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED", "CANCEL_REQUESTED", "UNKNOWN",
    "RECONCILIATION_REQUIRED", "CANCELLED",
  ],
  REJECTED: ["CREATED", "SUBMITTING", "ACKNOWLEDGED", "OPEN", "REJECTED"],
  UNKNOWN: [
    "CREATED", "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED",
    "CANCEL_REQUESTED", "UNKNOWN", "RECONCILIATION_REQUIRED",
  ],
  RECONCILIATION_REQUIRED: [
    "CREATED", "SUBMITTING", "ACKNOWLEDGED", "OPEN", "PARTIALLY_FILLED",
    "CANCEL_REQUESTED", "UNKNOWN", "RECONCILIATION_REQUIRED",
  ],
};

export interface BoxOrderIntentUpdateResult {
  intent: BoxOrderIntentRecord | null;
  applied: boolean;
  /** Cumulative filled quantity this document held before this update. Null when unknowable. */
  previous_filled_quantity: number | null;
  /** Cumulative filled quantity this document holds after this update. Null when unknowable. */
  current_filled_quantity: number | null;
}

/**
 * ORDER-INTENT CAS. A real transaction: lock the row FOR UPDATE, validate the expected
 * state against the allowed-predecessor map AND the fill/broker guards, then write with
 * RETURNING. The DURABLE pre-image (`previous_filled_quantity`) is captured by the same
 * write from the locked row's prior `filled_quantity`, so the reported delta is a
 * property of the transition, never of a caller snapshot. Audit is appended exactly
 * once, keyed by `audit_id` (idempotent replay).
 */
export async function updateBoxOrderIntent(
  clientOrderId: string,
  patch: BoxOrderIntentPatch,
  audit: BoxOrderIntentAudit,
  expectedStates?: readonly BoxOrderIntentState[],
): Promise<BoxOrderIntentUpdateResult> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is unavailable while updating a live order intent.");
  }
  return withTx(async (client) => {
    const locked = await client.query(
      `SELECT * FROM box_order_intents WHERE client_order_id = $1 FOR UPDATE`,
      [clientOrderId],
    );
    const before = locked.rows[0] ? rowToIntent(locked.rows[0]) : null;
    if (!before) {
      return { intent: null, applied: false, previous_filled_quantity: null, current_filled_quantity: null };
    }

    // Guards, exactly mirroring the predecessor codebase's filter.
    const stateOk = !patch.state || INTENT_STATE_PREDECESSORS[patch.state].includes(before.state);
    const expectedOk = !expectedStates || expectedStates.includes(before.state);
    const fillOk = patch.filled_quantity === undefined ||
      before.filled_quantity <= patch.filled_quantity;
    const brokerOk = !patch.broker_order_id ||
      before.broker_order_id === null || before.broker_order_id === patch.broker_order_id;

    if (!stateOk || !expectedOk || !fillOk || !brokerOk) {
      // Guard refused. Nothing written: an explicit zero-width transition, not a null
      // the caller might read as "unknown, guess from my snapshot".
      const current = typeof before.filled_quantity === "number" ? before.filled_quantity : null;
      return {
        intent: before,
        applied: false,
        previous_filled_quantity: current,
        current_filled_quantity: current,
      };
    }

    // Build the SET list. `previous_filled_quantity` is the pre-image from the locked row.
    const sets: string[] = ["previous_filled_quantity = $2"];
    const values: unknown[] = [clientOrderId, before.filled_quantity];
    const put = (col: string, v: unknown) => { values.push(v); sets.push(`${col} = $${values.length}`); };
    if (patch.broker_order_id !== undefined) put("broker_order_id", patch.broker_order_id);
    if (patch.state !== undefined) put("state", patch.state);
    if (patch.filled_quantity !== undefined) put("filled_quantity", patch.filled_quantity);
    if (patch.average_price !== undefined) put("average_price", patch.average_price);
    if (patch.broker_tag !== undefined) put("broker_tag", patch.broker_tag);
    if (patch.reject_family !== undefined) put("reject_family", patch.reject_family);
    if (patch.reject_reason !== undefined) put("reject_reason", patch.reject_reason);
    if (patch.updated_at !== undefined) put("updated_at", asDate(patch.updated_at));
    if (patch.terminal_at !== undefined) put("terminal_at", asDate(patch.terminal_at));

    // Idempotent audit append by audit_id.
    const alreadyAudited = before.audit.some((entry) => entry.audit_id === audit.audit_id);
    if (!alreadyAudited) {
      values.push(jsonb([audit]));
      sets.push(`audit = COALESCE(audit, '[]'::jsonb) || $${values.length}::jsonb`);
    }

    const updated = await client.query(
      `UPDATE box_order_intents SET ${sets.join(", ")} WHERE client_order_id = $1 RETURNING *`,
      values,
    );
    const after = rowToIntent(updated.rows[0]);

    // Append to the queryable transition audit table (idempotent by audit_id).
    if (!alreadyAudited) {
      await client.query(
        `INSERT INTO box_order_intent_transitions
           (audit_id, client_order_id, intent_id, at, from_state, to_state, broker_order_id, message, fill_identity, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (audit_id) DO NOTHING`,
        [
          audit.audit_id, clientOrderId, after._id, asDate(audit.at) ?? new Date(),
          audit.from_state ?? null, audit.to_state, audit.broker_order_id ?? null,
          audit.message ?? null, audit.fill_identity ?? null, jsonb(audit.payload ?? null),
        ],
      );
      await enqueueIntentProjection(client, after, `intent_${audit.to_state}`, audit.audit_id);
    }

    return {
      intent: after,
      applied: true,
      previous_filled_quantity: typeof after.previous_filled_quantity === "number"
        ? after.previous_filled_quantity
        : null,
      current_filled_quantity: typeof after.filled_quantity === "number" ? after.filled_quantity : null,
    };
  });
}

/** Ready-to-inject durable persistence contract for OrderManager. */
export const boxOrderIntentPersistence = {
  create: createBoxOrderIntent,
  update: updateBoxOrderIntent,
  loadNonterminal: loadNonterminalBoxOrderIntents,
  loadOwned: loadOwnedBoxOrderIntents,
  findByClientId: findBoxOrderIntentByClientId,
  findByBrokerId: findBoxOrderIntentByBrokerId,
};

const IMMUTABLE_INTENT_FIELDS = [
  "broker_mode", "trade_id", "attempt_id", "role", "purpose", "phase", "exchange",
  "tradingsymbol", "token", "side", "quantity", "reference_price", "tick_size",
  "max_chase_ticks", "limit_price",
  /*
   * THE OWNING ACCOUNT IS IMMUTABLE.
   *
   * Reusing a client order id under a DIFFERENT account is exactly the confusion account binding
   * exists to prevent, so it is refused here alongside the contract and quantity fields. A row
   * carrying no account and a proposal carrying a real one is also a mismatch, which is the safe
   * direction: it forces explicit resolution rather than silently adopting the row.
   */
  "broker_account",
] as const;

/**
 * Fields where ABSENT and NULL mean the same thing and must therefore compare EQUAL.
 *
 * `broker_account` is nullable (migration 011 adds it without a backfill), so a row read back from
 * PostgreSQL carries `null` while a freshly-built intent that never set the field carries `undefined`.
 * A strict `!==` between those two is a false mismatch — and it surfaced as
 * "client order id was reused with different immutable field broker_account", which points an operator
 * at duplicate-order suspicion for what is really just an unset optional column.
 *
 * Normalising `undefined` to `null` keeps the real guard intact: a row with no account and a proposal
 * with a REAL account still mismatch, because only the two "no account" spellings are unified.
 */
const NULLABLE_INTENT_FIELDS = new Set<string>(["broker_account"]);

function assertIntentImmutableMatch(existing: IBoxOrderIntent, proposed: IBoxOrderIntent): void {
  for (const field of IMMUTABLE_INTENT_FIELDS) {
    const a = NULLABLE_INTENT_FIELDS.has(field) ? existing[field] ?? null : existing[field];
    const b = NULLABLE_INTENT_FIELDS.has(field) ? proposed[field] ?? null : proposed[field];
    if (a !== b) {
      throw new Error(
        `Client order id ${proposed.client_order_id} was reused with different immutable field ${field}.`,
      );
    }
  }
}

/* --------------------------- execution attempts --------------------------- */

const ATTEMPT_COLUMNS = [
  "id", "candidate_key", "direction", "underlying", "name", "is_index", "expiry", "lower_strike",
  "upper_strike", "lot_size", "quantity", "execution_mode", "broker", "leg_execution_mode",
  "detected_at", "resolved_at", "detected_gross_edge", "expected_net_profit", "filled_leg_count",
  "failed_legs", "failure_reason", "failure_detail", "abort_after_fill", "outcome_class",
  "required_expected_net_profit", "charge_rate_version", "partial_entry_charges", "unwind_charges",
  "flatten_charges", "flatten_charge_day", "flatten_charges_for_day", "projection_version",
  "residual_projection_identity", "applied_flatten_applications", "gross_abort_pnl",
  "net_abort_pnl", "resolved", "legging", "residual_exposure",
] as const;

const ATTEMPT_JSON_COLS = new Set(["failed_legs", "applied_flatten_applications", "legging", "residual_exposure"]);

function attemptInsertValues(id: string, a: IBoxExecutionAttempt): unknown[] {
  return [
    id, a.candidate_key ?? "", a.direction ?? "LONG_BOX", a.underlying ?? "", a.name ?? "",
    a.is_index ?? false, a.expiry ?? "", a.lower_strike ?? 0, a.upper_strike ?? 0, a.lot_size ?? 0,
    a.quantity ?? 0, a.execution_mode ?? "paper_legging", brokerValue(a.broker),
    a.leg_execution_mode ?? null, asDate(a.detected_at) ?? new Date(), asDate(a.resolved_at) ?? new Date(),
    a.detected_gross_edge ?? null, a.expected_net_profit ?? null, a.filled_leg_count ?? 0,
    jsonb(a.failed_legs ?? []), a.failure_reason ?? null, a.failure_detail ?? null,
    a.abort_after_fill ?? false, a.outcome_class ?? null, a.required_expected_net_profit ?? null,
    a.charge_rate_version ?? null, a.partial_entry_charges ?? null, a.unwind_charges ?? null,
    a.flatten_charges ?? 0, a.flatten_charge_day ?? null, a.flatten_charges_for_day ?? 0,
    a.projection_version ?? 0, a.residual_projection_identity ?? null,
    jsonb(a.applied_flatten_applications ?? []), a.gross_abort_pnl ?? null, a.net_abort_pnl ?? null,
    a.resolved ?? true, jsonb(a.legging ?? null), jsonb(a.residual_exposure ?? null),
  ];
}

function rowToAttempt(row: Record<string, unknown>): BoxExecutionAttemptRecord {
  return {
    _id: String(row.id),
    candidate_key: row.candidate_key as string,
    direction: row.direction as BoxDirection,
    underlying: row.underlying as string,
    name: row.name as string,
    is_index: row.is_index as boolean,
    expiry: row.expiry as string,
    lower_strike: num(row.lower_strike),
    upper_strike: num(row.upper_strike),
    lot_size: num(row.lot_size),
    quantity: num(row.quantity),
    execution_mode: row.execution_mode as ExecutionMode,
    broker: brokerValue(row.broker as BrokerId),
    leg_execution_mode: (row.leg_execution_mode as IBoxExecutionAttempt["leg_execution_mode"]) ?? null,
    detected_at: asDate(row.detected_at) as Date,
    resolved_at: asDate(row.resolved_at) as Date,
    detected_gross_edge: numOrNull(row.detected_gross_edge),
    expected_net_profit: numOrNull(row.expected_net_profit),
    required_expected_net_profit: numOrNull(row.required_expected_net_profit),
    charge_rate_version: (row.charge_rate_version as string | null) ?? null,
    abort_after_fill: (row.abort_after_fill as boolean) ?? false,
    outcome_class: (row.outcome_class as IBoxExecutionAttempt["outcome_class"]) ?? null,
    filled_leg_count: num(row.filled_leg_count),
    failed_legs: (row.failed_legs as IBoxExecutionAttempt["failed_legs"]) ?? [],
    failure_reason: (row.failure_reason as IBoxExecutionAttempt["failure_reason"]) ?? null,
    failure_detail: (row.failure_detail as string | null) ?? null,
    legging: (row.legging as IBoxExecutionAttempt["legging"]) ?? null,
    partial_entry_charges: numOrNull(row.partial_entry_charges),
    unwind_charges: numOrNull(row.unwind_charges),
    flatten_charges: numOrNull(row.flatten_charges),
    flatten_charge_day: (row.flatten_charge_day as string | null) ?? null,
    flatten_charges_for_day: numOrNull(row.flatten_charges_for_day),
    projection_version: numOrNull(row.projection_version),
    residual_projection_identity: (row.residual_projection_identity as string | null) ?? null,
    applied_flatten_applications: (row.applied_flatten_applications as string[] | null) ?? null,
    gross_abort_pnl: numOrNull(row.gross_abort_pnl),
    net_abort_pnl: numOrNull(row.net_abort_pnl),
    residual_exposure: (row.residual_exposure as IBoxExecutionAttempt["residual_exposure"]) ?? undefined,
    resolved: (row.resolved as boolean) ?? undefined,
  } as BoxExecutionAttemptRecord;
}

async function enqueueAttemptProjection(
  client: PoolClient,
  attempt: BoxExecutionAttemptRecord,
  eventType: string,
): Promise<void> {
  await enqueueOutbox(client, {
    eventId: `box_execution_attempt:${attempt._id}:${eventType}:${attempt.projection_version ?? 0}`,
    aggregateType: "box_execution_attempt",
    aggregateId: attempt._id,
    eventType,
    schemaVersion: BOX_PROJECTION_SCHEMA_VERSION,
    payload: {
      ...attempt,
      source_id: attempt._id,
      broker: brokerValue(attempt.broker),
      charge_origin: null,
      charge_rate_version: attempt.charge_rate_version ?? null,
      execution_mode: attempt.execution_mode,
      projection_schema_version: BOX_PROJECTION_SCHEMA_VERSION,
    },
  });
}

/** Persist a paper_legging execution attempt that did not open a box. Best-effort. */
export async function insertBoxExecutionAttempt(
  attempt: IBoxExecutionAttempt,
): Promise<string | null> {
  if (!isBoxDbEnabled()) return null;
  try {
    const id = allocateBoxTradeId();
    const cols = ATTEMPT_COLUMNS.join(", ");
    const placeholders = ATTEMPT_COLUMNS.map((c, i) => (ATTEMPT_JSON_COLS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ");
    return await withTx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO box_execution_attempts (${cols}) VALUES (${placeholders}) RETURNING *`,
        attemptInsertValues(id, attempt),
      );
      const created = rowToAttempt(rows[0]);
      await enqueueAttemptProjection(client, created, "attempt_recorded");
      return created._id;
    });
  } catch (err) {
    console.warn("[Box] failed to persist execution attempt:", err);
    return null;
  }
}

export async function loadBoxExecutionAttempts(limit = 200): Promise<BoxExecutionAttemptRecord[]> {
  if (!isBoxDbEnabled()) return [];
  try {
    const { rows } = await query(
      `SELECT * FROM box_execution_attempts ORDER BY resolved_at DESC LIMIT $1`, [limit]);
    return rows.map(rowToAttempt);
  } catch {
    return [];
  }
}

/** Attempts that still hold RESIDUAL exposure (resolved:false), newest first. */
export async function loadUnresolvedBoxExecutionAttempts(limit = 200): Promise<BoxExecutionAttemptRecord[]> {
  if (!isBoxDbEnabled()) return [];
  try {
    // Crash-only rows are quarantined unless this process has established/verified their
    // uniqueness boundary; ordinary residual attempts remain safe to adopt and work.
    const sql = isBoxRecoveryPersistenceReady()
      ? `SELECT * FROM box_execution_attempts WHERE resolved = false ORDER BY resolved_at DESC LIMIT $1`
      : `SELECT * FROM box_execution_attempts WHERE resolved = false AND candidate_key <> $2 ORDER BY resolved_at DESC LIMIT $1`;
    const params = isBoxRecoveryPersistenceReady() ? [limit] : [limit, BOX_RECOVERY_KEY];
    const { rows } = await query(sql, params);
    return rows.map(rowToAttempt);
  } catch {
    return [];
  }
}

function validatedRecoveryExecutionAttempt(
  row: BoxExecutionAttemptRecord | null,
): BoxExecutionAttemptRecord | null {
  if (!row) return null;
  const residual = row.residual_exposure;
  const version = row.projection_version;
  const charges = row.flatten_charges ?? 0;
  if (row.candidate_key !== BOX_RECOVERY_KEY || row.resolved !== false ||
      !Array.isArray(residual) || residual.length === 0 ||
      !Number.isSafeInteger(version) || (version ?? -1) < 0 ||
      !Number.isFinite(charges) || charges < 0 ||
      row.residual_projection_identity !== residualProjectionIdentity(residual)) {
    throw new Error(
      `unresolved ${BOX_RECOVERY_KEY} row ${row._id} has an incompatible projection; ` +
        "direct crash recovery is quarantined",
    );
  }
  return row;
}

/**
 * Create or adopt the deterministic ledger row used by direct crash-only recovery. The
 * fixed id makes retries and workers converge on one accounting boundary; the partial
 * unique index guarantees at most one unresolved boot-recovery row.
 */
export async function ensureBoxRecoveryExecutionAttempt(args: {
  id: string;
  recoveryKey: string;
  residual: IBoxExecutionAttempt["residual_exposure"];
  executionMode: ExecutionMode;
  broker: BrokerId;
  at: Date;
}): Promise<BoxExecutionAttemptRecord | null> {
  if (!isBoxDbEnabled() || !isValidBoxId(args.id)) return null;
  if (args.recoveryKey !== BOX_RECOVERY_KEY || !isBoxRecoveryPersistenceReady()) {
    throw new Error(
      "direct crash recovery is quarantined until its unique persistence index is verified",
    );
  }
  const existingRes = await query(
    `SELECT * FROM box_execution_attempts WHERE candidate_key = $1 AND resolved = false
     ORDER BY resolved_at ASC LIMIT 1`,
    [args.recoveryKey],
  );
  if (existingRes.rows[0]) return validatedRecoveryExecutionAttempt(rowToAttempt(existingRes.rows[0]));

  const residual = args.residual ?? [];
  const attempt: IBoxExecutionAttempt = {
    candidate_key: args.recoveryKey,
    direction: "LONG_BOX",
    underlying: "CRASH_RECOVERY",
    name: "Crash-only attributed recovery",
    is_index: false,
    expiry: "",
    lower_strike: 0,
    upper_strike: 0,
    lot_size: 0,
    quantity: residual.reduce((sum, leg) => sum + leg.quantity, 0),
    execution_mode: args.executionMode,
    broker: args.broker,
    leg_execution_mode: null,
    detected_at: args.at,
    resolved_at: args.at,
    detected_gross_edge: null,
    expected_net_profit: null,
    filled_leg_count: 0,
    failed_legs: [],
    failure_reason: "unwind_failed",
    failure_detail: "durable accounting boundary for crash-only attributed flatten",
    legging: null,
    partial_entry_charges: null,
    unwind_charges: null,
    flatten_charges: 0,
    flatten_charge_day: null,
    flatten_charges_for_day: 0,
    projection_version: 0,
    residual_projection_identity: residualProjectionIdentity(residual),
    applied_flatten_applications: [],
    gross_abort_pnl: null,
    net_abort_pnl: null,
    residual_exposure: residual,
    resolved: residual.length === 0,
  };
  try {
    return await withTx(async (client) => {
      const cols = ATTEMPT_COLUMNS.join(", ");
      const placeholders = ATTEMPT_COLUMNS.map((c, i) => (ATTEMPT_JSON_COLS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ");
      const { rows } = await client.query(
        `INSERT INTO box_execution_attempts (${cols}) VALUES (${placeholders})
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        attemptInsertValues(args.id, attempt),
      );
      if (rows[0]) {
        const created = rowToAttempt(rows[0]);
        await enqueueAttemptProjection(client, created, "attempt_recovery");
        return validatedRecoveryExecutionAttempt(created);
      }
      const existing = await client.query(`SELECT * FROM box_execution_attempts WHERE id = $1`, [args.id]);
      return existing.rows[0] ? validatedRecoveryExecutionAttempt(rowToAttempt(existing.rows[0])) : null;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Another snapshot won the single-unresolved-recovery index between our read and insert.
    const winner = await query(
      `SELECT * FROM box_execution_attempts WHERE candidate_key = $1 AND resolved = false LIMIT 1`,
      [args.recoveryKey],
    );
    return winner.rows[0] ? validatedRecoveryExecutionAttempt(rowToAttempt(winner.rows[0])) : null;
  }
}

function projectionResult(
  status: BoxExecutionAttemptProjectionResult["status"],
  row: BoxExecutionAttemptRecord | null,
): BoxExecutionAttemptProjectionResult {
  if (!row) {
    return {
      status, projection_version: null, projection_identity: null, residual_exposure: null,
      flatten_charges: null, flatten_charge_day: null, flatten_charges_for_day: null,
    };
  }
  const residual = Array.isArray(row.residual_exposure) ? row.residual_exposure : [];
  return {
    status,
    projection_version: Number.isSafeInteger(row.projection_version) && (row.projection_version ?? -1) >= 0
      ? row.projection_version! : 0,
    projection_identity: row.residual_projection_identity ?? residualProjectionIdentity(residual),
    residual_exposure: residual,
    flatten_charges: Math.round(Math.max(0, row.flatten_charges ?? 0) * 100) / 100,
    flatten_charge_day: row.flatten_charge_day ?? null,
    flatten_charges_for_day: Math.round(Math.max(0, row.flatten_charges_for_day ?? 0) * 100) / 100,
  };
}

/**
 * Atomically own one residual/charge projection transition, under a row lock. Exactly
 * one writer can match the expected version/identity and application id; replay returns
 * `already_applied`; a different winner returns `stale` with its authoritative
 * projection. Missing legacy version/application fields are treated as version 0 / empty.
 */
export async function applyBoxExecutionAttemptProjection(
  id: string,
  command: BoxExecutionAttemptProjectionCommand,
): Promise<BoxExecutionAttemptProjectionResult> {
  if (!isBoxDbEnabled() || !isValidBoxId(id)) return projectionResult("not_found", null);
  return withTx(async (client) => {
    const locked = await client.query(`SELECT * FROM box_execution_attempts WHERE id = $1 FOR UPDATE`, [id]);
    if (!locked.rows[0]) return projectionResult("not_found", null);
    const before = rowToAttempt(locked.rows[0]);
    const applications = before.applied_flatten_applications ?? [];
    if (applications.includes(command.application_id)) {
      return projectionResult("already_applied", before);
    }
    const currentVersion = Number.isSafeInteger(before.projection_version) && (before.projection_version ?? -1) >= 0
      ? before.projection_version! : 0;
    const currentIdentity = before.residual_projection_identity ?? null;

    const versionMatches = currentVersion === command.expected_version ||
      (command.expected_version === 0 && (before.projection_version === null || before.projection_version === undefined));
    const residual = Array.isArray(before.residual_exposure) ? before.residual_exposure : [];
    // The version-zero legacy fallback compares residual CONTENT, not raw serialisation. PostgreSQL
    // stores residual_exposure as jsonb, which does not preserve object key order, so a byte-for-byte
    // JSON.stringify() comparison against the command's expected residual would never match a stored
    // multi-field leg and a legacy row could never be adopted. residualProjectionIdentity() canonicalises
    // field set and array order, so it is the order-independent identity the guard needs.
    const legacyResidualMatches =
      residualProjectionIdentity(residual as typeof command.expected_residual_exposure) === command.expected_projection_identity;
    const identityMatches = currentIdentity === command.expected_projection_identity ||
      (command.expected_version === 0 && currentIdentity === null && legacyResidualMatches);

    if (!versionMatches || !identityMatches) {
      return projectionResult("stale", before);
    }

    const priorDay = before.flatten_charge_day;
    const priorForDay = Math.max(0, before.flatten_charges_for_day ?? 0);
    const nextCharges = Math.round((Math.max(0, before.flatten_charges ?? 0) + command.flatten_charge_delta) * 100) / 100;
    const chargedNow = command.flatten_charge_delta > 0;
    const nextChargeDay = chargedNow ? command.flatten_charge_day : priorDay ?? null;
    const nextForDay = chargedNow
      ? Math.round(((priorDay === command.flatten_charge_day ? priorForDay : 0) + command.flatten_charge_delta) * 100) / 100
      : priorForDay;
    const nextApplications = [...applications, command.application_id].slice(-MAX_FLATTEN_APPLICATION_IDS);

    const { rows } = await client.query(
      `UPDATE box_execution_attempts SET
         residual_exposure = $2::jsonb,
         resolved = $3,
         projection_version = $4,
         residual_projection_identity = $5,
         applied_flatten_applications = $6::jsonb,
         flatten_charges = $7,
         flatten_charge_day = $8,
         flatten_charges_for_day = $9
       WHERE id = $1 RETURNING *`,
      [
        id, jsonb(command.residual_exposure), command.residual_exposure.length === 0,
        currentVersion + 1, command.next_projection_identity, jsonb(nextApplications),
        nextCharges, nextChargeDay, nextForDay,
      ],
    );
    const after = rowToAttempt(rows[0]);
    await enqueueAttemptProjection(client, after, "attempt_projection");
    return projectionResult("applied", after);
  });
}

function round2Repo(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Pure daily attribution rule shared by the seed and offline rollover tests. */
export function boxExecutionAttemptDailyRiskContribution(
  attempt: {
    resolved_at?: Date | null;
    net_abort_pnl?: number | null;
    flatten_charges?: number | null;
    flatten_charge_day?: string | null;
    flatten_charges_for_day?: number | null;
  },
  sinceMs: number,
  tradingDay: string,
): number {
  const resolvedToday = attempt.resolved_at instanceof Date && attempt.resolved_at.getTime() >= sinceMs;
  const abort = resolvedToday ? (attempt.net_abort_pnl ?? 0) : 0;
  const flattenToday = attempt.flatten_charge_day === tradingDay
    ? Math.max(0, attempt.flatten_charges_for_day ?? 0)
    : resolvedToday && !attempt.flatten_charge_day
      ? Math.max(0, attempt.flatten_charges ?? 0)
      : 0;
  return round2Repo(abort - flattenToday);
}

interface BoxDailyRiskSeedAttemptRow {
  _id: string;
  resolved_at?: Date | null;
  resolved?: boolean;
  net_abort_pnl?: number | null;
  flatten_charges?: number | null;
  flatten_charge_day?: string | null;
  flatten_charges_for_day?: number | null;
}

const BOX_DAILY_RISK_SEED_LIMIT = 200;

function riskRow(row: Record<string, unknown>): BoxDailyRiskSeedAttemptRow {
  const out: BoxDailyRiskSeedAttemptRow = { _id: String(row.id) };
  out.resolved_at = asDate(row.resolved_at);
  if (row.resolved !== null && row.resolved !== undefined) out.resolved = row.resolved as boolean;
  out.net_abort_pnl = numOrNull(row.net_abort_pnl);
  out.flatten_charges = numOrNull(row.flatten_charges);
  out.flatten_charge_day = (row.flatten_charge_day as string | null) ?? null;
  out.flatten_charges_for_day = numOrNull(row.flatten_charges_for_day);
  return out;
}

export async function loadBoxLiveRiskSeed(sinceMs: number, tradingDayArg?: string): Promise<{
  realisedPnl: number;
  rejects: number;
  consecutiveFailures: number;
  flattenChargeBaselines: Record<string, number>;
  flattenChargeBaselinesForDay: Record<string, number>;
  incomplete: boolean;
}> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is unavailable while loading the live daily-risk seed.");
  }
  const tradingDay = tradingDayArg ??
    new Date(sinceMs + 5.5 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const since = new Date(sinceMs);
  const RISK_SELECT = `id, resolved_at, resolved, net_abort_pnl, flatten_charges, flatten_charge_day, flatten_charges_for_day`;
  const [trades, chargedToday, resolvedToday, stillUnresolved, rejectedCount, recentIntents] = await Promise.all([
    query<{ realised_net_pnl: unknown; net_pnl: unknown }>(
      `SELECT realised_net_pnl, net_pnl FROM box_trades WHERE closed_at >= $1`, [since]),
    query(`SELECT ${RISK_SELECT} FROM box_execution_attempts WHERE flatten_charge_day = $1
           ORDER BY flatten_charges_for_day DESC LIMIT $2`, [tradingDay, BOX_DAILY_RISK_SEED_LIMIT]),
    query(`SELECT ${RISK_SELECT} FROM box_execution_attempts WHERE resolved_at >= $1
           ORDER BY resolved_at DESC LIMIT $2`, [since, BOX_DAILY_RISK_SEED_LIMIT]),
    query(`SELECT ${RISK_SELECT} FROM box_execution_attempts WHERE resolved = false
           ORDER BY resolved_at DESC LIMIT $1`, [BOX_DAILY_RISK_SEED_LIMIT]),
    query<{ n: string }>(
      `SELECT count(*)::text AS n FROM box_order_intents
       WHERE state = 'REJECTED' AND updated_at >= $1
         AND NOT (
           filled_quantity = 0 AND broker_order_id IS NULL AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(audit) e
             WHERE e->>'to_state' = 'REJECTED'
               AND e->'payload'->>'origin' = 'local_pre_submit_refusal'
               AND (e->'payload'->>'no_broker_post')::boolean = true
           )
         )`, [since]),
    query(`SELECT state, filled_quantity, broker_order_id, audit FROM box_order_intents
           WHERE updated_at >= $1 ORDER BY updated_at DESC`, [since]),
  ]);

  const attemptsById = new Map<string, BoxDailyRiskSeedAttemptRow>();
  for (const row of [...chargedToday.rows, ...resolvedToday.rows, ...stillUnresolved.rows]) {
    const r = riskRow(row);
    attemptsById.set(r._id, r);
  }
  const attempts = [...attemptsById.values()];
  const tradePnl = trades.rows.reduce((sum, t) => sum + (numOrNull(t.realised_net_pnl) ?? numOrNull(t.net_pnl) ?? 0), 0);
  const abortPnl = attempts.reduce(
    (sum, a) => sum + boxExecutionAttemptDailyRiskContribution(a, sinceMs, tradingDay), 0);
  const flattenChargeBaselines: Record<string, number> = {};
  const flattenChargeBaselinesForDay: Record<string, number> = {};
  for (const attempt of attempts) {
    if (attempt.flatten_charge_day === tradingDay) {
      flattenChargeBaselinesForDay[attempt._id] = round2Repo(Math.max(0, attempt.flatten_charges_for_day ?? 0));
    }
    if (attempt.resolved !== false) continue;
    flattenChargeBaselines[attempt._id] = round2Repo(Math.max(0, attempt.flatten_charges ?? 0));
  }
  let consecutiveFailures = 0;
  for (const raw of recentIntents.rows) {
    const state = raw.state as BoxOrderIntentState;
    if (state === "COMPLETE") break;
    const audit = (raw.audit as BoxOrderIntentAudit[]) ?? [];
    const localNoPost = state === "REJECTED" && num(raw.filled_quantity) === 0 &&
      raw.broker_order_id === null && audit.some((event) =>
        event.to_state === "REJECTED" &&
        event.payload?.origin === "local_pre_submit_refusal" &&
        event.payload?.no_broker_post === true);
    if (localNoPost) continue;
    if (state === "REJECTED" || state === "UNKNOWN" || state === "RECONCILIATION_REQUIRED") {
      consecutiveFailures++;
    }
  }
  return {
    realisedPnl: tradePnl + abortPnl,
    rejects: Number(rejectedCount.rows[0]?.n ?? 0),
    consecutiveFailures,
    flattenChargeBaselines,
    flattenChargeBaselinesForDay,
    incomplete: chargedToday.rows.length >= BOX_DAILY_RISK_SEED_LIMIT ||
      resolvedToday.rows.length >= BOX_DAILY_RISK_SEED_LIMIT ||
      stillUnresolved.rows.length >= BOX_DAILY_RISK_SEED_LIMIT,
  };
}

/* ----------------------------- daily P&L archive -------------------------- */

const PNL_QUERY_CHUNK = 200;
const PNL_SCAN_PAGE = 200;
const MAX_DELETION_CANDIDATE_DAYS = 64;

function chunks<T>(items: readonly T[], size = PNL_QUERY_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** Pending preparation alone never invalidates a row while its source exists. */
export function isArchivedPnlRowInvalid(
  sourceExists: boolean,
  fenceStatus: "pending" | "complete" | null,
): boolean {
  return !sourceExists || fenceStatus === "complete";
}

function rowToDailyPnl(row: Record<string, unknown>): BoxDailyPnlRecord {
  return {
    _id: `${row.day}:${row.trade_id}`,
    day: row.day as string,
    trade_id: row.trade_id as string,
    underlying: row.underlying as string,
    direction: row.direction as string,
    lower_strike: numOrNull(row.lower_strike) ?? 0,
    upper_strike: numOrNull(row.upper_strike) ?? 0,
    expiry: row.expiry as string,
    status: row.status as IBoxDailyPnl["status"],
    gross_pnl: numOrNull(row.gross_pnl),
    net_pnl: numOrNull(row.net_pnl),
    realisable_net_pnl: numOrNull(row.realisable_net_pnl),
    realised_net_pnl: numOrNull(row.realised_net_pnl),
    opened_at: (row.opened_at as string | null) ?? null,
    closed_at: (row.closed_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
    summary: (row.summary as BoxDailyPnlRecord["summary"]) ?? null,
    archived_at: asDate(row.archived_at) ?? undefined,
  } as BoxDailyPnlRecord;
}

/** Which of these trade ids are no longer legal at the durable boundary. */
async function invalidArchivedTradeIds(ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids.filter((id) => id !== SUMMARY_FIELD))];
  if (unique.length === 0) return [];
  const invalid: string[] = [];
  for (const batch of chunks(unique)) {
    const validIds = batch.filter(isValidBoxId);
    const sources = validIds.length > 0
      ? (await query<{ id: string }>(`SELECT id FROM box_trades WHERE id = ANY($1::text[])`, [validIds])).rows
      : [];
    const completedFences = (await query<{ trade_id: string }>(
      `SELECT trade_id FROM box_pnl_deletions WHERE trade_id = ANY($1::text[]) AND status = 'complete'`,
      [batch],
    )).rows;
    const existing = new Set(sources.map((r) => String(r.id)));
    const completed = new Set(completedFences.map((r) => String(r.trade_id)));
    invalid.push(...batch.filter((id) =>
      isArchivedPnlRowInvalid(existing.has(id), completed.has(id) ? "complete" : null)));
  }
  return invalid;
}

/**
 * Invalidate completeness without erasing the last exact proof. Retaining v2 metadata
 * is what lets periodic repair distinguish a same-membership late write from an
 * uncertifiable partial generation after a crash.
 */
export async function markBoxDailyPnlIncomplete(day: string, needsReproof = true): Promise<void> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  await query(
    `INSERT INTO box_pnl_day_states (day, complete, needs_reproof, updated_at)
     VALUES ($1, false, $2, now())
     ON CONFLICT (day) DO UPDATE SET complete = false, needs_reproof = $2, updated_at = now()`,
    [day, needsReproof],
  );
}

async function markBoxDailyPnlRetryIfProof(day: string, proof: BoxPnlDayProof): Promise<void> {
  await query(
    `UPDATE box_pnl_day_states
     SET complete = false, needs_reproof = true, updated_at = now()
     WHERE day = $1 AND snapshot_version = $2 AND row_count = $3 AND content_sha256 = $4`,
    [day, proof.snapshot_version, proof.row_count, proof.content_sha256],
  );
}

export function shouldReproveBoxPnlDay(state: { complete?: boolean; needs_reproof?: boolean } | null): boolean {
  return state?.complete === true || state?.needs_reproof === true;
}

export function boxPnlDayProofFromState(state: {
  snapshot_version?: number;
  row_count?: number;
  content_sha256?: string;
}): BoxPnlDayProof | null {
  return state.snapshot_version === 2 && Number.isInteger(state.row_count) &&
    (state.row_count ?? -1) >= 0 && /^[a-f0-9]{64}$/.test(state.content_sha256 ?? "")
    ? { snapshot_version: 2, row_count: state.row_count!, content_sha256: state.content_sha256! }
    : null;
}

/* -- The following five run* functions are DB-agnostic: they take injected callbacks
 * and are ported VERBATIM from the predecessor codebase. The ported unit tests exercise them directly. */

export async function runBoxPnlDayMutation<T>(args: {
  invalidate: () => Promise<void>;
  mutate: () => Promise<T>;
}): Promise<T> {
  await args.invalidate();
  let result: T | undefined;
  let mutationError: unknown;
  try {
    result = await args.mutate();
  } catch (err) {
    mutationError = err;
  }
  try {
    await args.invalidate();
  } catch (invalidationError) {
    if (mutationError !== undefined) {
      throw new AggregateError([mutationError, invalidationError],
        "Box P&L mutation and post-invalidation both failed");
    }
    throw invalidationError;
  }
  if (mutationError !== undefined) throw mutationError;
  return result as T;
}

export async function runSourceSafePnlRowUpsert(args: {
  allowed: () => Promise<boolean>;
  write: () => Promise<void>;
  remove: () => Promise<void>;
  rewriteSummary: () => Promise<void>;
}): Promise<"skipped" | "written" | "self_cleaned"> {
  if (!(await args.allowed())) return "skipped";
  await args.write();
  if (await args.allowed()) return "written";
  await args.remove();
  await args.rewriteSummary();
  return "self_cleaned";
}

export interface BoxPnlIndependentRepairResult {
  repaired: number;
  failureCount: number;
  errors: Error[];
}

export async function runIndependentBoxPnlRepairs<T>(args: {
  scope: string;
  items: readonly T[];
  identify: (item: T) => string;
  repair: (item: T) => Promise<number>;
  maxErrorSamples?: number;
}): Promise<BoxPnlIndependentRepairResult> {
  let repaired = 0;
  let failureCount = 0;
  const errors: Error[] = [];
  const maxErrorSamples = Math.max(1, args.maxErrorSamples ?? 20);
  for (const item of args.items) {
    try {
      repaired += await args.repair(item);
    } catch (err) {
      failureCount++;
      if (errors.length < maxErrorSamples) {
        const cause = err instanceof Error ? err : new Error(String(err));
        errors.push(new Error(`${args.scope} ${args.identify(item)} failed: ${cause.message}`, { cause }));
      }
    }
  }
  return { repaired, failureCount, errors };
}

export async function runBoxPnlDayProofCommit(args: {
  expected: IBoxDailyPnl[];
  settle: () => Promise<void>;
  load: () => Promise<IBoxDailyPnl[]>;
  publish: (proof: BoxPnlDayProof) => Promise<void>;
  invalidate: () => Promise<void>;
}): Promise<BoxPnlDayProof> {
  const expectedProof = buildBoxPnlDayProof(args.expected);
  const matches = (docs: IBoxDailyPnl[]) =>
    boxPnlSummaryMatchesRows(docs) && boxPnlDayProofsEqual(expectedProof, buildBoxPnlDayProof(docs));
  try {
    await args.settle();
    if (!matches(await args.load())) throw new Error("day content changed before completion proof publication");
    await args.publish(expectedProof);
    if (!matches(await args.load())) throw new Error("day content changed while publishing completion proof");
    return expectedProof;
  } catch (err) {
    await args.invalidate();
    throw err;
  }
}

export async function runBoxPnlDayProofRepair(args: {
  lastExactProof: BoxPnlDayProof;
  expectedRowCount: number;
  settle: () => Promise<void>;
  load: () => Promise<IBoxDailyPnl[]>;
  validate: (docs: IBoxDailyPnl[]) => Promise<void>;
  publish: (lastExactProof: BoxPnlDayProof, nextProof: BoxPnlDayProof) => Promise<void>;
  markRetry: () => Promise<void>;
}): Promise<BoxPnlDayProof> {
  const loadValid = async (requireSummary: boolean): Promise<{ docs: IBoxDailyPnl[]; proof: BoxPnlDayProof }> => {
    const docs = await args.load();
    await args.validate(docs);
    const proof = buildBoxPnlDayProof(docs);
    if (proof.row_count !== args.expectedRowCount) {
      throw new Error(`day membership count ${proof.row_count} differs from last exact row_count ${args.expectedRowCount}`);
    }
    if (requireSummary && !boxPnlSummaryMatchesRows(docs)) {
      throw new Error("day summary does not match rows during re-proof");
    }
    return { docs, proof };
  };
  try {
    await loadValid(false);
    await args.settle();
    const before = await loadValid(true);
    await args.publish(args.lastExactProof, before.proof);
    const after = await loadValid(true);
    if (!boxPnlDayProofsEqual(before.proof, after.proof)) {
      throw new Error("day content changed while publishing repaired proof");
    }
    return after.proof;
  } catch (err) {
    await args.markRetry();
    throw err;
  }
}

export async function runLegacyBoxPnlDayMigration(args: {
  expectedTradeIds: unknown;
  settleAndLoad: () => Promise<IBoxDailyPnl[]>;
  filterSourceValidExpectedIds: (ids: string[]) => Promise<string[]>;
  publishV2: (docs: IBoxDailyPnl[]) => Promise<void>;
  loadPublished: () => Promise<{
    docs: IBoxDailyPnl[];
    state: { snapshot_version?: number; row_count?: number; content_sha256?: string } | null;
  }>;
  finalizeV2: (proof: BoxPnlDayProof) => Promise<void>;
  markRetry: () => Promise<void>;
}): Promise<boolean> {
  try {
    if (!Array.isArray(args.expectedTradeIds) ||
        args.expectedTradeIds.some((id) => typeof id !== "string" || id.length === 0 || id === SUMMARY_FIELD) ||
        new Set(args.expectedTradeIds).size !== args.expectedTradeIds.length) {
      throw new Error("legacy day manifest contains invalid or duplicate trade ids");
    }
    const expectedIds = args.expectedTradeIds as string[];
    const sourceValidExpected = [...new Set(await args.filterSourceValidExpectedIds(expectedIds))].sort();
    const settled = await args.settleAndLoad();
    const settledIds = settled.filter((doc) => doc.trade_id !== SUMMARY_FIELD).map((doc) => doc.trade_id).sort();
    if (new Set(settledIds).size !== settledIds.length ||
        settledIds.length !== sourceValidExpected.length ||
        settledIds.some((id, index) => id !== sourceValidExpected[index]) ||
        !boxPnlSummaryMatchesRows(settled)) {
      throw new Error("source-valid durable rows do not match the legacy day manifest");
    }
    await args.publishV2(settled);
    const published = await args.loadPublished();
    const proof = published.state ? boxPnlDayProofFromState(published.state) : null;
    if (proof === null || !boxPnlSummaryMatchesRows(published.docs) ||
        !boxPnlDayProofsEqual(proof, buildBoxPnlDayProof(published.docs))) {
      throw new Error("v2 day proof did not remain stable after publication");
    }
    await args.finalizeV2(proof);
    return true;
  } catch {
    await args.markRetry();
    return false;
  }
}

/* -- pg-specific archive implementations that DRIVE the run* protocols above. -- */

async function scanDurablePnlDay(day: string): Promise<{
  proof: BoxPnlDayProof;
  summary: ReturnType<BoxPnlDayProofBuilder["finish"]>["summary"];
  invalidTradeIds: string[];
}> {
  const builder = new BoxPnlDayProofBuilder(day);
  let afterTradeId = "";
  const invalidTradeIds = new Set<string>();
  while (true) {
    const { rows } = await query(
      `SELECT * FROM box_daily_pnl
       WHERE day = $1 AND trade_id <> $2 AND ($3 = '' OR trade_id > $3)
       ORDER BY trade_id ASC LIMIT $4`,
      [day, SUMMARY_FIELD, afterTradeId, PNL_SCAN_PAGE],
    );
    if (rows.length === 0) break;
    afterTradeId = rows.at(-1)!.trade_id as string;
    const docs = rows.map(rowToDailyPnl);
    const invalid = await invalidArchivedTradeIds(docs.map((d) => d.trade_id));
    invalid.forEach((tradeId) => invalidTradeIds.add(tradeId));
    const invalidSet = new Set(invalid);
    for (const doc of docs) if (!invalidSet.has(doc.trade_id)) builder.add(doc);
    if (rows.length < PNL_SCAN_PAGE) break;
  }
  return { ...builder.finish(new Date().toISOString()), invalidTradeIds: [...invalidTradeIds] };
}

async function mutateDurablePnlDay<T>(day: string, mutate: () => Promise<T>): Promise<T> {
  return runBoxPnlDayMutation({ invalidate: () => markBoxDailyPnlIncomplete(day, true), mutate });
}

export async function rewriteBoxDailyPnlSummary(day: string): Promise<BoxPnlDayProof> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await scanDurablePnlDay(day);
    if (before.invalidTradeIds.length > 0) {
      throw new Error(`box_daily_pnl day ${day} contained an invalid source row`);
    }
    await mutateDurablePnlDay(day, async () => {
      await query(
        `INSERT INTO box_daily_pnl (day, trade_id, status, summary, updated_at, archived_at)
         VALUES ($1, $2, 'summary', $3::jsonb, $4, now())
         ON CONFLICT (day, trade_id) DO UPDATE
         SET status = 'summary', summary = $3::jsonb, updated_at = $4, archived_at = now()`,
        [day, SUMMARY_FIELD, jsonb(before.summary), before.summary.updated_at],
      );
    });
    const after = await scanDurablePnlDay(day);
    if (after.invalidTradeIds.length === 0 && boxPnlDayProofsEqual(before.proof, after.proof)) {
      return after.proof;
    }
  }
  throw new Error(`box_daily_pnl summary for ${day} did not settle after concurrent mutations`);
}

async function loadDayState(day: string): Promise<{
  complete?: boolean; needs_reproof?: boolean; snapshot_version?: number;
  row_count?: number; content_sha256?: string; expected_trade_ids?: string[];
} | null> {
  const { rows } = await query(`SELECT * FROM box_pnl_day_states WHERE day = $1`, [day]);
  const row = rows[0];
  if (!row) return null;
  // Build without ever assigning `undefined` to an optional property, so the shape
  // stays assignable to the frozen consumers under exactOptionalPropertyTypes.
  const out: {
    complete?: boolean; needs_reproof?: boolean; snapshot_version?: number;
    row_count?: number; content_sha256?: string; expected_trade_ids?: string[];
  } = {};
  if (row.complete !== null && row.complete !== undefined) out.complete = row.complete as boolean;
  if (row.needs_reproof !== null && row.needs_reproof !== undefined) out.needs_reproof = row.needs_reproof as boolean;
  if (row.snapshot_version !== null && row.snapshot_version !== undefined) out.snapshot_version = num(row.snapshot_version);
  if (row.row_count !== null && row.row_count !== undefined) out.row_count = num(row.row_count);
  if (row.content_sha256 !== null && row.content_sha256 !== undefined) out.content_sha256 = row.content_sha256 as string;
  if (Array.isArray(row.expected_trade_ids)) out.expected_trade_ids = row.expected_trade_ids as string[];
  return out;
}

async function reproveBoxDailyPnlFromDurable(day: string, expectedRowCount?: number): Promise<void> {
  const state = await loadDayState(day);
  const lastExactProof = state ? boxPnlDayProofFromState(state) : null;
  if (!lastExactProof) {
    await markBoxDailyPnlIncomplete(day, true);
    throw new Error(`box_daily_pnl day ${day} has no last exact v2 proof`);
  }
  let retryProof = lastExactProof;
  await runBoxPnlDayProofRepair({
    lastExactProof,
    expectedRowCount: expectedRowCount ?? lastExactProof.row_count,
    settle: async () => { await rewriteBoxDailyPnlSummary(day); },
    load: () => loadBoxDailyPnlSnapshot(day),
    validate: async (docs) => {
      const ids = docs.filter((doc) => doc.trade_id !== SUMMARY_FIELD).map((doc) => doc.trade_id);
      if ((await invalidArchivedTradeIds(ids)).length > 0) {
        throw new Error(`box_daily_pnl day ${day} contained an invalid source row`);
      }
    },
    publish: async (priorProof, nextProof) => {
      const { rowCount } = await query(
        `UPDATE box_pnl_day_states
         SET complete = true, needs_reproof = false, snapshot_version = $5, row_count = $6,
             content_sha256 = $7, expected_trade_ids = NULL, updated_at = now()
         WHERE day = $1 AND snapshot_version = $2 AND row_count = $3 AND content_sha256 = $4`,
        [day, priorProof.snapshot_version, priorProof.row_count, priorProof.content_sha256,
         nextProof.snapshot_version, nextProof.row_count, nextProof.content_sha256],
      );
      if ((rowCount ?? 0) !== 1) throw new Error(`box_daily_pnl day ${day} changed before re-proof publication`);
      retryProof = nextProof;
    },
    markRetry: () => markBoxDailyPnlRetryIfProof(day, retryProof),
  });
}

async function migrateLegacyBoxDailyPnlState(day: string, expectedTradeIds: unknown): Promise<boolean> {
  return runLegacyBoxPnlDayMigration({
    expectedTradeIds,
    filterSourceValidExpectedIds: async (ids) => {
      const invalid = new Set(await invalidArchivedTradeIds(ids));
      return ids.filter((id) => !invalid.has(id));
    },
    settleAndLoad: async () => {
      await rewriteBoxDailyPnlSummary(day);
      return loadBoxDailyPnlSnapshot(day);
    },
    publishV2: async (docs) => {
      const ids = docs.filter((doc) => doc.trade_id !== SUMMARY_FIELD).map((doc) => doc.trade_id);
      if ((await invalidArchivedTradeIds(ids)).length > 0) {
        throw new Error(`box_daily_pnl legacy day ${day} changed during source validation`);
      }
      const proof = buildBoxPnlDayProof(docs);
      await query(
        `UPDATE box_pnl_day_states
         SET complete = true, needs_reproof = false, snapshot_version = $2, row_count = $3,
             content_sha256 = $4, updated_at = now()
         WHERE day = $1 AND expected_trade_ids IS NOT NULL`,
        [day, proof.snapshot_version, proof.row_count, proof.content_sha256],
      );
    },
    loadPublished: async () => ({ docs: await loadBoxDailyPnlSnapshot(day), state: await loadDayState(day) }),
    finalizeV2: async (proof) => {
      const { rowCount } = await query(
        `UPDATE box_pnl_day_states SET expected_trade_ids = NULL
         WHERE day = $1 AND snapshot_version = $2 AND row_count = $3 AND content_sha256 = $4
           AND expected_trade_ids IS NOT NULL`,
        [day, proof.snapshot_version, proof.row_count, proof.content_sha256],
      );
      if ((rowCount ?? 0) !== 1) throw new Error(`box_daily_pnl legacy day ${day} changed before migration finalization`);
    },
    markRetry: async () => {
      await query(
        `UPDATE box_pnl_day_states SET needs_reproof = true, updated_at = now()
         WHERE day = $1 AND expected_trade_ids IS NOT NULL`,
        [day],
      );
    },
  });
}

/**
 * Install the durable reporting-cleanup fence before removing the source trade.
 */
export async function prepareBoxPnlDeletion(tradeId: string, candidateDays: string[] = []): Promise<void> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  await query(
    `INSERT INTO box_pnl_deletions (trade_id, status, attempts, created_at, updated_at, completed_at, candidate_days, last_error)
     VALUES ($1, 'pending', 0, now(), now(), NULL, '[]'::jsonb, NULL)
     ON CONFLICT (trade_id) DO UPDATE SET updated_at = now(), last_error = NULL`,
    [tradeId],
  );
  const candidates = [...new Set(candidateDays.slice(-MAX_DELETION_CANDIDATE_DAYS).filter(Boolean))].sort();
  if (candidates.length > 0) {
    const { rows } = await query<{ candidate_days: string[] }>(
      `SELECT candidate_days FROM box_pnl_deletions WHERE trade_id = $1`, [tradeId]);
    const merged = [...new Set([...(rows[0]?.candidate_days ?? []), ...candidates])].sort().slice(-MAX_DELETION_CANDIDATE_DAYS);
    await query(`UPDATE box_pnl_deletions SET candidate_days = $2::jsonb WHERE trade_id = $1`, [tradeId, jsonb(merged)]);
  }
}

/** Remove a prepared fence only when the guarded source delete did not happen. */
export async function cancelBoxPnlDeletion(tradeId: string): Promise<void> {
  if (!isBoxDbEnabled()) return;
  await query(`DELETE FROM box_pnl_deletions WHERE trade_id = $1 AND status = 'pending'`, [tradeId]);
}

async function recordBoxPnlDeletionFailure(tradeId: string, err: unknown): Promise<void> {
  await query(
    `UPDATE box_pnl_deletions SET updated_at = now(), last_error = $2, attempts = attempts + 1
     WHERE trade_id = $1 AND status = 'pending'`,
    [tradeId, err instanceof Error ? err.message : String(err)],
  ).catch(() => undefined);
}

/**
 * Drop a trade's rows from the daily-P&L archive and rebuild affected summaries. The
 * durable intent remains pending on any error and is retried at startup.
 */
export async function deleteBoxDailyPnlForTrade(tradeId: string, cacheDays: string[] = []): Promise<number> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  await prepareBoxPnlDeletion(tradeId, cacheDays);
  let deleted = 0;
  try {
    const intent = (await query<{ candidate_days: string[] }>(
      `SELECT candidate_days FROM box_pnl_deletions WHERE trade_id = $1`, [tradeId])).rows[0];
    const candidateDays = [...new Set([
      ...cacheDays.slice(-MAX_DELETION_CANDIDATE_DAYS),
      ...((intent?.candidate_days ?? []).slice(-MAX_DELETION_CANDIDATE_DAYS)),
    ].filter(Boolean))].sort().slice(-MAX_DELETION_CANDIDATE_DAYS);

    const cleanDay = async (day: string): Promise<void> => {
      const state = await loadDayState(day);
      const survivors = await scanDurablePnlDay(day);
      const result = await mutateDurablePnlDay(day, () =>
        query(`DELETE FROM box_daily_pnl WHERE day = $1 AND trade_id = $2`, [day, tradeId]));
      deleted += result.rowCount ?? 0;
      if (Array.isArray(state?.expected_trade_ids)) {
        const migrated = await migrateLegacyBoxDailyPnlState(day, state.expected_trade_ids);
        if (!migrated) throw new Error(`box_daily_pnl legacy day ${day} could not be migrated after cleanup`);
      } else if (shouldReproveBoxPnlDay(state)) {
        await reproveBoxDailyPnlFromDurable(day, survivors.proof.row_count);
      } else {
        await rewriteBoxDailyPnlSummary(day);
      }
    };

    for (const day of candidateDays) await cleanDay(day);

    while (true) {
      const { rows } = await query<{ day: string }>(
        `SELECT DISTINCT day FROM box_daily_pnl WHERE trade_id = $1 LIMIT $2`, [tradeId, PNL_SCAN_PAGE]);
      if (rows.length === 0) break;
      for (const day of [...new Set(rows.map((r) => r.day))]) await cleanDay(day);
    }

    await query(
      `UPDATE box_pnl_deletions
       SET status = 'complete', candidate_days = $2::jsonb, updated_at = now(),
           completed_at = now(), last_error = NULL, attempts = attempts + 1
       WHERE trade_id = $1`,
      [tradeId, jsonb(candidateDays)],
    );
    return deleted;
  } catch (err) {
    await query(
      `UPDATE box_pnl_deletions SET status = 'pending', updated_at = now(), last_error = $2, attempts = attempts + 1
       WHERE trade_id = $1`,
      [tradeId, err instanceof Error ? err.message : String(err)],
    ).catch(() => undefined);
    throw err;
  }
}

async function repairBoxDailyPnlV2Day(day: string): Promise<number> {
  let repaired = 0;
  let scanned = await scanDurablePnlDay(day);
  if (scanned.invalidTradeIds.length > 0) {
    for (const tradeId of scanned.invalidTradeIds) repaired += await deleteBoxDailyPnlForTrade(tradeId);
    scanned = await scanDurablePnlDay(day);
    if (scanned.invalidTradeIds.length > 0) {
      throw new Error(`box_daily_pnl day ${day} retained invalid source rows after cleanup`);
    }
  }
  const state = await loadDayState(day);
  const lastExactProof = state ? boxPnlDayProofFromState(state) : null;
  if (!lastExactProof) {
    await markBoxDailyPnlIncomplete(day, true);
    throw new Error(`box_daily_pnl day ${day} has no safe v2 proof to repair from`);
  }
  const storedSummary = (await query<{ summary: BoxDailyPnlRecord["summary"] }>(
    `SELECT summary FROM box_daily_pnl WHERE day = $1 AND trade_id = $2`, [day, SUMMARY_FIELD])).rows[0];
  const contentMatches = boxPnlDayProofsEqual(lastExactProof, scanned.proof);
  const summaryMatches = Boolean(storedSummary?.summary && boxPnlSummariesEqual(storedSummary.summary, scanned.summary));
  if (state?.complete === true && state.needs_reproof !== true && contentMatches && summaryMatches) return repaired;
  await reproveBoxDailyPnlFromDurable(day, lastExactProof.row_count);
  return repaired + 1;
}

/** Restart repair: finish pending intents, then page legacy/crash archive rows. */
export async function reconcileBoxDailyPnlOrphans(): Promise<number> {
  if (!isBoxDbEnabled()) return 0;
  let repaired = 0;
  let failureCount = 0;
  const errors: Error[] = [];
  const record = (result: BoxPnlIndependentRepairResult): void => {
    repaired += result.repaired;
    failureCount += result.failureCount;
    const available = Math.max(0, 20 - errors.length);
    errors.push(...result.errors.slice(0, available));
  };

  let pendingAfter = "";
  while (true) {
    const { rows: pending } = await query<{ trade_id: string; candidate_days: string[] }>(
      `SELECT trade_id, candidate_days FROM box_pnl_deletions
       WHERE status = 'pending' AND ($1 = '' OR trade_id > $1)
       ORDER BY trade_id ASC LIMIT $2`, [pendingAfter, PNL_SCAN_PAGE]);
    if (pending.length === 0) break;
    pendingAfter = String(pending.at(-1)!.trade_id);
    record(await runIndependentBoxPnlRepairs({
      scope: "pending P&L deletion",
      items: pending,
      identify: (intent) => String(intent.trade_id),
      repair: async (intent) => {
        const tradeId = String(intent.trade_id);
        let sourceStillExists: boolean;
        try {
          sourceStillExists = isValidBoxId(tradeId)
            ? (await query(`SELECT 1 FROM box_trades WHERE id = $1`, [tradeId])).rowCount! > 0
            : false;
        } catch (err) {
          await recordBoxPnlDeletionFailure(tradeId, err);
          throw err;
        }
        if (sourceStillExists) {
          try { await cancelBoxPnlDeletion(tradeId); } catch (err) { await recordBoxPnlDeletionFailure(tradeId, err); throw err; }
          return 0;
        }
        return deleteBoxDailyPnlForTrade(tradeId, (intent.candidate_days ?? []).slice(-MAX_DELETION_CANDIDATE_DAYS));
      },
    }));
    if (pending.length < PNL_SCAN_PAGE) break;
  }

  let archiveAfter = "";
  while (true) {
    const { rows } = await query<{ trade_id: string }>(
      `SELECT DISTINCT trade_id FROM box_daily_pnl
       WHERE trade_id <> $1 AND ($2 = '' OR trade_id > $2)
       ORDER BY trade_id ASC LIMIT $3`, [SUMMARY_FIELD, archiveAfter, PNL_SCAN_PAGE]);
    if (rows.length === 0) break;
    archiveAfter = String(rows.at(-1)!.trade_id);
    const invalid = [...new Set(await invalidArchivedTradeIds(rows.map((r) => r.trade_id)))];
    record(await runIndependentBoxPnlRepairs({
      scope: "orphan P&L archive trade",
      items: invalid,
      identify: (tradeId) => tradeId,
      repair: async (tradeId) => { await prepareBoxPnlDeletion(tradeId); return deleteBoxDailyPnlForTrade(tradeId); },
    }));
    if (rows.length < PNL_SCAN_PAGE) break;
  }

  let v2After = "";
  while (true) {
    const { rows: states } = await query<{ day: string }>(
      `SELECT day FROM box_pnl_day_states
       WHERE expected_trade_ids IS NULL AND snapshot_version = 2
         AND (complete = true OR needs_reproof = true) AND ($1 = '' OR day > $1)
       ORDER BY day ASC LIMIT $2`, [v2After, PNL_SCAN_PAGE]);
    if (states.length === 0) break;
    v2After = String(states.at(-1)!.day);
    record(await runIndependentBoxPnlRepairs({
      scope: "v2 P&L day repair",
      items: states,
      identify: (state) => String(state.day),
      repair: (state) => repairBoxDailyPnlV2Day(String(state.day)),
    }));
    if (states.length < PNL_SCAN_PAGE) break;
  }

  let legacyAfter = "";
  while (true) {
    const { rows: states } = await query<{ day: string; expected_trade_ids: string[] }>(
      `SELECT day, expected_trade_ids FROM box_pnl_day_states
       WHERE expected_trade_ids IS NOT NULL AND (complete = true OR needs_reproof = true)
         AND ($1 = '' OR day > $1)
       ORDER BY day ASC LIMIT $2`, [legacyAfter, PNL_SCAN_PAGE]);
    if (states.length === 0) break;
    legacyAfter = String(states.at(-1)!.day);
    record(await runIndependentBoxPnlRepairs({
      scope: "legacy P&L day migration",
      items: states,
      identify: (state) => String(state.day),
      repair: async (state) => {
        const migrated = await migrateLegacyBoxDailyPnlState(String(state.day), state.expected_trade_ids);
        if (!migrated) throw new Error("durable rows did not safely match the legacy manifest");
        return 1;
      },
    }));
    if (states.length < PNL_SCAN_PAGE) break;
  }

  if (failureCount > 0) {
    throw new AggregateError(errors,
      `Box P&L reconciliation completed independent work with ${failureCount} failure(s) and ${repaired} repair(s)`);
  }
  return repaired;
}

/** Delete exact extra day rows before verify rewrites the aggregate. */
export async function deleteBoxDailyPnlRows(day: string, tradeIds: string[]): Promise<number> {
  if (!isBoxDbEnabled() || tradeIds.length === 0) return 0;
  let deleted = 0;
  for (const batch of chunks([...new Set(tradeIds)])) {
    const result = await mutateDurablePnlDay(day, () =>
      query(`DELETE FROM box_daily_pnl WHERE day = $1 AND trade_id = ANY($2::text[])`, [day, batch]));
    deleted += result.rowCount ?? 0;
  }
  return deleted;
}

/** Commit a fixed-size exact-content proof after rows and summary settle. */
export async function markBoxDailyPnlComplete(day: string, expectedDocs: IBoxDailyPnl[]): Promise<void> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  const expectedIds = expectedDocs.filter((doc) => doc.trade_id !== SUMMARY_FIELD).map((doc) => doc.trade_id);
  if ((await invalidArchivedTradeIds(expectedIds)).length > 0) {
    await markBoxDailyPnlIncomplete(day, true);
    throw new Error(`box_daily_pnl day ${day} contains a deleted source row`);
  }
  await runBoxPnlDayProofCommit({
    expected: expectedDocs,
    settle: async () => { await rewriteBoxDailyPnlSummary(day); },
    load: async () => {
      const docs = await loadBoxDailyPnlSnapshot(day);
      const ids = docs.filter((doc) => doc.trade_id !== SUMMARY_FIELD).map((doc) => doc.trade_id);
      if ((await invalidArchivedTradeIds(ids)).length > 0) {
        throw new Error(`box_daily_pnl day ${day} changed during source validation`);
      }
      return docs;
    },
    publish: async (proof) => {
      await query(
        `INSERT INTO box_pnl_day_states (day, complete, needs_reproof, snapshot_version, row_count, content_sha256, expected_trade_ids, updated_at)
         VALUES ($1, true, false, $2, $3, $4, NULL, now())
         ON CONFLICT (day) DO UPDATE
         SET complete = true, needs_reproof = false, snapshot_version = $2, row_count = $3,
             content_sha256 = $4, expected_trade_ids = NULL, updated_at = now()`,
        [day, proof.snapshot_version, proof.row_count, proof.content_sha256],
      );
    },
    invalidate: () => markBoxDailyPnlIncomplete(day, true),
  });
}

/** Validate a durable day generation, migrating a complete legacy manifest safely. */
export async function isBoxDailyPnlSnapshotComplete(day: string, docs: IBoxDailyPnl[]): Promise<boolean> {
  if (!isBoxDbEnabled()) return false;
  const state = await loadDayState(day);
  if (!state?.complete) return false;
  const proof = boxPnlDayProofFromState(state);
  if (!proof) {
    if (Array.isArray(state.expected_trade_ids)) {
      return migrateLegacyBoxDailyPnlState(day, state.expected_trade_ids);
    }
    await markBoxDailyPnlIncomplete(day);
    return false;
  }
  const matches = boxPnlSummaryMatchesRows(docs) && boxPnlDayProofsEqual(proof, buildBoxPnlDayProof(docs));
  if (!matches) await markBoxDailyPnlRetryIfProof(day, proof);
  return matches;
}

/** Upsert one archived P&L row with a durable source-existence handshake. */
export async function upsertBoxDailyPnl(doc: IBoxDailyPnl): Promise<void> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  if (doc.trade_id === SUMMARY_FIELD) {
    await rewriteBoxDailyPnlSummary(doc.day);
    return;
  }
  const allowed = async () => (await invalidArchivedTradeIds([doc.trade_id])).length === 0;
  await runSourceSafePnlRowUpsert({
    allowed,
    write: async () => {
      await mutateDurablePnlDay(doc.day, async () => { await upsertDailyPnlRow(doc); });
    },
    remove: async () => {
      await mutateDurablePnlDay(doc.day, async () => {
        await query(`DELETE FROM box_daily_pnl WHERE day = $1 AND trade_id = $2`, [doc.day, doc.trade_id]);
      });
    },
    rewriteSummary: async () => { await rewriteBoxDailyPnlSummary(doc.day); },
  });
}

/**
 * Write one daily-P&L row AND its Mongo projection, in one transaction.
 *
 * THE PROJECTION WAS MISSING. `box_daily_pnl` is an allow-listed outbox aggregate
 * (`src/outbox/writer.ts`), is collection-mapped in `src/outbox/mongo.ts`, and is
 * documented as projected in `docs/MONGO_PROJECTION.md` — but no code path ever enqueued
 * it, so daily P&L never reached the reporting replica at all. The only writer of that
 * Mongo collection was the legacy import. Nothing failed and no test noticed, because
 * PostgreSQL (the authority) was always correct: the loss was silent and would only have
 * surfaced later as unanalysable history.
 *
 * A P&L row is a SNAPSHOT, not an event — it is rewritten as net P&L moves — so it uses
 * `enqueueOutboxSnapshot`, giving exactly one Mongo document per (day, trade_id) that
 * carries the latest figures. See that function for why a plain event enqueue would have
 * frozen the replica at the first value it saw.
 */
async function upsertDailyPnlRow(doc: IBoxDailyPnl): Promise<void> {
  await withTx(async (client) => {
    await client.query(
      `INSERT INTO box_daily_pnl
       (day, trade_id, underlying, direction, lower_strike, upper_strike, expiry, status,
        gross_pnl, net_pnl, realisable_net_pnl, realised_net_pnl, opened_at, closed_at, updated_at,
        summary, archived_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb, now())
     ON CONFLICT (day, trade_id) DO UPDATE SET
       underlying = EXCLUDED.underlying, direction = EXCLUDED.direction,
       lower_strike = EXCLUDED.lower_strike, upper_strike = EXCLUDED.upper_strike,
       expiry = EXCLUDED.expiry, status = EXCLUDED.status, gross_pnl = EXCLUDED.gross_pnl,
       net_pnl = EXCLUDED.net_pnl, realisable_net_pnl = EXCLUDED.realisable_net_pnl,
       realised_net_pnl = EXCLUDED.realised_net_pnl, opened_at = EXCLUDED.opened_at,
       closed_at = EXCLUDED.closed_at, updated_at = EXCLUDED.updated_at,
       summary = EXCLUDED.summary, archived_at = now()`,
      [
        doc.day, doc.trade_id, doc.underlying ?? "", doc.direction ?? "LONG_BOX",
        doc.lower_strike ?? 0, doc.upper_strike ?? 0, doc.expiry ?? "", doc.status ?? "open",
        doc.gross_pnl ?? null, doc.net_pnl ?? null, doc.realisable_net_pnl ?? null,
        doc.realised_net_pnl ?? null, doc.opened_at ?? null, doc.closed_at ?? null,
        doc.updated_at ?? null, jsonb(doc.summary ?? null),
      ],
    );

    // Same transaction as the operational write: the projection intent and the fact it
    // describes are either both durable or neither is.
    await enqueueOutboxSnapshot(client, {
      // Stable, so Mongo holds ONE document per trade per day, overwritten in place.
      eventId: `box_daily_pnl:${doc.day}:${doc.trade_id}`,
      aggregateType: "box_daily_pnl",
      aggregateId: `${doc.day}:${doc.trade_id}`,
      eventType: "daily_pnl_snapshot",
      schemaVersion: BOX_PROJECTION_SCHEMA_VERSION,
      payload: {
        ...doc,
        source_id: `${doc.day}:${doc.trade_id}`,
        day: doc.day,
        trade_id: doc.trade_id,
        projection_schema_version: BOX_PROJECTION_SCHEMA_VERSION,
      },
    });
  });
}

/** The persisted documents for an exact day. Errors deliberately propagate. */
export async function loadBoxDailyPnlSnapshot(day: string): Promise<BoxDailyPnlRecord[]> {
  if (!isBoxDbEnabled()) throw new Error("Box persistence is not available.");
  const { rows } = await query(`SELECT * FROM box_daily_pnl WHERE day = $1`, [day]);
  return rows.map(rowToDailyPnl);
}

export async function loadBoxDailyPnlTradeIds(day: string): Promise<string[]> {
  const rows = await loadBoxDailyPnlSnapshot(day);
  return rows.map((row) => row.trade_id);
}

export async function loadBoxDailyPnl(day: string): Promise<BoxDailyPnlRecord[]> {
  if (!isBoxDbEnabled()) return [];
  try {
    const { rows } = await query(`SELECT * FROM box_daily_pnl WHERE day = $1`, [day]);
    return rows.map(rowToDailyPnl);
  } catch {
    return [];
  }
}

/* ------------------------------ box settings ------------------------------ */

export async function loadBoxSettings(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!isBoxDbEnabled()) return out;
  try {
    const { rows } = await query<{ key: string; value: unknown }>(`SELECT key, value FROM box_settings`);
    for (const row of rows) {
      const value = num(row.value);
      if (Number.isFinite(value)) out.set(row.key, value);
    }
  } catch (err) {
    console.warn("[Box] failed to load persisted settings:", err);
  }
  return out;
}

/**
 * Upsert admin thresholds in ONE transaction (like the predecessor codebase's bulkWrite): a partial
 * failure must not leave "what was saved" and "what is running" diverging. Throws on
 * failure — this write is NOT best-effort.
 */
export async function saveBoxSettings(entries: Map<string, number>): Promise<void> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is not configured, so settings cannot be saved.");
  }
  if (entries.size === 0) return;
  await withTx(async (client) => {
    for (const [key, value] of entries) {
      await client.query(
        `INSERT INTO box_settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [key, value],
      );
    }
  });
}

/* --------------------------- durable trading session --------------------------- */

const TRADING_SESSION_ID = "current";

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((id): id is string => typeof id === "string");
}

export async function loadBoxTradingSession(): Promise<
  { ok: true; record: BoxSessionRecord | null } | { ok: false; error: string }
> {
  if (!isBoxDbEnabled()) {
    return { ok: false, error: "Box persistence is not configured, so session state cannot be read." };
  }
  try {
    const { rows } = await query(`SELECT * FROM box_trading_session WHERE id = $1`, [TRADING_SESSION_ID]);
    const row = rows[0];
    if (!row) return { ok: true, record: null };
    const armedAt = asDate(row.armed_at);
    const updatedAt = asDate(row.updated_at);
    return {
      ok: true,
      record: {
        session_id: typeof row.session_id === "string" ? row.session_id : "",
        armed_at: armedAt ? armedAt.getTime() : null,
        armed_by: (row.armed_by as string | null) ?? null,
        max_completed_trades: Number.isFinite(num(row.max_completed_trades)) ? num(row.max_completed_trades) : 0,
        established_trade_ids: stringIds(row.established_trade_ids),
        completed_trade_ids: stringIds(row.completed_trade_ids),
        aborted_attempts: Number.isFinite(num(row.aborted_attempts)) ? num(row.aborted_attempts) : 0,
        // ATTEMPT BUDGET (migration 010). A row written before that migration has NULL here, and
        // `num(null)` is not finite, so both default to 0 — "unbounded ceiling, none spent", the only
        // safe reading: inventing a ceiling the operator never armed under would refuse entry they
        // legitimately authorised, and inventing spent attempts would do the same.
        entry_attempts: Number.isFinite(num(row.entry_attempts)) ? num(row.entry_attempts) : 0,
        max_entry_attempts: Number.isFinite(num(row.max_entry_attempts)) ? num(row.max_entry_attempts) : 0,
        arm_count: Number.isFinite(num(row.arm_count)) ? num(row.arm_count) : 0,
        updated_at: updatedAt ? updatedAt.getTime() : 0,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Persist the trading-session record. THROWS on failure, deliberately. */
/** A non-negative integer, defaulting a missing/hostile value to 0. Never NaN, never null. */
function nonNegativeInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export async function saveBoxTradingSession(record: BoxSessionRecord): Promise<void> {
  if (!isBoxDbEnabled()) {
    throw new Error("Box persistence is not configured, so session state cannot be saved.");
  }
  await query(
    `INSERT INTO box_trading_session
       (id, session_id, armed_at, armed_by, max_completed_trades, established_trade_ids,
        completed_trade_ids, aborted_attempts, arm_count, updated_at,
        entry_attempts, max_entry_attempts)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO UPDATE SET
       session_id = $2, armed_at = $3, armed_by = $4, max_completed_trades = $5,
       established_trade_ids = $6::jsonb, completed_trade_ids = $7::jsonb,
       aborted_attempts = $8, arm_count = $9, updated_at = $10,
       entry_attempts = $11, max_entry_attempts = $12`,
    [
      TRADING_SESSION_ID, record.session_id,
      record.armed_at === null ? null : new Date(record.armed_at), record.armed_by,
      record.max_completed_trades, jsonb([...record.established_trade_ids]),
      jsonb([...record.completed_trade_ids]), record.aborted_attempts, record.arm_count,
      new Date(record.updated_at),
      // The ATTEMPT budget must round-trip, or a restart would hand it back — which is exactly the
      // "restart for another attempt" hole the budget exists to close.
      //
      // COERCED, symmetrically with the defaulting on read above. A record built by an older caller
      // (or by hand) carries `undefined` here, which `pg` sends as NULL and the NOT NULL constraint
      // then rejects — turning a missing optional field into a failed WRITE, which for a consumption
      // write means entry closes until it lands. Defaulting to 0 on the way out as well as on the way
      // in keeps a partial record saveable without ever inventing spent attempts.
      nonNegativeInt(record.entry_attempts), nonNegativeInt(record.max_entry_attempts),
    ],
  );
}

/* ------------------- execution-latency calibration samples ------------------- */

export async function persistBoxCalibrationSamples(
  batch: readonly {
    broker: string; kind: string; profile: string; bucket: string; stage: string;
    valueMs: number; session?: string | undefined; atWall: number;
  }[],
  region: string | null,
): Promise<void> {
  if (!isBoxDbEnabled() || batch.length === 0) return;
  await withTx(async (client) => {
    for (const sample of batch) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO box_calibration_samples (broker, kind, profile, bucket, stage, value_ms, session, region, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [sample.broker, sample.kind, sample.profile, sample.bucket, sample.stage,
         round2Repo(sample.valueMs), sample.session ?? "", region, new Date(sample.atWall)],
      );
      const sampleId = String(rows[0]!.id);
      await enqueueOutbox(client, {
        eventId: `box_calibration_sample:${sampleId}`,
        aggregateType: "box_calibration_sample",
        aggregateId: sampleId,
        eventType: "calibration_sample",
        schemaVersion: BOX_PROJECTION_SCHEMA_VERSION,
        payload: {
          source_id: sampleId,
          broker: sample.broker, kind: sample.kind, profile: sample.profile, bucket: sample.bucket,
          stage: sample.stage, value_ms: round2Repo(sample.valueMs), session: sample.session ?? "",
          region, observed_at: new Date(sample.atWall).toISOString(),
          projection_schema_version: BOX_PROJECTION_SCHEMA_VERSION,
        },
      });
    }
  });
}

export async function loadBoxCalibrationSamples(args: {
  region: string | null;
  maxAgeMs: number;
  limit?: number;
}): Promise<Array<{
  broker: string; kind: string; profile: string; bucket: string; stage: string;
  valueMs: number; session: string; atWall: number;
}>> {
  if (!isBoxDbEnabled()) return [];
  const cutoff = new Date(Date.now() - Math.max(0, args.maxAgeMs));
  const limit = Math.max(1, Math.floor(args.limit ?? 50_000));
  const { rows } = args.region === null
    ? await query(
        `SELECT * FROM box_calibration_samples WHERE region IS NULL AND observed_at >= $1
         ORDER BY observed_at ASC LIMIT $2`, [cutoff, limit])
    : await query(
        `SELECT * FROM box_calibration_samples WHERE region = $1 AND observed_at >= $2
         ORDER BY observed_at ASC LIMIT $3`, [args.region, cutoff, limit]);
  return rows.map((row) => ({
    broker: String(row.broker), kind: String(row.kind), profile: String(row.profile),
    bucket: String(row.bucket), stage: String(row.stage), valueMs: num(row.value_ms),
    session: String(row.session ?? ""),
    atWall: row.observed_at instanceof Date ? row.observed_at.getTime() : new Date(row.observed_at as string).getTime(),
  }));
}
