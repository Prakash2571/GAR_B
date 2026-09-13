/**
 * Day-P&L cache surface — REDIS REMOVED.
 *
 * In CalSpread this file mirrored the running day's box P&L into Upstash Redis on a
 * slow cadence, so a mid-session restart could rebuild the day view in one round trip
 * before draining to Mongo overnight. Redis was ALWAYS best-effort here: durable
 * archive correctness lived in Mongo, never in the cache.
 *
 * GTS Box makes PostgreSQL the durable P&L tier (`box_daily_pnl` and the day-state
 * proof, see `repository.ts`). The Redis mirror was therefore PURELY A CACHE, so it is
 * removed rather than reimplemented: every method degrades to the same neutral value it
 * already returned when Redis was unreachable, and the archiver/engine already fall back
 * to the durable PostgreSQL path in exactly that case. The exported SURFACE is preserved
 * so no caller changes — the pure planning/partitioning helpers (used by the ported unit
 * tests) are unchanged; only the Redis I/O is gone.
 */

import type { BoxConfig } from "./config.js";
import {
  SUMMARY_FIELD,
  type BoxDailyPnlRow,
  type BoxDailyPnlSummary,
  type DaySnapshot,
} from "./pnlSnapshot.js";

/**
 * A single Redis write op, kept only so `buildTradeEvictionPlan` retains its shape for
 * the ported unit tests. Nothing dispatches these any more.
 */
export type RedisCommand = [command: string, ...args: (string | number)[]];

const dayKey = (day: string): string => `calspread:box:pnl:day:${day}`;

export interface CachedDay {
  rows: BoxDailyPnlRow[];
  summary: BoxDailyPnlSummary | null;
  /** True only when a day-hash representation was returned. Always false now. */
  present: boolean;
}

export interface DayIndexEntry {
  day: string;
  archived: boolean;
  updated_at: string;
  archived_at: string | null;
  row_count: number;
  /** Per-field retention bound. */
  expires_at?: string;
}

export interface TradeEvictionPlan {
  days: string[];
  commands: RedisCommand[];
}

export interface TradeEvictionResult {
  days: string[];
  attempted_days: number;
  completed: boolean;
}

/**
 * Build the (now inert) eviction plan for a trade across the given member days. Kept as
 * a PURE function so the ported unit tests still exercise the day-selection logic; the
 * `commands` it returns are no longer dispatched anywhere.
 */
export function buildTradeEvictionPlan(
  memberDays: readonly Pick<DayIndexEntry, "day">[],
  tradeId: string,
  _ttlSec: number,
): TradeEvictionPlan {
  const days = [...new Set(memberDays.map((entry) => entry.day).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const commands: RedisCommand[] = days.map((day) => ["HDEL", dayKey(day), tradeId, SUMMARY_FIELD]);
  return { days, commands };
}

/** Select only indexed days whose cached rows contain the trade. Pure. */
export function indexedTradeDays(
  indexedDays: readonly Pick<DayIndexEntry, "day">[],
  cachedDays: ReadonlyMap<string, Pick<CachedDay, "rows">>,
  tradeId: string,
): Pick<DayIndexEntry, "day">[] {
  return indexedDays
    .filter((entry) => cachedDays.get(entry.day)?.rows.some((row) => row.trade_id === tradeId))
    .map((entry) => ({ day: entry.day }));
}

/** Apply per-entry retention. Pure. */
export function partitionDayIndex(
  entries: readonly DayIndexEntry[],
  ttlSec: number,
  nowMs = Date.now(),
): { active: DayIndexEntry[]; expiredDays: string[] } {
  const active: DayIndexEntry[] = [];
  const expiredDays: string[] = [];
  for (const entry of entries) {
    const explicit = entry.expires_at ? Date.parse(entry.expires_at) : Number.NaN;
    const updated = Date.parse(entry.updated_at);
    const expiresAt = Number.isFinite(explicit)
      ? explicit
      : Number.isFinite(updated)
        ? updated + Math.max(0, ttlSec) * 1000
        : 0;
    if (expiresAt > nowMs) active.push(entry);
    else if (entry.day) expiredDays.push(entry.day);
  }
  return { active, expiredDays };
}

/** Bound the write-path pruning cadence. Pure. */
export function shouldPruneDayIndex(
  lastPruneAt: number,
  ttlSec: number,
  nowMs = Date.now(),
): boolean {
  const intervalMs = Math.max(60_000, Math.min(ttlSec * 250, 60 * 60 * 1000));
  return nowMs - lastPruneAt >= intervalMs;
}

/**
 * The day-P&L cache — now permanently disabled.
 *
 * Every method returns the neutral value it already returned when Redis was
 * unreachable, so the archiver and engine transparently use the durable PostgreSQL
 * tier. The class is kept so `engine.ts` and `pnlArchive.ts` need no change.
 */
export class BoxPnlCache {
  constructor(private cfg: BoxConfig) {
    void this.cfg;
  }

  /** Always off: the durable P&L tier is PostgreSQL, and this mirror was pure cache. */
  enabled(): boolean {
    return false;
  }

  async writeSnapshot(_snap: DaySnapshot): Promise<boolean> {
    return false;
  }

  async readDay(_day: string): Promise<CachedDay> {
    return { rows: [], summary: null, present: false };
  }

  async listDays(): Promise<DayIndexEntry[]> {
    return [];
  }

  async pendingDays(): Promise<DayIndexEntry[]> {
    return [];
  }

  async evictTradeEverywhere(_tradeId: string): Promise<TradeEvictionResult> {
    return { days: [], attempted_days: 0, completed: false };
  }

  async evictTrade(_day: string, _tradeId: string): Promise<boolean> {
    return false;
  }

  async markArchived(_day: string, _rowCount: number, _nowIso: string): Promise<void> {
    /* no-op: PostgreSQL holds the durable archive */
  }
}
