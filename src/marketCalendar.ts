/**
 * THE NSE SESSION CALENDAR — which IST instants the exchange is actually open.
 *
 * WHAT THIS REPLACES, AND WHY IT MATTERS
 *
 * The entire market calendar used to be seven lines in `boxSupport.ts`:
 *
 *     const day = ist.getUTCDay();
 *     if (day === 0 || day === 6) return false;
 *     return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 40;
 *
 * Day-of-week and a minute window. Three separate live-trading defects came out of that:
 *
 *   1. IT CLOSED AT 15:40. NFO closes at 15:30. For ten minutes the engine believed it could
 *      still enter and exit. In the first ~15 seconds of that window the last books are still
 *      inside `quoteMaxAgeMs`, heartbeats keep the transport "live", and all four legs stopped
 *      ticking simultaneously so cross-leg dispersion is ~0 and the coherence gate ADMITS — so a
 *      new four-leg box could be submitted against the frozen closing book. Best case Kite
 *      rejects all four; worst case a leg already in flight fills and the rest do not, leaving
 *      unhedged option legs overnight. Two other modules already used the correct 15:30
 *      (`positionMonitor.IST_CLOSE_MINUTES`, `latencyModel.IST_MARKET_CLOSE_MINUTES`), so the
 *      codebase disagreed with itself about when the market shuts.
 *
 *   2. THERE WAS NO HOLIDAY CALENDAR AT ALL. On Republic Day (a Monday in 2026) the predicate
 *      returns true from 09:15 and the board reports `market_open: true` all day. What actually
 *      stopped it trading was incidental, not designed: no ticks arrive, so staleness eventually
 *      refuses every candidate. Worse, `refreshClosedMarketView()` is gated on `!marketOpen`, so
 *      on a holiday the SAFE last-close view is suppressed and the live path is the one left
 *      enabled. Any path that yields a recently-arrived snapshot on a holiday re-opens the hole.
 *
 *   3. THE INVERSE CASE WAS UNSAFE TOO. Muhurat trading is a real one-hour session, usually in
 *      the evening and sometimes on a Sunday (8 Nov 2026). The old predicate returns FALSE for
 *      it — and the position monitor and the residual-flatten loop are both gated on
 *      `isMarketOpen`, so an open box would be completely unmanaged through a live session: no
 *      auto-exit, no residual flatten, no protective work.
 *
 * THREE RULES THIS MODULE FOLLOWS
 *
 *   ABSENCE OF DATA IS NOT A TRADING DAY. A year this calendar does not cover cannot be asserted
 *   to be holiday-free. `calendarCoversYear()` reports that honestly and the operational-readiness
 *   surface turns it into an ENTRY blocker — never an exit blocker, because refusing to manage
 *   exposure you already hold is strictly worse than trading on an unverified calendar.
 *
 *   THE DATA IS OVERRIDABLE WITHOUT A DEPLOY. Exchange holidays move (and get added mid-year for
 *   things like municipal elections). `BOX_NSE_TRADING_HOLIDAYS` and `BOX_NSE_SPECIAL_SESSIONS`
 *   let an operator correct the calendar from configuration, because a wrong calendar that needs
 *   a release to fix is a wrong calendar that stays wrong.
 *
 *   SPECIAL SESSIONS ARE OPT-IN WITH EXPLICIT HOURS, NEVER GUESSED. NSE notifies Muhurat timings
 *   separately each year. Inventing 18:15-19:15 would be a fabricated trading window, so the
 *   DATE is recorded (it is evidence an operator needs) while the WINDOW must be configured. A
 *   recorded-but-unconfigured special session is closed, and says why.
 *
 * PURE: no clock of its own, no I/O, no network. Every function takes the instant it reasons about.
 */

/** IST is UTC+5:30 with no daylight saving, and never has had any. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** NFO/equity continuous session open — 09:15 IST, as minutes from IST midnight. */
export const NSE_SESSION_OPEN_MINUTES = 9 * 60 + 15;

/**
 * NFO/equity continuous session close — 15:30 IST, as minutes from IST midnight.
 *
 * THE ONE definition. `positionMonitor` and `latencyModel` re-derive the same number locally and
 * are asserted against this by `tests`; `boxSupport.isMarketOpen` now imports it rather than
 * carrying its own 15:40.
 */
export const NSE_SESSION_CLOSE_MINUTES = 15 * 60 + 30;

/** A trading window on one calendar day, in minutes from IST midnight. */
export interface NseSessionWindow {
  readonly openMinute: number;
  /** EXCLUSIVE. The market is open for `openMinute <= t < closeMinute`. */
  readonly closeMinute: number;
  /** `regular` = the standard continuous session; `special` = an operator-configured extra session. */
  readonly kind: "regular" | "special";
  /** Human label for a special session, for the operator surface. */
  readonly label?: string;
}

/**
 * NSE full-day trading holidays, by IST calendar year.
 *
 * WEEKDAY CLOSURES ONLY ARE LOAD-BEARING — weekends are already excluded by day-of-week, so a
 * holiday that falls on a Saturday or Sunday changes nothing and is omitted rather than listed
 * misleadingly. The 2026 set below is the 16 weekday closures published by the exchange.
 *
 * WHEN A NEW YEAR STARTS, THIS MUST BE EXTENDED. It is not optional and it is not silent: an
 * uncovered year makes `calendarCoversYear()` false, which blocks live ENTRY via
 * operational readiness. That is deliberate — the alternative is asserting a holiday-free year
 * the code has no evidence for, and trading a four-leg box into a closed exchange.
 */
export const NSE_TRADING_HOLIDAYS_BY_YEAR: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "2026": Object.freeze([
      "2026-01-15", // Municipal Corporation Elections in Maharashtra (Thu)
      "2026-01-26", // Republic Day (Mon)
      "2026-03-03", // Holi (Tue)
      "2026-03-26", // Shri Ram Navami (Thu)
      "2026-03-31", // Shri Mahavir Jayanti (Tue)
      "2026-04-03", // Good Friday (Fri)
      "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti (Tue)
      "2026-05-01", // Maharashtra Day (Fri)
      "2026-05-28", // Bakri Eid (Thu)
      "2026-06-26", // Moharram (Fri)
      "2026-09-14", // Ganesh Chaturthi (Mon)
      "2026-10-02", // Mahatma Gandhi Jayanti (Fri)
      "2026-10-20", // Dussehra (Tue)
      "2026-11-10", // Diwali-Balipratipada (Tue)
      "2026-11-24", // Prakash Gurpurb Sri Guru Nanak Dev (Tue)
      "2026-12-25", // Christmas (Fri)
    ]),
  });

/**
 * Dates on which the exchange runs a SPECIAL session whose hours NSE notifies separately.
 *
 * Recorded as dates with NO window, because the window is genuinely not knowable here. Listing a
 * date buys two things: the operator surface can say "8 Nov 2026 is a Muhurat session and its
 * window is not configured" instead of silently reporting a closed market, and
 * `BOX_NSE_SPECIAL_SESSIONS` has something to be checked against.
 *
 * Until a window is configured the day is CLOSED — which is the safe default for entry, and is
 * why the readiness surface reports the unconfigured session rather than hiding it.
 */
export const NSE_SPECIAL_SESSION_DATES: Readonly<Record<string, string>> = Object.freeze({
  "2026-11-08": "Diwali-Laxmi Pujan (Muhurat trading session)",
});

/** Calendar day in IST (UTC+5:30) as YYYY-MM-DD. */
export function istDayKeyOf(at: number): string {
  return new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes elapsed since IST midnight. */
export function istMinutesOfDayOf(at: number): number {
  const ist = new Date(at + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** Day of week on the IST-shifted date: 0 = Sunday ... 6 = Saturday. */
export function istDayOfWeekOf(at: number): number {
  return new Date(at + IST_OFFSET_MS).getUTCDay();
}

function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Extra holidays from `BOX_NSE_TRADING_HOLIDAYS` — a comma/space separated list of YYYY-MM-DD.
 *
 * ADDITIVE ONLY. An operator can declare a day closed that this calendar does not know about
 * (a newly notified election holiday, an exchange shutdown), but cannot declare a known holiday
 * OPEN. Removal is the dangerous direction — it would let a typo reopen Republic Day — and there
 * is no legitimate reason to need it, because a genuine extra session is a special session with
 * hours, not the deletion of a holiday.
 *
 * Malformed entries are DROPPED, not treated as a parse failure that opens the market: a
 * half-readable override must never become a wider trading window than the shipped calendar.
 */
function envHolidays(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.BOX_NSE_TRADING_HOLIDAYS?.trim();
  const out = new Set<string>();
  if (!raw) return out;
  for (const token of raw.split(/[,\s]+/)) {
    const day = token.trim();
    if (day && isIsoDay(day)) out.add(day);
  }
  return out;
}

/**
 * Operator-declared special sessions from `BOX_NSE_SPECIAL_SESSIONS`.
 *
 * Format: `YYYY-MM-DD:HH:MM-HH:MM`, comma separated. Example for Muhurat 2026:
 *
 *     BOX_NSE_SPECIAL_SESSIONS=2026-11-08:18:15-19:15
 *
 * An entry that does not parse cleanly, or whose close is not after its open, is DROPPED — an
 * unreadable window must never become a trading window. The date does not need to be in
 * {@link NSE_SPECIAL_SESSION_DATES}: the exchange can call an unscheduled session (a mock or a
 * disaster-recovery live session) and the operator must be able to declare it.
 */
function envSpecialSessions(env: NodeJS.ProcessEnv): Map<string, NseSessionWindow> {
  const out = new Map<string, NseSessionWindow>();
  const raw = env.BOX_NSE_SPECIAL_SESSIONS?.trim();
  if (!raw) return out;
  for (const token of raw.split(",")) {
    const match = /^\s*(\d{4}-\d{2}-\d{2}):(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\s*$/.exec(token);
    if (!match) continue;
    const [, day, oh, om, ch, cm] = match;
    if (!isIsoDay(day!)) continue;
    const openMinute = Number(oh) * 60 + Number(om);
    const closeMinute = Number(ch) * 60 + Number(cm);
    if (!Number.isInteger(openMinute) || !Number.isInteger(closeMinute)) continue;
    if (openMinute < 0 || closeMinute > 24 * 60 || closeMinute <= openMinute) continue;
    out.set(day!, {
      openMinute,
      closeMinute,
      kind: "special",
      label: NSE_SPECIAL_SESSION_DATES[day!] ?? "operator-declared special session",
    });
  }
  return out;
}

/** Whether this calendar has holiday data for the IST year containing `at`. */
export function calendarCoversYear(at: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const year = istDayKeyOf(at).slice(0, 4);
  if (NSE_TRADING_HOLIDAYS_BY_YEAR[year] !== undefined) return true;
  // An operator who has supplied holidays for this year has supplied the evidence the shipped
  // table lacks. Requiring at least one entry IN THAT YEAR means an unrelated leftover override
  // from a previous year cannot silently certify the current one.
  for (const day of envHolidays(env)) if (day.startsWith(`${year}-`)) return true;
  return false;
}

/** Every known full-day closure for the IST year containing `at`, including operator additions. */
export function holidaysForYearOf(at: number, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const year = istDayKeyOf(at).slice(0, 4);
  const out = new Set<string>(NSE_TRADING_HOLIDAYS_BY_YEAR[year] ?? []);
  for (const day of envHolidays(env)) if (day.startsWith(`${year}-`)) out.add(day);
  return out;
}

/** True when the IST date containing `at` is a known full-day exchange holiday. */
export function isTradingHoliday(at: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return holidaysForYearOf(at, env).has(istDayKeyOf(at));
}

/**
 * The trading window in force on the IST date containing `at`, or null when the exchange is shut
 * for the whole day.
 *
 * ORDER MATTERS. A configured special session wins over both the weekend rule and the holiday
 * rule, because that is exactly what a special session IS — the exchange trading on a day it
 * normally would not. Muhurat on a Sunday is the canonical case, and getting this order wrong is
 * what would leave an open position unmanaged through a live session.
 */
export function nseSessionWindow(
  at: number,
  env: NodeJS.ProcessEnv = process.env,
): NseSessionWindow | null {
  const dayKey = istDayKeyOf(at);
  const special = envSpecialSessions(env).get(dayKey);
  if (special) return special;
  const dow = istDayOfWeekOf(at);
  if (dow === 0 || dow === 6) return null;
  if (isTradingHoliday(at, env)) return null;
  return {
    openMinute: NSE_SESSION_OPEN_MINUTES,
    closeMinute: NSE_SESSION_CLOSE_MINUTES,
    kind: "regular",
  };
}

/**
 * True while the NSE equity-derivatives segment is open.
 *
 * The close is EXCLUSIVE: at exactly 15:30:00 the session is over. The old `<= 15:40` both
 * overshot by ten minutes and included its own boundary minute, so the last tradable instant was
 * reported as 15:40:59.
 */
export function isMarketOpenAt(at: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const window = nseSessionWindow(at, env);
  if (!window) return false;
  const mins = istMinutesOfDayOf(at);
  return mins >= window.openMinute && mins < window.closeMinute;
}

/**
 * Minutes remaining until the session closes, or null when the market is not open.
 *
 * Used by the entry cutoff, which needs to know how much of the session is left rather than what
 * time it is — a special session with a 60-minute window has to be treated as 60 minutes of
 * runway, not as "it is early in the day".
 */
export function minutesUntilSessionClose(
  at: number,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const window = nseSessionWindow(at, env);
  if (!window) return null;
  const mins = istMinutesOfDayOf(at);
  if (mins < window.openMinute || mins >= window.closeMinute) return null;
  return window.closeMinute - mins;
}

/**
 * Minutes since the session opened, or null when the market is not open.
 *
 * The open is as hazardous as the close and for the opposite reason: NFO's first packets routinely
 * carry previous-close values with absent or absurdly wide books, and every staleness gate in this
 * system measures time since a packet ARRIVED, not whether its price is a genuine post-open trade.
 * A snapshot that lands at 09:15:01 carrying yesterday's closes is therefore "fresh" by every
 * existing check — precisely the shape of a fake free-money signal on a four-leg box.
 */
export function minutesSinceSessionOpen(
  at: number,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const window = nseSessionWindow(at, env);
  if (!window) return null;
  const mins = istMinutesOfDayOf(at);
  if (mins < window.openMinute || mins >= window.closeMinute) return null;
  return mins - window.openMinute;
}

/**
 * Whether the given IST calendar day (YYYY-MM-DD) is a trading day.
 *
 * Day-level, so it ignores the time of day entirely — "is the exchange open at all on this date",
 * not "is it open right now".
 */
export function isTradingDay(dayKey: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isIsoDay(dayKey)) return false;
  // Midday UTC is deliberately chosen so the +5:30 shift cannot land the instant on a neighbouring
  // IST date, whichever direction the arithmetic rounds.
  const at = Date.parse(`${dayKey}T12:00:00.000Z`);
  if (Number.isNaN(at)) return false;
  return nseSessionWindow(at, env) !== null;
}

/**
 * How many TRADING days separate `fromDayKey` from `toDayKey`, counting `to` and excluding `from`.
 *
 * Returns 0 when `to` is on or before `from`, and null when either key is unparseable or the span
 * exceeds `maxDays` (a bounded scan — a corrupt expiry must not spin).
 *
 * TRADING DAYS, NOT CALENDAR DAYS, and the difference is the whole point. A box entered on a Friday
 * whose contract expires the following Monday is three CALENDAR days out but only ONE trading day
 * out: there is exactly one session in which to get out of a four-leg position. Sizing an
 * expiry-distance rule in calendar days would admit precisely the trades it is meant to refuse,
 * and would do so around long weekends — when the holiday calendar makes the gap widest and the
 * intuition least reliable.
 */
export function tradingDaysUntil(
  fromDayKey: string,
  toDayKey: string,
  env: NodeJS.ProcessEnv = process.env,
  maxDays = 400,
): number | null {
  if (!isIsoDay(fromDayKey) || !isIsoDay(toDayKey)) return null;
  if (toDayKey <= fromDayKey) return 0;
  const startMs = Date.parse(`${fromDayKey}T12:00:00.000Z`);
  const endMs = Date.parse(`${toDayKey}T12:00:00.000Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const spanDays = Math.round((endMs - startMs) / DAY_MS);
  if (spanDays < 0 || spanDays > maxDays) return null;
  let trading = 0;
  for (let i = 1; i <= spanDays; i++) {
    const at = startMs + i * DAY_MS;
    if (nseSessionWindow(at, env) !== null) trading++;
  }
  return trading;
}

/** Why new entry is refused on session-timing grounds. Null means the entry window is open. */export type SessionEntryRefusal =
  | "market_closed"
  | "session_warmup"
  | "entry_cutoff"
  | "calendar_year_uncovered";

export interface SessionEntryWindow {
  readonly allowed: boolean;
  readonly refusal: SessionEntryRefusal | null;
  readonly detail: string | null;
  readonly minutesSinceOpen: number | null;
  readonly minutesUntilClose: number | null;
  readonly window: NseSessionWindow | null;
}

/**
 * Whether a NEW box may be STARTED right now, as distinct from whether the market is open.
 *
 * ENTRY ONLY. Nothing here may ever gate an exit, a protective cancel or a residual flatten: the
 * whole point of a cutoff is that exposure must be reducible for longer than it is creatable.
 *
 * THE CUTOFF EXISTS BECAUSE A BOX IS NOT ONE ORDER. The worst-case wall clock from the first POST
 * to the end of a failed entry's unwind is roughly: BUY wave (working timeout 30s + cancel confirm
 * 5s) + SELL wave (35s) + a sequential four-leg unwind (4 x 35s) — about three and a half minutes,
 * and nothing in that chain consults the clock. An entry admitted at 15:28 therefore has its
 * unwind orders rejected by a closed exchange, which is the exact sequence that strands a naked
 * delta-1 ITM option overnight.
 *
 * THE WARM-UP EXISTS FOR THE MIRROR-IMAGE REASON at the open: the first minutes of NFO carry
 * previous-close prices and enormous spreads that every arrival-time freshness gate accepts.
 */
export function evaluateSessionEntryWindow(args: {
  at: number;
  /** Refuse new entry once fewer than this many minutes of the session remain. */
  cutoffMinutesBeforeClose: number;
  /** Refuse new entry for this many minutes after the session opens. */
  warmupMinutesAfterOpen: number;
  env?: NodeJS.ProcessEnv;
}): SessionEntryWindow {
  const env = args.env ?? process.env;
  const window = nseSessionWindow(args.at, env);
  const minutesSinceOpen = minutesSinceSessionOpen(args.at, env);
  const minutesUntilClose = minutesUntilSessionClose(args.at, env);
  const base = { minutesSinceOpen, minutesUntilClose, window };

  if (!isMarketOpenAt(args.at, env)) {
    return {
      ...base,
      allowed: false,
      refusal: "market_closed",
      detail: window
        ? `outside the ${window.kind} session window for ${istDayKeyOf(args.at)}`
        : `${istDayKeyOf(args.at)} is not an NSE trading day`,
    };
  }

  // Checked AFTER the market-open test so a holiday or a weekend reports the reason an operator
  // can act on, and BEFORE the warm-up/cutoff so an uncovered calendar cannot be masked by a
  // timing refusal that happens to fire at the same moment.
  if (!calendarCoversYear(args.at, env)) {
    const year = istDayKeyOf(args.at).slice(0, 4);
    return {
      ...base,
      allowed: false,
      refusal: "calendar_year_uncovered",
      detail:
        `no NSE holiday calendar is loaded for ${year}, so this cannot be confirmed as a trading ` +
        `day. Extend NSE_TRADING_HOLIDAYS_BY_YEAR or set BOX_NSE_TRADING_HOLIDAYS for ${year}. ` +
        `Exits, protective cancels and residual flattening are UNAFFECTED.`,
    };
  }

  if (minutesSinceOpen !== null && minutesSinceOpen < args.warmupMinutesAfterOpen) {
    return {
      ...base,
      allowed: false,
      refusal: "session_warmup",
      detail:
        `${minutesSinceOpen}min since the open is inside the ${args.warmupMinutesAfterOpen}min ` +
        `warm-up; opening books carry previous-close prices that every arrival-time freshness ` +
        `check accepts`,
    };
  }

  if (minutesUntilClose !== null && minutesUntilClose <= args.cutoffMinutesBeforeClose) {
    return {
      ...base,
      allowed: false,
      refusal: "entry_cutoff",
      detail:
        `${minutesUntilClose}min to the close is inside the ${args.cutoffMinutesBeforeClose}min ` +
        `entry cutoff; a four-leg entry plus a failed-entry unwind needs several minutes and an ` +
        `unfinished box at the bell becomes overnight naked exposure`,
    };
  }

  return { ...base, allowed: true, refusal: null, detail: null };
}
