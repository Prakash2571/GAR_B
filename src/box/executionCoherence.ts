/**
 * FOUR-LEG BOOK COHERENCE — the ONE shared admission decision.
 *
 * A box is four independent order books. Trading it as a single economic object
 * is only justified when those four books are, as far as we can evidence, a
 * COHERENT cross-sectional snapshot: each fresh on its own, and observed close
 * enough together that they plausibly describe the same market instant.
 *
 * Before this module the dispersion limit was enforced in EXACTLY ONE place — the
 * paper simulator (`executionSimulator.ts`) — and the LIVE gateway
 * (`executionGateway.ts`) never consulted it. The consequence was concrete: the
 * live path admitted four books spread 8,000 ms apart because each individual
 * quote age stayed under the 15,000 ms per-leg allowance, even though a 250 ms
 * cross-leg exchange-dispersion limit was configured. Per-leg freshness cannot
 * see cross-leg skew; only a cross-sectional gate can. So the gate now lives HERE,
 * in one pure function, and BOTH paths call it. They cannot drift because there is
 * only one decision to drift from.
 *
 * ── WHAT RECEIVE-TIME DISPERSION DOES AND DOES NOT PROVE ────────────────────────
 *
 * Receive-time is when OUR process saw each packet. Low receive-time dispersion
 * proves the four packets ARRIVED close together — it bounds how stale any leg can
 * be relative to the others in wall-clock terms we actually control. It does NOT
 * prove the exchange PUBLISHED the four books at the same instant: a burst of
 * queued packets can arrive together yet describe books the exchange stamped
 * seconds apart, and network jitter can spread genuinely simultaneous books. So
 * receive-time is a necessary, self-controllable liveness bound, not a proof of
 * simultaneity.
 *
 * Exchange-time dispersion is closer to the real question — but only as good as
 * the broker's timestamp semantics and precision allow (see BROKER_TIMESTAMP_NOTES
 * below). It is used as an ADMISSION CONSTRAINT when every leg carries a usable
 * exchange timestamp, and never fabricated when one does not.
 *
 * PURE and SIDE-EFFECT-FREE: it measures and decides; it never mutates state,
 * never emits metrics, never places an order. Callers own those.
 */

import type { BoxTemporalCoherence } from "./types.js";
import { temporalCoherence } from "./math.js";

/**
 * WHAT EACH BROKER'S "EXCHANGE TIMESTAMP" ACTUALLY IS — verified 2026-09-09.
 *
 * Zerodha Kite Connect v3 (WebSocket streaming, full mode)
 *   Source: https://kite.trade/docs/connect/v3/websocket/
 *   The `full` packet carries an "Exchange timestamp" at bytes 60-64 as an int32.
 *   It is EPOCH SECONDS, so its granularity is ONE SECOND (1000 ms). Two books the
 *   exchange published 400 ms apart can carry the SAME whole-second stamp, and two
 *   it published 1 ms either side of a second boundary can carry stamps a full
 *   second apart. Any exchange-dispersion threshold below ~1000 ms is therefore
 *   unsatisfiable-by-noise for Kite data and would reject coherent books purely on
 *   quantisation. `quote`/`ltp` modes carry NO exchange timestamp at all.
 *
 * DhanHQ v2 (live market feed)
 *   Source: https://dhanhq.co/docs/v2/live-market-feed/
 *   NEITHER the Quote packet NOR the Full packet (the one that carries 5-level
 *   market depth) contains a depth-publication timestamp. The only time field is
 *   "Last Trade Time (LTT) — EPOCH" (int32 seconds). LTT is when the instrument
 *   LAST TRADED, not when this depth snapshot was published — an illiquid leg can
 *   carry an LTT many seconds (or minutes) old while its book is currently being
 *   quoted. Substituting LTT for a book-publication time would therefore reject
 *   live, tradeable books for being "stale" when they are not, and — worse — could
 *   admit a genuinely stale book whose last trade merely happened to be recent.
 *   So Dhan supplies NO usable order-book exchange timestamp; the coherence policy
 *   must fall back to receive-time for Dhan legs and MUST NOT invent one from LTT.
 *
 * CONSEQUENCE FOR THRESHOLDS: an exchange-dispersion threshold must be broker-aware
 * and never sub-second for coarse Kite stamps, and the receive-time constraint is
 * the always-available floor that carries Dhan (and mixed/missing-timestamp) cases.
 */
export const BROKER_TIMESTAMP_NOTES = {
  zerodha: {
    exchange_ts_available: true,
    exchange_ts_precision_ms: 1000,
    note: "Kite full-mode exchange timestamp is epoch SECONDS (1s granularity). quote/ltp carry none.",
    source: "https://kite.trade/docs/connect/v3/websocket/",
  },
  dhan: {
    exchange_ts_available: false,
    exchange_ts_precision_ms: null,
    note: "Dhan feed carries only Last Trade Time (LTT), NOT a depth-publication time. Never use LTT as a book timestamp.",
    source: "https://dhanhq.co/docs/v2/live-market-feed/",
  },
  verified_on: "2026-09-09",
} as const;

/**
 * Is the configured exchange-dispersion bound BELOW the active broker's stamp precision?
 *
 * WHY THIS EXISTS. The notes above stated the rule — "an exchange-dispersion threshold must be
 * broker-aware and never sub-second for coarse Kite stamps" — and NOTHING READ THEM. They were
 * documentation the code never consulted, so the rule was enforced only by whoever happened to have
 * read this file. Two shipped deploy templates set 250ms against Kite's 1000ms stamps, one of them
 * with a comment asserting the receive-time gate "actually governs" (it does not: the exchange bound
 * applies whenever it is > 0 and all four legs carry a stamp, which for Kite depth packets is
 * always). The result was a deployment refusing 100% of entries with `cross_leg_time_skew` on a
 * perfectly healthy feed.
 *
 * A bound below the broker's precision is not a stricter safety setting — it is an UNSATISFIABLE one.
 * Dispersion can only take values that are multiples of the precision, so any limit between 1 and
 * precision-1 admits exactly the same books as 0 would while refusing every boundary-straddling set.
 *
 * WARNS, DOES NOT THROW. Unlike the live-mode coordinator check, this cannot silently remove a
 * protection: the failure mode is over-refusal, which costs opportunity rather than money, and a
 * paper run may legitimately want to observe the quantisation behaviour. Refusing boot over it would
 * also be hostile on brokers where the bound is inert. So it is loud and non-fatal.
 *
 * Returns null when there is nothing to say: the bound is disabled (0), the broker publishes no book
 * timestamp (Dhan — the check never fires), or the bound is at or above the precision.
 */
export function coherencePrecisionWarning(args: {
  readonly broker: string;
  readonly maxExchangeDispersionMs: number;
}): string | null {
  // 0 is an explicit, documented "disabled". An operator who chose it does not need advice.
  if (args.maxExchangeDispersionMs <= 0) return null;
  // Narrowed explicitly rather than indexed, because BROKER_TIMESTAMP_NOTES also carries
  // `verified_on` and an arbitrary-string index would not typecheck against it.
  const notes =
    args.broker === "zerodha"
      ? BROKER_TIMESTAMP_NOTES.zerodha
      : args.broker === "dhan"
        ? BROKER_TIMESTAMP_NOTES.dhan
        : null;
  if (notes === null) return null;
  // No book timestamp ⇒ `temporalCoherence` leaves exchange dispersion null ⇒ the bound is never
  // applied. Warning about it would send an operator to fix a setting that changes nothing.
  if (!notes.exchange_ts_available) return null;
  const precision: number | null = notes.exchange_ts_precision_ms;
  if (precision === null || args.maxExchangeDispersionMs >= precision) return null;

  return (
    `[Box] BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS=${args.maxExchangeDispersionMs} is BELOW ` +
    `${args.broker}'s exchange-timestamp precision of ${precision}ms, so it is ` +
    `UNSATISFIABLE-BY-QUANTISATION, not strict. ${notes.note} Cross-leg exchange dispersion can only ` +
    `be a multiple of ${precision}ms, so four books the exchange published milliseconds apart measure ` +
    `as either 0ms or ${precision}ms depending purely on which side of a second boundary they fell — ` +
    `and the ${precision}ms case is then refused as cross_leg_time_skew. Expect coherent boxes to be ` +
    `rejected. Set it to ${precision} (a coarse sanity check that still catches genuinely separated ` +
    `stamps) or to 0 (disabled), and rely on BOX_MAX_CROSS_LEG_RECEIVE_DISPERSION_MS for sub-second ` +
    `coherence — that gate uses our own millisecond arrival clock and is the precise one. See ${notes.source}`
  );
}

/** One leg's evidence at the instant coherence is being judged. */
export interface CoherenceLegObservation {
  role: string;
  /** Epoch ms this book was RECEIVED (the freshness/liveness clock). Null ⇒ no book. */
  received_at: number | null;
  /**
   * The book's EXCHANGE timestamp (epoch ms), ONLY when the broker supplies a real
   * ORDER-BOOK publication time. Null for Dhan, for Kite quote/ltp modes, and for
   * any leg whose feed did not carry one. NEVER derived from a last-trade time.
   */
  exchange_at: number | null;
  /** Monotonic local version at the moment judged — for duplicate/movement checks. */
  current_version: number | null;
  /**
   * The version this leg carried at admission/detection. A change means the book
   * MOVED since; equality across a re-check window means the book is UNCHANGED
   * (which is exactly what the receive-age freshness allowance covers).
   */
  reference_version: number | null;
  /**
   * The socket GENERATION this book belongs to. A reconnect bumps the generation
   * and invalidates every prior book (see quotes.ts invalidateGeneration). A leg
   * observed under a stale generation is not evidence at all.
   */
  generation: number | null;
  /** Whether this leg currently has usable two-sided depth. Depthless ⇒ not admissible. */
  has_depth: boolean;
}

/**
 * The coherence policy in force. Broker-aware because the only broker that even
 * offers an exchange timestamp (Zerodha) offers it at 1s granularity, and the
 * other (Dhan) offers none — so a single sub-second exchange threshold would make
 * real data unusable.
 */
export interface CoherencePolicy {
  /**
   * MAXIMUM PER-LEG BOOK AGE (ms), measured from receive time. This is the same
   * freshness allowance the rest of the system uses (quoteMaxAgeMs); a leg older
   * than this is stale regardless of how the four legs line up.
   */
  maxLegAgeMs: number;
  /**
   * MAXIMUM CROSS-LEG RECEIVE-TIME DISPERSION (ms) — an ADMISSION CONSTRAINT, not a
   * diagnostic. newest − oldest receive time across the legs must not exceed this.
   * This is the always-available cross-sectional bound; it carries Dhan and every
   * missing-exchange-timestamp case. 0 means DISABLED (see zeroReceiveDispersionDisables).
   */
  maxReceiveDispersionMs: number;
  /**
   * MAXIMUM CROSS-LEG EXCHANGE-TIME DISPERSION (ms), applied ONLY when every leg
   * carries a usable exchange timestamp. Should be >= the coarsest per-broker
   * precision (1000 ms for Kite) or it rejects coherent books on quantisation
   * alone. 0 means the exchange-dispersion check is disabled (receive-time still
   * applies).
   */
  maxExchangeDispersionMs: number;
  /**
   * How the operator has chosen to read a receive-dispersion limit of 0.
   *
   * `true`  ⇒ 0 DISABLES the receive-dispersion admission constraint (legacy/paper
   *           default; the exchange check and per-leg age still apply).
   * `false` ⇒ 0 is IMPOSSIBLE TO SATISFY, i.e. it hard-rejects every multi-leg
   *           admission. This exists so a live operator cannot accidentally get
   *           "no cross-leg enforcement" from a 0 without knowing it — a live
   *           deployment that truly wants no receive-dispersion gate must set this
   *           flag explicitly.
   */
  zeroReceiveDispersionDisables: boolean;
  /**
   * Reject clock anomalies. A negative age (book stamped in the future) or an
   * exchange timestamp implausibly ahead of receive time is a clock/feed fault,
   * never coherence evidence. Always on in practice; a flag only so tests can
   * exercise the arithmetic in isolation.
   */
  rejectClockAnomalies: boolean;
  /**
   * Maximum plausible (received_at − exchange_at). A book cannot be RECEIVED before
   * the exchange published it (that is future skew) and should not lag it by an
   * absurd amount either. Generous by default because exchange stamps are coarse.
   */
  maxReceiveToExchangeDelayMs: number;
  /**
   * How far an exchange timestamp may sit AHEAD of receive time before it is a clock
   * fault. This is NOT normally negative in production (the exchange stamps a book
   * before we receive it), but it is bounded-tolerant rather than zero-tolerant for
   * two real reasons: Kite's exchange timestamp is 1-second-granular (so a book
   * received 200 ms after publication can carry a stamp rounded UP past receive
   * time), and the exchange clock and our host clock are not perfectly synchronised.
   * A stamp further ahead than this is a genuine future-clock anomaly and rejected.
   */
  maxExchangeAheadOfReceiveMs: number;
}

/**
 * The shared "ahead of receive time" tolerance, in ms.
 *
 * EXPORTED so `candidateMarketData` uses the SAME number. Two admission layers read the same
 * exchange-timestamp input, and they used to disagree completely: this layer tolerated 1500ms and
 * documented exactly why, while `candidateMarketData` rejected ANY negative source age. Under a host
 * clock a second or two behind NSE's, that zero-tolerance test failed all four legs at once and
 * silently stopped every entry — reported as "stale at the exchange", which is the opposite of the
 * truth. A shared constant is what stops the two drifting apart again.
 *
 * The 1.5s figure covers the two real causes: Kite's exchange timestamp is 1-second granular (the
 * parser floors it, so a book can carry a stamp up to 999ms off its true publish instant), and the
 * exchange clock and the host clock are never perfectly synchronised.
 */
export const DEFAULT_MAX_EXCHANGE_AHEAD_MS = 1_500;

/** Why a coherence decision failed — a small, stable, low-cardinality vocabulary. */
export type CoherenceRejectReason =
  | "missing_book"
  | "depthless_book"
  | "stale_generation"
  | "generation_split"
  | "clock_anomaly"
  | "per_leg_stale"
  | "receive_dispersion"
  | "exchange_dispersion"
  | "duplicate_stall";

export interface CoherenceDecision {
  admit: boolean;
  reason: CoherenceRejectReason | null;
  detail: string | null;
  /**
   * The measured coherence figures, ALWAYS returned (admit or reject) so the caller
   * can record them for the trade audit. Reusing BoxTemporalCoherence keeps the
   * status/audit shape identical to what the simulator already surfaced.
   */
  temporal: BoxTemporalCoherence;
  /**
   * WHICH constraint actually decided admission, so status output can state plainly
   * what was and was not proven (see the module header). `exchange` when the
   * exchange-time constraint was the binding evidence; `receive` when only
   * receive-time was available; `none` when no multi-leg constraint applied.
   */
  basis: "exchange" | "receive" | "none";
}

/**
 * A conservative live default policy derived from the shared config.
 *
 * `maxReceiveDispersionMs` reuses the exchange-dispersion knob's numeric value as
 * the receive-time bound too, because the receive-time constraint is the one that
 * is ALWAYS available (Dhan has no exchange stamp, Kite's is coarse) and so must be
 * the primary live gate. The exchange constraint is applied on top when present.
 */
export function livePolicyFromConfig(cfg: {
  quoteMaxAgeMs: number;
  maxCrossLegExchangeDispersionMs: number;
  coherenceZeroDispersionDisablesInLive?: boolean;
  maxCrossLegReceiveDispersionMs?: number;
  maxReceiveToExchangeDelayMs?: number;
  maxExchangeAheadOfReceiveMs?: number;
}): CoherencePolicy {
  const exchange = Math.max(0, cfg.maxCrossLegExchangeDispersionMs);
  // The receive-time bound: an explicit knob if provided, else the exchange knob's
  // magnitude, else a conservative fallback. Receive-time is what we control, so it
  // is never left implicitly unbounded when an exchange number exists.
  const receive = cfg.maxCrossLegReceiveDispersionMs !== undefined
    ? Math.max(0, cfg.maxCrossLegReceiveDispersionMs)
    : exchange;
  return {
    maxLegAgeMs: Math.max(0, cfg.quoteMaxAgeMs),
    maxReceiveDispersionMs: receive,
    maxExchangeDispersionMs: exchange,
    // LIVE reads 0 as "disabled" only when the operator has explicitly opted in.
    // Default false: in live, a 0 receive-dispersion limit is impossible-to-satisfy
    // rather than a silent bypass, so an unconfigured operator is protected.
    zeroReceiveDispersionDisables: cfg.coherenceZeroDispersionDisablesInLive === true,
    rejectClockAnomalies: true,
    maxReceiveToExchangeDelayMs: cfg.maxReceiveToExchangeDelayMs ?? 5_000,
    // Kite's exchange stamp is 1s-granular and clocks differ, so tolerate up to
    // ~1.5s of "ahead" skew before calling it a future-clock fault.
    maxExchangeAheadOfReceiveMs:
      cfg.maxExchangeAheadOfReceiveMs ?? DEFAULT_MAX_EXCHANGE_AHEAD_MS,
  };
}

/**
 * The PAPER policy: identical arithmetic, but a 0 dispersion limit DISABLES the
 * cross-leg gate (the historical paper-simulator behaviour, preserved so paper runs
 * stay comparable and so a 0 in a research config keeps meaning "off"). Live and
 * paper share the SAME function; only this one documented reading of 0 differs.
 */
export function paperPolicyFromConfig(cfg: {
  quoteMaxAgeMs: number;
  maxCrossLegExchangeDispersionMs: number;
  maxCrossLegReceiveDispersionMs?: number;
  maxReceiveToExchangeDelayMs?: number;
  maxExchangeAheadOfReceiveMs?: number;
}): CoherencePolicy {
  const base = livePolicyFromConfig(cfg);
  return { ...base, zeroReceiveDispersionDisables: true };
}

/**
 * THE ONE DECISION. Given each leg's evidence and the policy, decide whether the
 * four books may be admitted as a coherent snapshot.
 *
 * ENTRY-ONLY. This gate refuses to OPEN exposure on incoherent books. It must
 * NEVER be applied to protective reduction of exposure already owned: reducing risk
 * cannot be blocked by an entry-freshness rule (see liveEntryGuard.ts's entry-only
 * discipline). `evaluateReductionCoherence` below is the reduction-side counterpart
 * and deliberately does far less.
 *
 * Order of checks is deliberate: cheapest structural failures first (missing/
 * depthless/generation), then clock sanity, then per-leg age, then the two
 * cross-leg dispersion constraints. The first failure wins so the reason is stable.
 */
export function evaluateBookCoherence(
  legs: CoherenceLegObservation[],
  policy: CoherencePolicy,
  now: number,
  opts: { currentGeneration?: number | null } = {},
): CoherenceDecision {
  const temporal = temporalCoherence(
    legs.map((l) => ({
      received_at: l.received_at,
      exchange_at: l.exchange_at,
      current_version: l.current_version,
      detection_version: l.reference_version,
    })),
    now,
  );
  const decide = (
    admit: boolean,
    reason: CoherenceRejectReason | null,
    detail: string | null,
    basis: CoherenceDecision["basis"],
  ): CoherenceDecision => ({ admit, reason, detail, temporal, basis });

  // 1. STRUCTURE. Every leg must have a current book with depth in a single, current
  //    generation. A missing/depthless/wrong-generation leg is not incoherent — it is
  //    not evidence at all — so it fails closed before any timing arithmetic.
  const generations = new Set<number>();
  for (const leg of legs) {
    if (leg.received_at === null) {
      return decide(false, "missing_book", `${leg.role} has no current book`, "none");
    }
    if (!leg.has_depth) {
      return decide(false, "depthless_book", `${leg.role} has no usable two-sided depth`, "none");
    }
    if (opts.currentGeneration != null) {
      if (leg.generation == null) {
        return decide(false, "stale_generation", `${leg.role} carries no socket generation`, "none");
      }
      if (leg.generation !== opts.currentGeneration) {
        return decide(false, "stale_generation", `${leg.role} book is from a superseded socket generation`, "none");
      }
    }
    if (leg.generation != null) generations.add(leg.generation);
  }
  // Even without a caller-supplied current generation, the four legs must agree on
  // ONE generation. Two legs from different reconnect epochs can never form a
  // coherent cross-sectional snapshot.
  if (generations.size > 1) {
    return decide(false, "generation_split", `legs span ${generations.size} socket generations`, "none");
  }

  // 2. CLOCK SANITY. A book stamped in the future (negative age) or received before
  //    its own exchange timestamp is a clock/feed fault, not coherence evidence.
  if (policy.rejectClockAnomalies) {
    for (const leg of legs) {
      const age = now - (leg.received_at as number);
      if (!Number.isFinite(age) || age < 0) {
        return decide(false, "clock_anomaly", `${leg.role} book is stamped in the future (age ${age}ms)`, "none");
      }
      if (leg.exchange_at !== null) {
        const delay = (leg.received_at as number) - leg.exchange_at;
        if (!Number.isFinite(delay)) {
          return decide(false, "clock_anomaly", `${leg.role} has a non-finite receive-to-exchange delay`, "none");
        }
        // A stamp AHEAD of receive time (negative delay) is tolerated up to a bound
        // because coarse (1s) exchange stamps round and exchange/host clocks differ;
        // beyond the bound it is a genuine future-clock fault.
        if (delay < 0 && -delay > policy.maxExchangeAheadOfReceiveMs) {
          return decide(false, "clock_anomaly", `${leg.role} exchange timestamp is ${-delay}ms ahead of receive time (exceeds ${policy.maxExchangeAheadOfReceiveMs}ms)`, "none");
        }
        if (delay > policy.maxReceiveToExchangeDelayMs) {
          return decide(false, "clock_anomaly", `${leg.role} receive-to-exchange delay ${delay}ms exceeds ${policy.maxReceiveToExchangeDelayMs}ms`, "none");
        }
      }
    }
  }

  // 3. PER-LEG AGE. Each book fresh on its own terms. Independent of dispersion:
  //    four books can be tightly clustered yet all four uniformly stale.
  for (const leg of legs) {
    const age = now - (leg.received_at as number);
    if (age > policy.maxLegAgeMs) {
      return decide(false, "per_leg_stale", `${leg.role} book age ${age}ms exceeds ${policy.maxLegAgeMs}ms`, "none");
    }
  }

  // A single leg cannot be "dispersed" against itself; nothing further to prove.
  if (legs.length < 2) return decide(true, null, null, "none");

  // 4. CROSS-LEG RECEIVE-TIME DISPERSION — the always-available admission constraint.
  const receiveDispersion = temporal.receive_dispersion_ms;
  const receiveEnabled = policy.maxReceiveDispersionMs > 0 || !policy.zeroReceiveDispersionDisables;
  if (receiveEnabled && receiveDispersion !== null) {
    if (policy.maxReceiveDispersionMs === 0 && !policy.zeroReceiveDispersionDisables) {
      // 0 in a policy that does NOT treat 0 as "disabled" (the live default) means the
      // constraint is impossible to satisfy for any multi-leg admission. This is the
      // documented guard against a 0 silently meaning "no enforcement" in live.
      return decide(
        false,
        "receive_dispersion",
        `receive-time dispersion ${receiveDispersion}ms cannot satisfy a 0ms limit (limit is impossible-to-satisfy, not disabled)`,
        "receive",
      );
    }
    if (receiveDispersion > policy.maxReceiveDispersionMs) {
      return decide(
        false,
        "receive_dispersion",
        `receive-time dispersion ${receiveDispersion}ms exceeds ${policy.maxReceiveDispersionMs}ms ` +
          `(proves arrival spread only, not exchange simultaneity)`,
        "receive",
      );
    }
  }

  // 5. CROSS-LEG EXCHANGE-TIME DISPERSION — applied ONLY when EVERY leg has a usable
  //    exchange timestamp (temporal.exchange_dispersion_ms is null otherwise). Never
  //    fabricated from a last-trade time or a missing stamp.
  const exchangeDispersion = temporal.exchange_dispersion_ms;
  if (policy.maxExchangeDispersionMs > 0 && exchangeDispersion !== null) {
    if (exchangeDispersion > policy.maxExchangeDispersionMs) {
      return decide(
        false,
        "exchange_dispersion",
        `exchange-timestamp dispersion ${exchangeDispersion}ms exceeds ${policy.maxExchangeDispersionMs}ms`,
        "exchange",
      );
    }
    // Exchange evidence was present AND within bound: it is the binding basis.
    return decide(true, null, null, "exchange");
  }

  // Admitted on receive-time evidence alone (Dhan, mixed, or coarse-stamp fallback).
  return decide(true, null, null, receiveDispersion !== null ? "receive" : "none");
}

/**
 * RE-CHECK a previously-admitted box against CURRENT evidence, immediately before a
 * later leg transmits. A book coherent at admission can be stale by the time leg 4
 * is sent. This is the same decision as admission — it must be, or the two would
 * drift — plus a DUPLICATE/STALL guard: if the reference versions are supplied and
 * NONE of the legs' books advanced, and the elapsed time already exceeds the per-leg
 * age, the feed has stalled on duplicate packets and re-admission must fail.
 *
 * ENTRY-ONLY, exactly like `evaluateBookCoherence`.
 */
export function recheckBookCoherence(
  legs: CoherenceLegObservation[],
  policy: CoherencePolicy,
  now: number,
  opts: { currentGeneration?: number | null } = {},
): CoherenceDecision {
  const base = evaluateBookCoherence(legs, policy, now, opts);
  if (!base.admit) return base;

  // DUPLICATE / STALL: a feed replaying the same packet keeps `current_version`
  // pinned to `reference_version`. If nothing moved AND every book is at/over the age
  // limit, we are not looking at a coherent live book, only a stale one echoed. When
  // reference versions are absent we cannot assert movement, so we do not claim it.
  const comparable = legs.filter((l) => l.reference_version !== null && l.current_version !== null);
  if (comparable.length === legs.length && comparable.length > 0) {
    const anyMoved = comparable.some((l) => l.current_version !== l.reference_version);
    const allAtOrOverAge = legs.every(
      (l) => l.received_at !== null && now - l.received_at >= policy.maxLegAgeMs,
    );
    if (!anyMoved && allAtOrOverAge) {
      return {
        admit: false,
        reason: "duplicate_stall",
        detail: "no leg book advanced and all are at/over the age limit; feed appears stalled on duplicate packets",
        temporal: base.temporal,
        basis: base.basis,
      };
    }
  }
  return base;
}

/**
 * PROTECTIVE-REDUCTION coherence — deliberately NOT the entry gate.
 *
 * Reducing owned exposure (unwind, residual flatten) must NEVER be blocked by an
 * entry-freshness or cross-leg-dispersion rule. Blocking a risk-reducing order
 * because the four books are not a tidy snapshot would strand real naked exposure —
 * strictly worse than the incoherence it was worried about. So this checks ONLY the
 * single thing a reduction genuinely needs: that the ONE leg it is about to reduce
 * has a current, depthful book to price against. It never looks at the other legs,
 * never looks at dispersion, and never looks at per-leg age as a REJECTION (a stale
 * book still lets a protective order rest at a bounded limit).
 *
 * This mirrors liveEntryGuard.ts's entry-only scope discipline.
 */
export function evaluateReductionCoherence(
  leg: Pick<CoherenceLegObservation, "role" | "received_at" | "has_depth">,
): { admit: boolean; reason: CoherenceRejectReason | null; detail: string | null } {
  if (leg.received_at === null) {
    return { admit: false, reason: "missing_book", detail: `${leg.role} has no current book to price a reduction against` };
  }
  if (!leg.has_depth) {
    return { admit: false, reason: "depthless_book", detail: `${leg.role} has no usable depth to price a reduction against` };
  }
  return { admit: true, reason: null, detail: null };
}
