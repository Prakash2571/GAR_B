/**
 * MARKET-DATA LANES — two physically separate upstream feeds for ONE active broker.
 *
 * WHY TWO
 * The calendar-spread board and the Box scanner have genuinely different appetites.
 * The board wants a few hundred futures and spot instruments and is latency-tolerant.
 * The Box scanner wants thousands of option strikes with depth, and every strike the
 * board's set displaces is an arbitrage it cannot see. Sharing one connection and one
 * token budget means the two compete: today `BOX_MAX_SUBSCRIBED_TOKENS` (2200) exists
 * precisely because the Box universe has to be trimmed to fit alongside everything
 * else, and the union of browser + strategy tokens is bounded by nothing at all.
 *
 * Splitting them gives each workload its own socket, its own refcount table, its own
 * budget, and its own health — so a wide option universe cannot starve the board, and
 * a busy board cannot starve the scanner.
 *
 * WHAT THIS IS NOT
 * It is NOT two brokers running at once. Exactly one broker is ACTIVE, and both lanes
 * belong to it. If Zerodha is active there are two Zerodha sockets and no Dhan socket
 * is trading or scanning; if Dhan is active, the mirror. The single-active invariant
 * and the broker-generation model are unchanged — a lane is a workload, not a venue.
 *
 * WHY A TYPE RATHER THAN A BOOLEAN
 * `isBox = true` at a call site tells you nothing about what the false case is, and it
 * cannot be exhaustively checked. A lane is named, switch-exhaustive, and reads
 * correctly in a log line.
 *
 * CONNECTION BUDGET
 * Zerodha permits 3 WebSocket connections per API key. Two are used here (one per
 * lane) and the third is deliberately left free for a separate service. PM2 restarts
 * stop the old process before starting the new one, so a deploy never needs four.
 * Dhan permits 5 sockets per user with 5000 instruments each, so two lanes fit
 * comfortably. Neither number is bypassed or exceeded: this module fixes the lane
 * count at two by construction — there is no code path that opens an unbounded number
 * of sockets.
 */

/** The two workloads. Exhaustive by design. */
export type MarketDataLane = "futures" | "box";

export const MARKET_DATA_LANES: readonly MarketDataLane[] = ["futures", "box"] as const;

/**
 * Which lane an instrument class belongs to.
 *
 * Stated once, here, so the answer cannot drift between the subscription layer, the
 * diagnostics and the engine.
 *
 *   futures — calendar-spread board, spot prices for the predecessor codebase, near/current/mid
 *             futures, the calendar-spread scanner, futures analytics, and the
 *             hourly/EOD captures that depend on live ticks.
 *   box     — option contracts (CE/PE strikes) for the Box scanner: bid/ask/depth,
 *             executable prices, quote freshness and opportunity detection.
 */
export function laneLabel(lane: MarketDataLane): string {
  return lane === "futures" ? "futures/calendar-spread" : "box-arbitrage options";
}

/** Per-lane feed health and throughput, for diagnostics. */
export interface LaneFeedStats {
  lane: MarketDataLane;
  connected: boolean;
  /** Tokens this lane has actually confirmed upstream. */
  subscribedTokens: number;
  /** Tokens this lane WANTS — differs from `subscribedTokens` mid-reconnect. */
  wantedTokens: number;
  ticksPerSecond: number;
  lastTickAgeMs: number | null;
  /**
   * Age of the last TRANSPORT HEARTBEAT (keep-alive), or null when none was ever seen.
   *
   * Reported separately from `lastTickAgeMs` because the two answer different questions. A lane
   * with a stale `lastTickAgeMs` but a fresh heartbeat is ALIVE and merely quiet — the instruments
   * are not trading. A lane where both are stale is genuinely dead. Collapsing them is how a quiet
   * feed gets misdiagnosed as a broken one (and vice versa, which is worse).
   *
   * Optional so a producer that observes no keep-alive is not forced to invent one.
   */
  lastHeartbeatAgeMs?: number | null;
  reconnects: number;
  /** The broker generation this lane's socket was opened under. */
  generation: number;
}

/**
 * A rolling tick-rate counter.
 *
 * Bounded and allocation-free on the hot path: one integer per one-second bucket over
 * a fixed ring, so a high tick rate cannot grow memory. Deliberately not a precise
 * moving average — this is an operator-facing rate, and a cheap approximation that
 * cannot leak is worth more than an exact one that can.
 */
export class TickRateCounter {
  private buckets: number[];
  private bucketAt: number[];
  private cursor = 0;

  constructor(private readonly seconds = 10) {
    this.buckets = new Array<number>(seconds).fill(0);
    this.bucketAt = new Array<number>(seconds).fill(0);
  }

  mark(count: number, now: number): void {
    const second = Math.floor(now / 1000);
    if (this.bucketAt[this.cursor] === second) {
      this.buckets[this.cursor] = (this.buckets[this.cursor] ?? 0) + count;
      return;
    }
    this.cursor = (this.cursor + 1) % this.seconds;
    this.bucketAt[this.cursor] = second;
    this.buckets[this.cursor] = count;
  }

  perSecond(now: number): number {
    const newest = Math.floor(now / 1000);
    let total = 0;
    let counted = 0;
    for (let i = 0; i < this.seconds; i++) {
      const at = this.bucketAt[i] ?? 0;
      // Only buckets inside the window, and never the current partial second.
      if (at === 0 || at >= newest || newest - at > this.seconds) continue;
      total += this.buckets[i] ?? 0;
      counted++;
    }
    if (counted === 0) return 0;
    return Math.round((total / counted) * 10) / 10;
  }

  reset(): void {
    this.buckets.fill(0);
    this.bucketAt.fill(0);
    this.cursor = 0;
  }
}
