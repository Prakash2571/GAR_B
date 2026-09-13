/**
 * Closed-today trade cache surface — REDIS REMOVED.
 *
 * In CalSpread this mirrored TODAY's closed box trades into Upstash Redis so the
 * Closed-trades tab could render the current session in one round trip instead of a
 * whole-book Mongo sort. It was ALWAYS a best-effort read-path accelerator: every
 * method was a no-op returning a neutral value when Redis was off or unreachable, and
 * the caller fell back to the definitionally-complete database.
 *
 * GTS Box's complete source for "closed today" is now PostgreSQL
 * (`loadBoxTradesClosedSince`, see `repository.ts` / `engine.getClosedToday`). The Redis
 * mirror was PURELY A CACHE, so it is removed rather than reimplemented: the cache
 * reports itself disabled and every read/write degrades to the neutral value, which is
 * exactly the fall-through the engine already handles. The exported SURFACE is preserved
 * (`liteClosedTrade`, `sortClosedNewestFirst`, `BoxClosedTradeCache`) so no caller
 * changes.
 */

import type { BoxConfig } from "./config.js";
import type { SerializedBoxTrade } from "./serialize.js";

/**
 * Strip the audit blobs before returning a trade. Pure; still used to keep the
 * "closed today" rows lite whether they came from memory or PostgreSQL.
 */
export function liteClosedTrade(trade: SerializedBoxTrade): SerializedBoxTrade {
  return {
    ...trade,
    entry_execution: null,
    entry_legging: null,
    exit_execution: null,
    legs: trade.legs.map((leg) => ({ ...leg, entry_depth: null, exit_depth: null })),
  };
}

/** Newest-closed first. Pure. */
export function sortClosedNewestFirst(trades: SerializedBoxTrade[]): SerializedBoxTrade[] {
  return [...trades].sort((a, b) => {
    const at = a.closed_at ?? a.opened_at;
    const bt = b.closed_at ?? b.opened_at;
    return bt.localeCompare(at);
  });
}

/**
 * The closed-today cache — now permanently disabled.
 *
 * Every method returns the neutral value it already returned when Redis was
 * unreachable, so the engine transparently reads today's closed trades from
 * PostgreSQL. Kept so `engine.ts` needs no change.
 */
export class BoxClosedTradeCache {
  constructor(private cfg: BoxConfig) {
    void this.cfg;
  }

  /** Always off: the complete "closed today" source is PostgreSQL, and this was pure cache. */
  enabled(): boolean {
    return false;
  }

  async writeTrade(_day: string, _trade: SerializedBoxTrade): Promise<boolean> {
    return false;
  }

  async writeTrades(_day: string, _trades: SerializedBoxTrade[]): Promise<boolean> {
    return false;
  }

  async readDay(_day: string): Promise<SerializedBoxTrade[]> {
    return [];
  }

  async evictTrade(_day: string, _tradeId: string): Promise<boolean> {
    return false;
  }
}
