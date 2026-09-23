/**
 * CANDIDATE-SCOPED MARKET-DATA ADMISSION — the evidence for THIS box, not for the whole universe.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS EXISTS TO FIX
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `MarketDataStateMachine.reevaluate()` reached READY only when EVERY desired instrument had fresh
 * usable depth, and the engine handed it `subscribedOptionTokens` — the ENTIRE streamed option
 * universe (every leg of every ATM±3 window across every streaming underlying, up to
 * `cfg.maxSubscribedTokens`). READY is the only market-data state whose permission licenses new
 * entry, so:
 *
 *     ONE illiquid strike in an unrelated underlying that never ticks
 *       ⇒ everyDesiredFresh() === false
 *       ⇒ state SYNCHRONIZING/DEGRADED, never READY
 *       ⇒ executionGateway checkpoint 1 refuses EVERY box with `feed_unhealthy`
 *
 * A four-leg NIFTY box whose own four books were all fresh, executable and same-generation was
 * refused because of a BANKNIFTY strike it does not touch. The refusal message even claimed
 * "entry requires fresh usable depth per leg" — the intent was already per-leg; the implementation
 * was universe-wide.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE CONCEPTS, NOW SEPARATE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  1. TRANSPORT / SESSION HEALTH — is the socket authenticated, live, un-backlogged, and actually
 *     delivering usable depth at all? This is a SHARED failure: when it fails, no candidate can be
 *     trusted no matter how fresh its cached books look, because a book observed before a socket
 *     died is not evidence about now. Owned by `MarketDataStateMachine`.
 *  2. SUBSCRIPTION / SCANNER COVERAGE — how much of the desired universe currently has fresh depth.
 *     This is an OBSERVABILITY figure (it tells an operator the scanner is running blind on N
 *     instruments). It must be reported accurately and must NOT gate entry for an unrelated
 *     candidate. Owned by `MarketDataStateMachine.coverage()`.
 *  3. CANDIDATE ENTRY EVIDENCE — do THESE four instruments each have admissible evidence right now?
 *     That is this module.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NO CACHE, DELIBERATELY
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Cached candidate readiness would have to be invalidated on candidate identity, subscription
 * generation, socket generation, and every book update — i.e. on essentially every input. Rather
 * than build that and then have to prove the invalidation is complete, this evaluates from live
 * state on every call. It is four map lookups and a depth walk; the cost of getting staleness wrong
 * here is a wrong-priced four-leg box. So "invalidate cached candidate readiness when candidate
 * identity, subscription generation or evidence changes" holds by construction: there is nothing
 * cached to go stale, and a switch to a different candidate cannot inherit the previous verdict.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES *NOT* PROVE — read before trusting it
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  - It does not prove the BROKER identity of a token. `BoxOptionInstrument` carries no broker
 *    field; broker identity is ambient (the active broker owns the token namespace) and is enforced
 *    by advancing the feed/socket generation on a broker switch, which invalidates every book. This
 *    module checks the generation, so a token from a superseded namespace fails — but it cannot
 *    independently attest "this integer is a Dhan security id".
 *  - It does not prove the instrument is TRADEABLE at the exchange right now (no ban-period or
 *    surveillance-suspension feed is wired). Expiry is checked; availability beyond that is not.
 *  - It does not replace `precheck()` or the four-leg coherence check. It runs BEFORE request
 *    construction, on the candidate's own instruments, and those checks still run afterwards on the
 *    built requests. This is an additional necessary condition, never a substitute.
 */

import { BOX_LEG_ROLES, type BoxCandidate, type BoxLegRole, type BoxQuote } from "./types.js";
import type { MarketDataState } from "./streamHealthPolicy.js";
import { marketDataPermissions } from "./streamHealthPolicy.js";
import { DEFAULT_MAX_EXCHANGE_AHEAD_MS } from "./executionCoherence.js";

/** Why a specific candidate is not admissible on market-data evidence. Operator-readable. */
export interface CandidateMarketDataBlocker {
  /** Machine-stable code, for counters and tests. */
  readonly code:
    | "transport_not_ready"
    | "leg_missing"
    | "leg_not_subscribed"
    | "leg_stale_generation"
    | "leg_no_depth_this_generation"
    | "leg_no_book"
    | "leg_book_stale"
    | "leg_source_stale"
    /**
     * The exchange timestamp is further AHEAD of local receive time than granularity explains.
     *
     * Distinct from `leg_source_stale` because it points somewhere completely different: this is the
     * HOST clock being wrong (NTP), not the book being old. Reporting it as staleness — which is
     * what the zero-tolerance `sourceAgeMs < 0` test used to do — told the operator "fresh locally
     * but stale at the exchange" while a modest clock skew silently refused every candidate.
     */
    | "leg_source_clock_anomaly"
    | "leg_no_executable_price"
    | "leg_no_executable_quantity"
    | "leg_incoherent_book"
    | "leg_lot_size_invalid"
    | "leg_tick_size_invalid"
    | "leg_expired"
    | "leg_exchange_mismatch";
  /** The leg this concerns, or null for a candidate-wide/shared condition. */
  readonly role: BoxLegRole | null;
  readonly detail: string;
}

export interface CandidateMarketDataVerdict {
  readonly eligible: boolean;
  readonly blockers: readonly CandidateMarketDataBlocker[];
  /** True when the failure is SHARED (transport-level) rather than specific to these legs. */
  readonly sharedFailure: boolean;
  /** The socket generation the verdict was computed under, for audit. */
  readonly generation: number;
  /** Per-leg evidence actually used, for the audit trail. Never contains a secret. */
  readonly legs: readonly {
    readonly role: BoxLegRole;
    readonly token: number;
    readonly quoteVersion: number | null;
    readonly ageMs: number | null;
    readonly sourceAgeMs: number | null;
  }[];
}

export interface CandidateMarketDataDeps {
  /** The transport/session state. A shared failure here blocks regardless of cached books. */
  readonly transportState: MarketDataState;
  /** The CURRENT socket generation. Evidence from an older generation is not evidence. */
  readonly generation: number;
  /** Per-instrument: fresh usable depth observed in the CURRENT generation. */
  readonly isInstrumentReady: (token: number) => boolean;
  /** Whether this instrument is in the current subscription intent. */
  readonly isSubscribed: (token: number) => boolean;
  /** Whether this token's book belongs to the CURRENT feed generation (engine feedGeneration). */
  readonly isTokenWarm: (token: number) => boolean;
  readonly quote: (token: number) => BoxQuote | undefined;
  readonly now: () => number;
  /** Maximum LOCALLY MEASURED book age (now − receive time). */
  readonly quoteMaxAgeMs: number;
  /**
   * Maximum age of the SOURCE timestamp when the feed supplies one (now − exchange_at). Checked
   * SEPARATELY from `quoteMaxAgeMs`, because a book that arrived a millisecond ago carrying an
   * exchange timestamp from thirty seconds ago is stale at the exchange even though it is fresh
   * locally. When the feed carries no source timestamp (Dhan depth does not), this check is skipped
   * rather than faked — absence is not freshness.
   */
  readonly sourceMaxAgeMs?: number;
  /**
   * How far the exchange timestamp may sit AHEAD of local receive time before it is a clock fault
   * rather than ordinary granularity.
   *
   * WHY A TOLERANCE IS REQUIRED HERE AND NOT OPTIONAL. Kite's `exchange_timestamp` is epoch
   * SECONDS, and `ticker.ts` converts it as `exSec * 1000` — the FLOOR of the exchange second. So a
   * perfectly healthy tick can legitimately carry a stamp up to 999ms behind its true publish
   * instant, and any host clock that runs even slightly behind NSE's makes `now - exchange_at`
   * NEGATIVE for every leg at once.
   *
   * THE DEFECT THIS REPLACES. The source-age test used to reject `sourceAgeMs < 0` with ZERO
   * tolerance. Under a host clock a second or two behind the exchange, all four legs failed
   * simultaneously, every candidate was refused, and entries stopped completely — while the
   * operator-facing reason said "fresh locally but stale at the exchange", which names the exact
   * OPPOSITE of the actual cause. Nothing distinguished it from a genuinely dead feed.
   *
   * `executionCoherence.livePolicyFromConfig` already tolerated this same physical fact at 1500ms
   * and documented why. Two admission layers reading the same input with opposite tolerances is the
   * real bug; this field is what makes them agree.
   */
  readonly maxExchangeAheadOfReceiveMs?: number;
  /** Quantity required per leg (one lot × lots). Used for the depth requirement. */
  readonly requiredQuantity: number;
  /** Which side each role executes on, so the EXECUTABLE side of the book is the one checked. */
  readonly sideForRole: (role: BoxLegRole) => "BUY" | "SELL";
  /** Epoch ms of the start of the current trading day, for the expiry check. */
  readonly tradingDayStartMs?: number;
  readonly defaultTickSize: number;
}

/** Floating-point-safe modulo test for tick conformance. */
function isTickConformant(price: number, tick: number): boolean {
  if (!Number.isFinite(price) || !Number.isFinite(tick) || tick <= 0) return false;
  const ticks = price / tick;
  return Math.abs(ticks - Math.round(ticks)) < 1e-6;
}

/** Parse an `YYYY-MM-DD` expiry into epoch ms at IST end of day, or null when unparseable. */
function expiryEndOfDayMs(expiry: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const utcMidnight = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (!Number.isFinite(utcMidnight)) return null;
  // IST is UTC+5:30. End of the expiry day in IST = next UTC midnight − 5:30.
  return utcMidnight + 24 * 60 * 60 * 1000 - 5.5 * 60 * 60 * 1000;
}

/**
 * Decide whether THIS candidate has admissible market-data evidence, right now.
 *
 * Returns every blocker it finds rather than the first, so an operator sees the whole picture and a
 * test can assert precisely which condition failed.
 */
export function evaluateCandidateMarketData(
  candidate: BoxCandidate,
  deps: CandidateMarketDataDeps,
): CandidateMarketDataVerdict {
  const blockers: CandidateMarketDataBlocker[] = [];
  const legs: {
    role: BoxLegRole;
    token: number;
    quoteVersion: number | null;
    ageMs: number | null;
    sourceAgeMs: number | null;
  }[] = [];
  const now = deps.now();

  // ── 1. SHARED FAILURE FIRST ────────────────────────────────────────────────────────────────
  // The transport must license new entry. This is what stops "all four of my cached books look
  // fresh" from admitting a candidate after the socket has died, been superseded, or had its
  // session rejected: those books were evidence about a connection that no longer exists. It is
  // scored through the SAME permission table the rest of the system uses, never an ad-hoc boolean.
  const transportOk = marketDataPermissions(deps.transportState).newEntry;
  if (!transportOk) {
    blockers.push({
      code: "transport_not_ready",
      role: null,
      detail:
        `market-data transport is ${deps.transportState}, which does not license new entry; ` +
        `a cached book from a superseded or dead connection is not evidence about now`,
    });
    // Return immediately: per-leg evidence cannot be trusted under a shared transport failure, and
    // reporting fifteen derived leg blockers would bury the one that matters.
    return {
      eligible: false,
      blockers,
      sharedFailure: true,
      generation: deps.generation,
      legs,
    };
  }

  // ── 2. PER-LEG EVIDENCE, FOR THESE FOUR INSTRUMENTS ONLY ───────────────────────────────────
  const exchanges = new Set<string>();
  for (const role of BOX_LEG_ROLES) {
    const instrument = candidate.legs[role];
    if (!instrument) {
      blockers.push({ code: "leg_missing", role, detail: `candidate has no ${role} instrument` });
      continue;
    }
    const token = instrument.token;
    exchanges.add(instrument.exchange);

    // ALL REQUIRED LEGS must be genuinely subscribed. A leg we never asked the feed for cannot have
    // trustworthy depth, and admitting it on a book left over from a previous window would be
    // trading on an instrument we are not watching.
    if (!deps.isSubscribed(token)) {
      blockers.push({
        code: "leg_not_subscribed",
        role,
        detail: `${instrument.tradingsymbol} (token ${token}) is not in the current subscription intent`,
      });
    }

    // SESSION / SUBSCRIPTION GENERATION. Two independent generation checks, because they answer
    // different questions: `isTokenWarm` is the engine's feed generation for this token, and
    // `isInstrumentReady` is the state machine's own socket generation plus depth recency.
    if (!deps.isTokenWarm(token)) {
      blockers.push({
        code: "leg_stale_generation",
        role,
        detail: `${instrument.tradingsymbol} book belongs to a superseded feed generation`,
      });
    }
    if (!deps.isInstrumentReady(token)) {
      blockers.push({
        code: "leg_no_depth_this_generation",
        role,
        detail:
          `${instrument.tradingsymbol} has no fresh usable depth in socket generation ${deps.generation}`,
      });
    }

    const quote = deps.quote(token);
    if (!quote) {
      blockers.push({
        code: "leg_no_book",
        role,
        detail: `${instrument.tradingsymbol} has no book at all — absence is never a price`,
      });
      legs.push({ role, token, quoteVersion: null, ageMs: null, sourceAgeMs: null });
      continue;
    }

    // LOCALLY MEASURED AGE. Receive time, not the source timestamp: a genuinely dead feed is only
    // visible in receive time.
    const ageMs = now - quote.at;
    const sourceAgeMs = quote.exchange_at === null ? null : now - quote.exchange_at;
    legs.push({ role, token, quoteVersion: quote.version, ageMs, sourceAgeMs });

    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > deps.quoteMaxAgeMs) {
      blockers.push({
        code: "leg_book_stale",
        role,
        detail: `${instrument.tradingsymbol} book age ${Math.round(ageMs)}ms exceeds ${deps.quoteMaxAgeMs}ms`,
      });
    }
    // SOURCE FRESHNESS, kept meaningful and separate. Skipped — not faked — when the feed carries
    // no exchange timestamp.
    //
    // The "ahead of local time" case is tolerated rather than rejected outright: Kite's exchange
    // stamp is 1-second granular (floored to the second by the parser), so a healthy tick is
    // routinely up to 999ms "in the future" relative to a host clock that runs marginally behind
    // NSE's. Rejecting any negative age made a modest clock skew look like four simultaneously
    // stale legs and silently halted all entries, with a reason that named the opposite cause.
    // Beyond the tolerance it IS a fault, and it is reported as a clock fault rather than staleness
    // so an operator is pointed at NTP instead of at the feed.
    if (deps.sourceMaxAgeMs !== undefined && sourceAgeMs !== null) {
      const aheadTolerance = deps.maxExchangeAheadOfReceiveMs ?? DEFAULT_MAX_EXCHANGE_AHEAD_MS;
      if (!Number.isFinite(sourceAgeMs)) {
        blockers.push({
          code: "leg_source_stale",
          role,
          detail: `${instrument.tradingsymbol} exchange timestamp is not a finite age`,
        });
      } else if (sourceAgeMs < -aheadTolerance) {
        blockers.push({
          code: "leg_source_clock_anomaly",
          role,
          detail:
            `${instrument.tradingsymbol} exchange timestamp is ${Math.round(-sourceAgeMs)}ms AHEAD of ` +
            `local receive time, over the ${aheadTolerance}ms tolerance — this is a HOST CLOCK fault ` +
            `(check NTP), not a stale book`,
        });
      } else if (sourceAgeMs > deps.sourceMaxAgeMs) {
        blockers.push({
          code: "leg_source_stale",
          role,
          detail:
            `${instrument.tradingsymbol} exchange timestamp is ${Math.round(sourceAgeMs)}ms old, ` +
            `over the ${deps.sourceMaxAgeMs}ms source bound — fresh locally but stale at the exchange`,
        });
      }
    }

    // EXECUTABLE-SIDE price and quantity. A BUY executes against asks, a SELL against bids; the
    // other side of the book is irrelevant to whether this leg can be filled.
    const side = deps.sideForRole(role);
    const levels = side === "BUY" ? quote.asks : quote.bids;
    const touchPrice = side === "BUY" ? quote.ask : quote.bid;
    const touchQty = side === "BUY" ? quote.ask_qty : quote.bid_qty;

    if (!Number.isFinite(touchPrice) || touchPrice <= 0) {
      blockers.push({
        code: "leg_no_executable_price",
        role,
        detail: `${instrument.tradingsymbol} has no positive ${side === "BUY" ? "ask" : "bid"}`,
      });
    } else if (!isTickConformant(touchPrice, instrument.tick_size ?? deps.defaultTickSize)) {
      // A price off the instrument's tick grid means our tick model and the exchange's disagree —
      // which is exactly the condition under which a limit price gets rejected or silently rounded.
      blockers.push({
        code: "leg_tick_size_invalid",
        role,
        detail:
          `${instrument.tradingsymbol} touch price ${touchPrice} is not a multiple of tick ` +
          `${instrument.tick_size ?? deps.defaultTickSize}`,
      });
    }
    if (!Number.isFinite(touchQty) || touchQty <= 0) {
      blockers.push({
        code: "leg_no_executable_quantity",
        role,
        detail: `${instrument.tradingsymbol} has no quantity resting at the ${side} touch`,
      });
    }

    /*
     * REQUIRED DEPTH AT THE PRICE WE WILL ACTUALLY TRADE.
     *
     * THE TOUCH LEVEL MUST COVER THE WHOLE QUANTITY. This used to sum the quantity across all five
     * displayed levels, which is not the test the order needs: the order is priced AT the touch (the
     * limit is `touch ± chaseTicks`), so only liquidity reachable within that band can fill it.
     *
     * The old sum admitted a leg showing 25 at the touch and 50 spread across levels 2-5 against a
     * lot of 75. The order then filled 25 and the remainder either rested — destroying the four-leg
     * simultaneity the coherence gate spends so much effort establishing — or swept deeper levels at
     * materially worse prices. On a box whose entire edge is a few paise per leg, that is the
     * difference between a positive and a negative net credit, and it happened INSIDE every safety
     * rail, so nothing reported a problem.
     *
     * `touchQty` comes from `BoxQuoteStore`, which already sums only the levels resting at exactly
     * the touch price (an exchange can report the same price twice in a padded depth payload), so it
     * is the correct quantity to compare against.
     *
     * The all-levels total is still computed, purely so the refusal can say whether the liquidity
     * exists deeper — "25 at the touch, 75 needed (75 across all levels)" tells an operator the book
     * is thin at the top rather than empty, which is a different market and a different decision.
     */
    const availableDepth = levels.reduce((sum, level) => sum + (Number.isFinite(level.qty) ? level.qty : 0), 0);
    const touchDepth = Number.isFinite(touchQty) && touchQty > 0 ? touchQty : 0;
    // Skipped when the touch is already reported as empty above, so a book with nothing at the touch
    // raises one blocker naming that fact rather than two saying it twice.
    if (touchDepth > 0 && touchDepth < deps.requiredQuantity) {
      blockers.push({
        code: "leg_no_executable_quantity",
        role,
        detail:
          `${instrument.tradingsymbol} shows ${touchDepth} at the executable ${side} touch ` +
          `(${availableDepth} across all levels); ${deps.requiredQuantity} is required at the touch ` +
          `because the order is priced there`,
      });
    }

    // COHERENT SNAPSHOT. A crossed or locked book is not a tradable snapshot; it usually means two
    // halves of different updates were stitched together.
    if (
      Number.isFinite(quote.bid) && Number.isFinite(quote.ask) &&
      quote.bid > 0 && quote.ask > 0 && quote.bid >= quote.ask
    ) {
      blockers.push({
        code: "leg_incoherent_book",
        role,
        detail: `${instrument.tradingsymbol} book is crossed/locked (bid ${quote.bid} >= ask ${quote.ask})`,
      });
    }

    // LOT SIZE. The quantity must be a whole number of lots for this instrument.
    if (
      !Number.isFinite(instrument.lot_size) || instrument.lot_size <= 0 ||
      deps.requiredQuantity % instrument.lot_size !== 0
    ) {
      blockers.push({
        code: "leg_lot_size_invalid",
        role,
        detail:
          `${instrument.tradingsymbol} lot size ${instrument.lot_size} does not divide the ` +
          `required quantity ${deps.requiredQuantity}`,
      });
    }

    // EXPIRY. An expired contract is not tradable, whatever the cached book says.
    if (deps.tradingDayStartMs !== undefined) {
      const end = expiryEndOfDayMs(instrument.expiry);
      if (end === null) {
        blockers.push({
          code: "leg_expired",
          role,
          detail: `${instrument.tradingsymbol} has an unparseable expiry ${instrument.expiry}`,
        });
      } else if (end < deps.tradingDayStartMs) {
        blockers.push({
          code: "leg_expired",
          role,
          detail: `${instrument.tradingsymbol} expired on ${instrument.expiry}`,
        });
      }
    }
  }

  // INSTRUMENT IDENTITY: a box is one exchange. Legs spanning exchanges is a construction fault,
  // and would make the margin and coherence models meaningless.
  if (exchanges.size > 1) {
    blockers.push({
      code: "leg_exchange_mismatch",
      role: null,
      detail: `candidate legs span multiple exchanges (${[...exchanges].sort().join(", ")})`,
    });
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    sharedFailure: false,
    generation: deps.generation,
    legs,
  };
}

/** One-line operator summary of a verdict. Never contains a token, price or secret beyond codes. */
export function describeCandidateMarketDataVerdict(verdict: CandidateMarketDataVerdict): string {
  if (verdict.eligible) {
    return `candidate market-data evidence admissible in generation ${verdict.generation}`;
  }
  if (verdict.sharedFailure) {
    return verdict.blockers[0]?.detail ?? "market-data transport does not license new entry";
  }
  const byRole = verdict.blockers
    .map((b) => `${b.role ?? "candidate"}:${b.code}`)
    .join(", ");
  return `candidate market-data evidence insufficient (${byRole})`;
}
