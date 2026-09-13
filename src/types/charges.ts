/**
 * Contract-note charge shapes, lifted verbatim out of the predecessor codebase's `src/db.ts`.
 *
 * They live here — with no database dependency at all — because the Box core
 * declares its own structural copies in `src/box/types.ts` and a compile-time
 * assertion in `src/box/model.ts` proves the two stay interchangeable. In
 * the predecessor codebase these interfaces happened to sit next to the Mongoose models; in
 * GTS Algo Research there are no Mongoose models, so the types get their own module.
 *
 * NOTHING here is persistence. `ITradeCharges.at` is a `Date` exactly as before,
 * so a charge payload produced by the shared Zerodha estimator round-trips
 * through the PostgreSQL JSONB audit columns unchanged.
 */

/**
 * One order's worth of charges, as billed by Zerodha's virtual contract note.
 * Flattened from Kite's nested shape (gst.total collapses to `gst`) so the
 * breakdown reads like a contract note line.
 */
export interface ILegCharges {
  side: "BUY" | "SELL";
  tradingsymbol: string;
  quantity: number;
  price: number; // fill price the charges were computed on
  value: number; // quantity * price (contract value / turnover)
  brokerage: number;
  stt: number; // securities transaction tax (sell side only, for futures)
  stt_type: string; // "stt" / "ctt", as Kite labels it
  exchange_txn: number; // exchange transaction charge
  sebi: number; // SEBI turnover charge
  stamp_duty: number; // buy side only
  gst: number; // 18% of (brokerage + exchange + SEBI)
  total: number;
}

/**
 * The charges for one side of a trade (both legs together): the per-leg
 * breakdown plus the summed heads.
 *
 * `source` records where the numbers came from. "kite" is the real virtual
 * contract note for the actual fills; "kite_estimate" is the same API priced at
 * the entry fills to project the exit cost of a still-open trade.
 */
export interface ITradeCharges {
  legs: ILegCharges[];
  value: number; // total contract value both legs
  brokerage: number;
  stt: number;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
  source: "kite" | "kite_estimate";
  at: Date;
}
