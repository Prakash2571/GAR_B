/**
 * IST clock — the single source of "what day is it, in Asia/Kolkata" for the
 * token scheduler and the broker session validators.
 *
 * WHY A FIXED +5:30 OFFSET, NOT `Intl`
 * India has never observed daylight saving, so the IST offset is a constant
 * +5:30. `src/boxSupport.ts` `istDayKey` computes the P&L day key with exactly
 * this arithmetic, and every durable day key the predecessor codebase ever wrote was produced
 * that way. If the token scheduler used `Intl.DateTimeFormat` with a named zone
 * instead, a subtle disagreement at the midnight boundary between two libraries
 * could make "today" mean two different things in two subsystems. It must mean
 * one thing everywhere, so this file reproduces the boxSupport arithmetic
 * byte-for-byte rather than reimplementing it.
 *
 * WHY AN INJECTABLE CLOCK
 * The scheduler makes decisions at 09:00 IST and "immediately if started after
 * 09:00". Tests must be able to place the process at an arbitrary instant without
 * waiting for a wall clock, so every time decision goes through an `IstClock`
 * whose `now()` a test can freeze and advance. Production wires the real clock;
 * nothing reads `Date.now()` directly.
 *
 * WHY SCHEDULING MUST NOT DRIFT WITH UPTIME
 * The daily poll-start must fire at 09:00 IST every trading morning, not "24h
 * after the process booted". `msUntilNextDailyTime` always computes the delay
 * from the current IST wall time to the next occurrence of HH:MM, so a process
 * that has been up for three days still fires at 09:00, not at 09:00-plus-drift.
 */

/** Milliseconds in the fixed IST offset (+5:30). */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** An injectable wall clock. Production passes {@link systemClock}; tests a fake. */
export interface IstClock {
  /** Current epoch milliseconds (UTC). */
  now(): number;
}

/** The real clock. The only place `Date.now()` is read for token scheduling. */
export const systemClock: IstClock = {
  now: () => Date.now(),
};

/**
 * Calendar day in IST (UTC+5:30) as `YYYY-MM-DD`.
 *
 * Identical arithmetic to `boxSupport.istDayKey`, so a day boundary is the same
 * instant in the token scheduler, the P&L cache and the trading session.
 */
export function istDayKey(atMs: number): string {
  const ist = new Date(atMs + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

/** Minutes since IST midnight for an instant (0..1439). */
export function istMinutesOfDay(atMs: number): number {
  const ist = new Date(atMs + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** Day of week in IST: 0 = Sunday … 6 = Saturday. */
export function istDayOfWeek(atMs: number): number {
  const ist = new Date(atMs + IST_OFFSET_MS);
  return ist.getUTCDay();
}

/** True when `atMs` (IST) falls on Saturday or Sunday. */
export function isIstWeekend(atMs: number): boolean {
  const d = istDayOfWeek(atMs);
  return d === 0 || d === 6;
}

/**
 * Parse `"HH:MM"` into minutes-of-day. Throws on a malformed value so a typo in
 * `BROKER_TOKEN_POLL_START` fails at configuration time rather than silently
 * scheduling at 00:00.
 */
export function parseHhMm(hhmm: string): number {
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) throw new Error(`Invalid HH:MM time "${hhmm}" — expected e.g. "09:00".`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23) throw new Error(`Invalid HH:MM time "${hhmm}" — hours must be 0..23.`);
  return hours * 60 + minutes;
}

/**
 * True when the IST wall time at `atMs` is at or after `hhmm` on the same IST day.
 *
 * Used to answer "is it already past 09:00 today?" so a process that starts at
 * 09:30 fetches immediately instead of waiting for tomorrow.
 */
export function isAtOrAfterIstTime(atMs: number, hhmm: string): boolean {
  return istMinutesOfDay(atMs) >= parseHhMm(hhmm);
}

/**
 * Milliseconds from `atMs` to the NEXT occurrence of `hhmm` IST.
 *
 * If the target time has already passed today, the next occurrence is tomorrow.
 * Computed from the current IST wall time every call, so repeated scheduling never
 * accumulates uptime drift. Seconds and sub-seconds of the current minute are
 * subtracted so the fire lands on the minute boundary.
 */
export function msUntilNextDailyTime(atMs: number, hhmm: string): number {
  const targetMin = parseHhMm(hhmm);
  const ist = new Date(atMs + IST_OFFSET_MS);
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const secondsIntoMinute = ist.getUTCSeconds() * 1000 + ist.getUTCMilliseconds();

  let deltaMin = targetMin - nowMin;
  if (deltaMin < 0 || (deltaMin === 0 && secondsIntoMinute > 0)) {
    deltaMin += 24 * 60; // already passed today → tomorrow
  }
  return deltaMin * 60_000 - secondsIntoMinute;
}
