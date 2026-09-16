/**
 * BROKER WALL-CLOCK TIMESTAMP PARSING.
 *
 * THE DEFECT THIS MODULE EXISTS TO REMOVE. Both live adapters parsed the broker's own order
 * timestamps with a bare `Date.parse(value)`. Every documented Zerodha and Dhan order timestamp is
 * an IST wall-clock string with NO zone suffix — `"2026-09-09 10:00:01"`, whole seconds (see
 * `docs/BROKER_STREAM_DOCS.md`). ECMAScript says a date-time string in that shape, lacking an
 * offset, is interpreted in the HOST's local time. So the same broker payload produced a different
 * instant depending on the machine's `TZ`:
 *
 *   on an IST host  → correct, by accident
 *   on a UTC host   → 5h30m in the FUTURE  (every container and EC2 default in `deploy/`)
 *
 * That is not a cosmetic reporting error. A future-stamped fill silently corrupts derived latency:
 * `executionGateway.liveRecord` subtracts a LOCAL `detectedAt` from these broker-derived stamps for
 * `decision_to_first_fill_ms` and friends, so on a UTC host every one of those figures is inflated
 * by ~19,800,000 ms while a broker-minus-broker span like `first_to_last_fill_ms` stays right — the
 * classic mixed-clock signature. Worse, `brokerTimingStore.span()` returns null on inversion, so
 * depending on direction a shifted stamp does not merely distort a metric, it makes it VANISH.
 *
 * WHY NOT JUST APPEND "+05:30" AND CALL `Date.parse` — the trap Dhan already fell into.
 * `dhanBrokerAdapter.parseDhanTime` tried exactly that, but ordered the attempts wrongly:
 *
 *     const direct = Date.parse(value);
 *     if (Number.isFinite(direct)) return direct;              // ← always wins
 *     return Date.parse(`${value.replace(" ", "T")}+05:30`);   // ← unreachable
 *
 * The naive parse SUCCEEDS for a space-separated stamp (it just interprets it as host-local), so the
 * IST branch was dead code and Dhan carried the identical bug while wearing a comment claiming it
 * did not. The lesson encoded here: the zone-less path must NEVER fall through a host-local parse.
 * This module computes the instant arithmetically from the parsed components instead, so the host's
 * `TZ` cannot participate in the answer at all.
 *
 * `src/config.ts` hard-fails boot unless `APP_TIMEZONE === "Asia/Kolkata"`, but that check never set
 * the process timezone and neither adapter consulted it, so it offered no protection whatsoever.
 */

/**
 * IST is a FIXED +05:30 offset from UTC.
 *
 * India has observed no daylight saving since 1945, so a single constant is correct year-round and
 * no timezone database is needed. (`src/tokens/istClock.ts` holds the same constant for day-boundary
 * arithmetic; that one SHIFTS an instant for display, this module CONSTRUCTS an instant from wall
 * clock — the two are not interchangeable, which is why this is not imported from there.)
 */
export const IST_UTC_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Does the string already state its own offset?
 *
 * Matches a trailing `Z`, `+05:30`, `-0530` or `+0530`. When it does, the broker has told us the
 * INSTANT rather than a wall-clock reading, and we must honour it verbatim rather than re-interpret
 * it as IST — a UTC-stamped payload re-read as IST would be wrong by the same 5h30m in the other
 * direction.
 */
const EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * The zone-less wall-clock shape both brokers actually send.
 *
 * Accepts `T` or a space as the date/time separator, optional seconds, and optional fractional
 * seconds, because the documented format is whole seconds but a payload carrying millis must not be
 * discarded.
 */
const IST_WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/;

/**
 * Epoch milliseconds for a broker timestamp, or null when it cannot be trusted.
 *
 * FAIL-CLOSED: an unrecognised shape returns null rather than a guess, so a caller falls back to its
 * own clock (a known-local reading) instead of recording a fabricated broker instant. Returning null
 * is always safer here than returning a number that is wrong by hours.
 */
export function parseIstBrokerTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;

  // 1. The payload named its own offset — it is already an instant. Do not reinterpret it.
  if (EXPLICIT_ZONE.test(raw)) {
    const stated = Date.parse(raw);
    return Number.isFinite(stated) ? stated : null;
  }

  // 2. The documented zone-less IST wall clock. Built from components via `Date.UTC` and shifted by
  //    the fixed offset, so the host's timezone is NOT an input to the result.
  const parts = IST_WALL_CLOCK.exec(raw);
  if (parts) {
    const [, year, month, day, hour, minute, second, fraction] = parts;
    const asUtcWallClock = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      second === undefined ? 0 : Number(second),
      fraction === undefined ? 0 : Number(fraction.padEnd(3, "0")),
    );
    if (!Number.isFinite(asUtcWallClock)) return null;
    return asUtcWallClock - IST_UTC_OFFSET_MS;
  }

  // 3. An unexpected but zone-less shape. Still refuse a host-local reading: state the IST offset
  //    explicitly and let the engine parse it. Anything it cannot read is reported as unknown.
  const assumedIst = Date.parse(`${raw.replace(" ", "T")}+05:30`);
  return Number.isFinite(assumedIst) ? assumedIst : null;
}

/**
 * Whether a broker timestamp string stated its own UTC offset.
 *
 * Exposed so evidence/diagnostics can record HOW an exchange time was established — a stamp we had
 * to interpret as IST is weaker evidence than one that named its own offset, and conflating the two
 * is how an assumption becomes an unexamined fact.
 */
export function brokerTimestampStatedZone(value: string | null | undefined): boolean {
  return typeof value === "string" && EXPLICIT_ZONE.test(value.trim());
}
