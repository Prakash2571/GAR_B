/**
 * Box persistence TYPES — pure, dependency-free.
 *
 * In CalSpread this file was the Mongoose schema layer: it declared the box_trades /
 * box_trade_events / box_order_intents / box_execution_attempts / box_daily_pnl /
 * box_settings / box_trading_session / box_calibration_samples collections and bound
 * them to a Mongo connection. GTS Box's operational authority is PostgreSQL, so
 * there are no Mongoose models any more. What CALLERS depended on — the record TYPES
 * with an opaque string `_id`, the archive/day-state/settings/session/calibration
 * interfaces, `isBoxEventLedgerEnabled`, and the compile-time proof that the box
 * charge types stay interchangeable with the shared contract-note charge types — is
 * preserved here verbatim in shape.
 *
 * `_id` is an OPAQUE string on every record. `serialize.ts` and the frontend depend
 * on ids being opaque strings (`serialize` only ever calls `_id.toString()`), so the
 * value can be a legacy 24-hex ObjectId string or whatever `allocateBoxTradeId()`
 * mints — nothing downstream may parse it.
 */

import type { ILegCharges, ITradeCharges } from "../types/charges.js";
import { isPgReady } from "../pg/pool.js";
import type {
  BoxCharges,
  BoxLegCharges,
  IBoxExecutionAttempt,
  IBoxOrderIntent,
  IBoxTrade,
  IBoxTradeEvent,
} from "./types.js";
import type { BoxDailyPnlRow, BoxDailyPnlSummary } from "./pnlSnapshot.js";

/**
 * Compile-time proof that the box module's dependency-free charge types stay
 * interchangeable with the shared contract-note charge types (now in
 * `src/types/charges.ts`).
 *
 * The box core declares its own copies so the trading logic pulls in no persistence
 * package, but the numbers must remain the SAME shape the shared Zerodha charge
 * estimator produces. If either side ever drifts, this fails the build instead of
 * silently mis-storing a contract note.
 */
type AssertAssignable<A extends B, B> = A;
type _BoxLegChargesMatch = AssertAssignable<BoxLegCharges, ILegCharges>;
type _CalLegChargesMatch = AssertAssignable<ILegCharges, BoxLegCharges>;
type _BoxChargesMatch = AssertAssignable<BoxCharges, ITradeCharges>;
type _CalChargesMatch = AssertAssignable<ITradeCharges, BoxCharges>;
// Reference the proofs so `noUnusedLocals` does not strip them.
export type _BoxChargeProofs = [
  _BoxLegChargesMatch,
  _CalLegChargesMatch,
  _BoxChargesMatch,
  _CalChargesMatch,
];

/* ------------------------------- trade record ------------------------------ */

/** The mutable box position record (table: box_trades). `_id` is opaque. */
export interface BoxTradeRecord extends IBoxTrade {
  _id: string;
}

/* ------------------------------ order intents ------------------------------ */

/** One durable order intent (table: box_order_intents). `_id` is opaque. */
export interface BoxOrderIntentRecord extends IBoxOrderIntent {
  _id: string;
}

/* -------------------------- execution attempts ----------------------------- */

/** An aborted-execution ledger row (table: box_execution_attempts). `_id` is opaque. */
export interface BoxExecutionAttemptRecord extends IBoxExecutionAttempt {
  _id: string;
}

/* ------------------------------ event ledger ------------------------------ */

/**
 * True once the box event ledger has a durable store to write to.
 *
 * In CalSpread this asked Mongoose whether the box connection's `readyState` was 1.
 * The event ledger is now a PostgreSQL table (box_trade_events) projected onward
 * through the outbox, so "ledger enabled" is "PostgreSQL is configured and ready".
 */
export function isBoxEventLedgerEnabled(): boolean {
  return isPgReady();
}

/* --------------------------- daily P&L archive ---------------------------- */

/**
 * One archived row of a day's box P&L (table: box_daily_pnl).
 *
 * Two record kinds share the table, distinguished by `trade_id`: a per-trade row
 * (real trade id) or the day summary (`trade_id: "__summary__"`, carrying `summary`).
 */
export interface IBoxDailyPnl extends Partial<Omit<BoxDailyPnlRow, "status">> {
  day: string;
  trade_id: string;
  /** "open" / "closed" for a per-trade row, "summary" for the day aggregate. */
  status?: "open" | "closed" | "summary";
  summary?: BoxDailyPnlSummary | null;
  archived_at?: Date;
}

/** A persisted daily-P&L row (table: box_daily_pnl). `_id` is opaque. */
export interface BoxDailyPnlRecord extends IBoxDailyPnl {
  _id: string;
}

/**
 * Durable deletion fence for reporting rows (table: box_pnl_deletions).
 *
 * Pending means only that a source delete was prepared; it does not invalidate a row
 * while the source still exists. Completed fences are retained permanently so late
 * writers cannot resurrect deleted P&L.
 */
export interface IBoxPnlDeletion {
  _id: string;
  status: "pending" | "complete";
  candidate_days: string[];
  attempts: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  last_error: string | null;
}

/**
 * Completion manifest for an exact durable day snapshot (table: box_pnl_day_states).
 * A summary document by itself is not proof of completeness because an incremental
 * drain can fail before a newly discovered row lands.
 */
export interface IBoxPnlDayState {
  _id: string;
  complete: boolean;
  snapshot_version?: number;
  row_count?: number;
  content_sha256?: string;
  needs_reproof?: boolean;
  /** Read-only compatibility with pre-v2 state documents; never written again. */
  expected_trade_ids?: string[];
  updated_at: Date;
}

/* ------------------------------ box settings ------------------------------ */

/**
 * One admin-set box threshold (table: box_settings). The env var remains the
 * DEFAULT: a saved value overrides it at boot, and deleting the row restores the
 * env-configured value.
 */
export interface IBoxSetting {
  /** The setting key, e.g. "min_expected_net_profit". */
  _id: string;
  value: number;
  updated_at: Date;
}

/* --------------------------- calibration samples --------------------------- */

/** One measured execution-latency observation (table: box_calibration_samples). */
export interface IBoxCalibrationSample {
  broker: string;
  kind: string;
  profile: string;
  bucket: string;
  stage: string;
  value_ms: number;
  session: string;
  region: string | null;
  observed_at: Date;
}

/* --------------------------- durable trading session ----------------------- */

/**
 * THE DURABLE TRADING-SESSION RECORD (table: box_trading_session).
 *
 * A SINGLE row, `_id: "current"`. There is exactly one armed session per deployment
 * at a time. Durable for a SAFETY reason rather than a convenience one:
 * `BOX_SESSION_MAX_COMPLETED_TRADES=1` must not be resettable by restarting Node.
 * NO TTL, on purpose: a consumed one-shot session must stay consumed until an
 * operator deliberately re-arms it.
 */
export interface IBoxTradingSessionDoc {
  _id: string;
  session_id: string;
  armed_at: Date | null;
  armed_by: string | null;
  max_completed_trades: number;
  established_trade_ids: string[];
  completed_trade_ids: string[];
  aborted_attempts: number;
  arm_count: number;
  updated_at: Date | null;
}
