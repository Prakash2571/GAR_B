/**
 * ACCOUNT FUNDS — how much of the account is actually free to trade, right now.
 *
 * WHY THIS EXISTS AS ITS OWN THING
 *
 * The number already existed, but only as a by-product of live entry admission: `available_funds`
 * inside `economic_admission.picture`, produced by `evaluateEntryEconomics` and therefore
 *
 *   · `null` in every paper mode,
 *   · `null` in live when all three funding gates are off,
 *   · `null` in live until the FIRST entry has been economically evaluated, and
 *   · thereafter frozen at whatever the last entry attempt observed — which may be hours old.
 *
 * So the one figure an operator most wants before arming was, precisely then, absent. This module
 * owns it as a standing observation with its own refresh, its own freshness and its own provenance,
 * so it can be published continuously and read honestly.
 *
 * THE THREE STATES THAT MUST NOT COLLAPSE INTO EACH OTHER
 *
 *   NEVER OBSERVED   no session, no adapter, or the first read has not returned. `null`, and the
 *                    reason says which. This is NOT ₹0.
 *   OBSERVED         a broker figure with the instant it was taken. Freshness is a separate question
 *                    from presence: a 40-second-old balance is real, just old, and hiding it would
 *                    be worse than labelling it.
 *   FAILED           a read was attempted and errored. The LAST GOOD figure is retained and marked
 *                    stale rather than discarded — an operator mid-session needs "₹47,000 as of 40s
 *                    ago, refresh failing" far more than they need a blank.
 *
 * SPENDABLE, NOT "AVAILABLE". The published headline is run through `usableFundsRupees`, the same
 * per-broker semantics the live admission gate uses. That matters and is not cosmetic: for Zerodha
 * `available.live_balance` is documented as already net of the encumbrance, so subtracting
 * `utilised.debits` would understate free capital by the amount already blocked — and for a broker
 * whose semantics are UNVERIFIED the conservative reading is applied instead. Deriving the number
 * twice, once for the gate and once for the screen, is how a UI comes to disagree with the engine
 * about whether an entry was affordable.
 *
 * PURE AND CLOCK-INJECTED. It performs no I/O itself: the caller supplies a reader. That keeps every
 * state transition testable without a broker, which is the only way the "unknown is not zero"
 * discipline can actually be asserted.
 */

import type { BrokerId } from "../brokers/types.js";
import {
  DEFAULT_FUNDS_BASIS,
  knownBrokerFundsSemantics,
  usableFundsRupees,
  type AvailableFundsSemantics,
  type FundsBasis,
  type FundsComponents,
} from "./fundsSemantics.js";

/** What a broker's funds endpoint returned, verbatim. Nulls are UNKNOWN, never zero. */
export interface RawFundsObservation {
  /** The broker's own "available" figure, in rupees. */
  readonly availableRupees: number | null;
  /** What the broker reports as already blocked/utilised, in rupees. */
  readonly utilisedRupees: number | null;
  /**
   * EVERY numeric field the endpoint carried, keyed by the broker's own field name.
   *
   * Optional, so a provider that supplies only the headline pair behaves exactly as before. Present,
   * it is what makes the headline EXPLAINABLE: an operator comparing our figure against their
   * broker's own funds screen can see which component accounts for a difference instead of having to
   * take the single number on trust.
   */
  readonly components?: FundsComponents | null;
}

/** Why no usable figure is being published. */
export type FundsUnavailableReason =
  /** No authenticated broker session, so nothing can be asked. */
  | "no_session"
  /** The deployment has no funds reader wired for this broker. */
  | "not_supported"
  /** A read is configured and has not completed yet. */
  | "never_read"
  /** The last read failed and there is no earlier figure to fall back on. */
  | "read_failed"
  /** The broker answered but carried no finite figure we could use. */
  | "not_reported"
  /** The broker's funds semantics are not declared, so the number cannot be interpreted as money. */
  | "semantics_unknown";

/** The published account-funds snapshot. */
export interface AccountFundsSnapshot {
  /**
   * SPENDABLE rupees — the headline. Null whenever it is not known, and null is never ₹0.
   *
   * Derived through the declared per-broker semantics, so it means the same thing the live
   * admission gate means by it.
   */
  readonly free_to_trade_rupees: number | null;
  /** The broker's raw "available" figure, before semantics are applied. Null when unknown. */
  readonly broker_available_rupees: number | null;
  /** What the broker says is already blocked. Null when unknown — NOT zero. */
  readonly broker_utilised_rupees: number | null;
  /**
   * THE FULL BREAKDOWN the broker reported, keyed by its own field names.
   *
   * Published so the headline can be CHECKED rather than believed. An operator whose broker screen
   * shows a much larger figure can read down this object and see exactly which component the
   * headline does and does not include — which is the difference between "the number looks wrong"
   * and "the number excludes `available.collateral`, and here it is".
   *
   * Empty when the provider supplied no breakdown; never fabricated.
   */
  readonly components: FundsComponents;
  /** Which component was treated as spendable (`BOX_ZERODHA_FUNDS_BASIS`). */
  readonly basis: FundsBasis;
  /** Which broker the figure is about. */
  readonly broker: BrokerId | null;
  /** How `broker_available_rupees` was interpreted to reach the headline. */
  readonly semantics: AvailableFundsSemantics | null;
  /** True when the broker documents `available` as already net of the encumbrance. */
  readonly encumbrance_netted: boolean;
  /** Epoch ms the figure was observed, or null when never observed. */
  readonly observed_at: number | null;
  /** Age in ms at publication, or null when never observed. Never negative. */
  readonly age_ms: number | null;
  /** True when the figure is present AND within the freshness bound. */
  readonly fresh: boolean;
  /** Why there is no usable figure, or null when there is one. */
  readonly unavailable_reason: FundsUnavailableReason | null;
  /** The last read error, bounded and safe to display. Never a token or a URL with credentials. */
  readonly last_error: string | null;
  /** One operator-facing sentence stating exactly what this figure can and cannot prove. */
  readonly note: string;
}

/** A snapshot for a deployment that cannot produce one at all. */
export function unavailableFunds(
  reason: FundsUnavailableReason,
  note: string,
  broker: BrokerId | null = null,
): AccountFundsSnapshot {
  return {
    free_to_trade_rupees: null,
    broker_available_rupees: null,
    broker_utilised_rupees: null,
    components: {},
    basis: DEFAULT_FUNDS_BASIS,
    broker,
    semantics: null,
    encumbrance_netted: false,
    observed_at: null,
    age_ms: null,
    fresh: false,
    unavailable_reason: reason,
    last_error: null,
    note,
  };
}

/**
 * The standing funds observation.
 *
 * Holds at most ONE observation and its provenance. Deliberately not a history: the question is
 * "what is free now?", and keeping a series would invite a chart that implies a precision this
 * figure does not have (it is a REST snapshot on a timer, not a stream).
 */
export interface AccountFundsTrackerOptions {
  /** How old a figure may be and still be called fresh. */
  readonly freshnessMaxAgeMs: number;
  readonly now: () => number;
  /**
   * Which reported component is spendable (`BOX_ZERODHA_FUNDS_BASIS`).
   *
   * Optional; omitted ⇒ {@link DEFAULT_FUNDS_BASIS}, the shipped behaviour. Passed through to
   * `usableFundsRupees` so this tile and the live admission gate resolve the basis identically.
   */
  readonly basis?: FundsBasis;
}

export class AccountFundsTracker {
  private observedAt: number | null = null;
  private raw: RawFundsObservation | null = null;
  private broker: BrokerId | null = null;
  private lastError: string | null = null;
  /** True once a read has been attempted, so "never read" and "read failed" stay distinguishable. */
  private attempted = false;
  private readonly opts: AccountFundsTrackerOptions;

  // Assigned explicitly rather than via a parameter property, so this module can be executed
  // directly from source by `node --experimental-strip-types` (which rejects parameter properties).
  // That matters here: the "unknown is never ₹0" discipline is only worth anything if every state
  // transition can be asserted without a broker, a database or a build step.
  constructor(opts: AccountFundsTrackerOptions) {
    this.opts = opts;
  }

  /** Record a successful read. */
  record(broker: BrokerId, raw: RawFundsObservation, at = this.opts.now()): void {
    this.attempted = true;
    this.broker = broker;
    this.raw = raw;
    this.observedAt = at;
    this.lastError = null;
  }

  /**
   * Record a FAILED read, KEEPING any earlier figure.
   *
   * The previous observation is not discarded, because an operator mid-session is far better served
   * by "₹47,000 as of 40 seconds ago, refresh failing" than by a blank. The staleness is visible
   * through `age_ms`/`fresh`, and the error is published alongside, so nothing is being hidden — the
   * figure is simply not thrown away for being old.
   */
  recordFailure(error: string, broker: BrokerId | null = null): void {
    this.attempted = true;
    if (broker !== null) this.broker = broker;
    // Bounded and stripped of anything that could carry a credential.
    this.lastError = error.replace(/\s+/g, " ").slice(0, 200);
  }

  /** Forget everything. Called on a broker switch: one broker's balance is not another's. */
  reset(): void {
    this.observedAt = null;
    this.raw = null;
    this.broker = null;
    this.lastError = null;
    this.attempted = false;
  }

  /** Whether a read has ever been attempted, for deciding between `never_read` and `read_failed`. */
  get hasAttempted(): boolean {
    return this.attempted;
  }

  /** Milliseconds since the last successful observation, or null when there is none. */
  ageMs(): number | null {
    if (this.observedAt === null) return null;
    // Clamped at zero: a wall-clock step backwards must never publish a negative age, which would
    // read as a figure from the future.
    return Math.max(0, this.opts.now() - this.observedAt);
  }

  /**
   * Project the current state into the published snapshot.
   *
   * `sessionReady` is the caller's answer to "is there an authenticated broker session at all?" —
   * asked here rather than inferred, because "no session" and "session but no figure yet" need
   * different words on screen and only the caller knows which it is.
   */
  snapshot(args: { readonly sessionReady: boolean; readonly supported: boolean }): AccountFundsSnapshot {
    if (!args.supported) {
      return unavailableFunds(
        "not_supported",
        "This deployment has no funds reader wired for the active broker, so free capital cannot be reported.",
        this.broker,
      );
    }
    if (!args.sessionReady && this.raw === null) {
      return unavailableFunds(
        "no_session",
        "No authenticated broker session, so the account balance cannot be read. This is NOT a zero balance.",
        this.broker,
      );
    }
    if (this.raw === null || this.broker === null) {
      return {
        ...unavailableFunds(
          this.attempted ? "read_failed" : "never_read",
          this.attempted
            ? "The balance could not be read from the broker. No figure is published rather than a " +
              "misleading zero."
            : "The balance has not been read yet. This is NOT a zero balance.",
          this.broker,
        ),
        last_error: this.lastError,
      };
    }

    const verdict = usableFundsRupees({
      broker: this.broker,
      availableRupees: this.raw.availableRupees,
      utilisedRupees: this.raw.utilisedRupees,
      components: this.raw.components,
      basis: this.opts.basis,
    });
    // The DECLARED semantics enum, read from the registry rather than from the verdict: the verdict's
    // `basis` is a prose audit sentence for a log line, not a machine-readable classification, and
    // publishing prose in an enum field would break every client that switches on it.
    const declared = knownBrokerFundsSemantics(this.broker);
    const semantics: AvailableFundsSemantics | null =
      declared?.availableIsNetOfEncumbrance ?? (verdict.semanticsUnverified ? "unverified" : null);
    const ageMs = this.ageMs();
    const fresh = verdict.value_rupees !== null && ageMs !== null && ageMs <= this.opts.freshnessMaxAgeMs;
    const reason: FundsUnavailableReason | null =
      verdict.value_rupees !== null
        ? null
        : // Distinguished on purpose: "the broker did not report a number" is a transport/API fact an
          // operator can wait out, whereas "we do not know what this broker's number MEANS" is a
          // permanent limitation of this deployment that no amount of retrying will fix.
          verdict.semanticsUnverified
          ? "semantics_unknown"
          : "not_reported";

    return {
      free_to_trade_rupees: verdict.value_rupees,
      broker_available_rupees: this.raw.availableRupees,
      broker_utilised_rupees: this.raw.utilisedRupees,
      components: this.raw.components ?? {},
      basis: this.opts.basis ?? DEFAULT_FUNDS_BASIS,
      broker: this.broker,
      semantics,
      encumbrance_netted: verdict.encumbranceNettedFromAvailable,
      observed_at: this.observedAt,
      age_ms: ageMs,
      fresh,
      unavailable_reason: reason,
      last_error: this.lastError,
      note: fundsNote({
        value: verdict.value_rupees,
        fresh,
        ageMs,
        maxAgeMs: this.opts.freshnessMaxAgeMs,
        // `basis` IS the prose audit sentence on the verdict (there is no `note` field on it), and it
        // is the one place that explains how the figure was derived for this broker's semantics.
        verdictNote: verdict.basis,
        lastError: this.lastError,
      }),
    };
  }
}

/**
 * The operator-facing sentence.
 *
 * Deliberately says what the number does NOT prove. This figure is an account balance on a timer; it
 * is not a guarantee that a specific box is affordable, because margin for a four-leg structure is a
 * different question that only the broker's basket-margin endpoint can answer. Presenting it without
 * that caveat would invite exactly the inference the economic-admission gate exists to make properly.
 */
function fundsNote(args: {
  readonly value: number | null;
  readonly fresh: boolean;
  readonly ageMs: number | null;
  readonly maxAgeMs: number;
  readonly verdictNote: string;
  readonly lastError: string | null;
}): string {
  if (args.value === null) return args.verdictNote;
  const age = args.ageMs === null ? "unknown age" : `${Math.round(args.ageMs / 1000)}s old`;
  const staleness = args.fresh
    ? `${age}.`
    : `${age}, older than the ${Math.round(args.maxAgeMs / 1000)}s freshness bound — treat as indicative.`;
  const failing = args.lastError === null ? "" : ` The most recent refresh FAILED (${args.lastError}).`;
  return (
    `Spendable account balance as reported by the broker, ${staleness} ${args.verdictNote}` +
    ` It does NOT prove a specific box is affordable — four-leg margin is a separate question the ` +
    `economic-admission gate answers against the broker's basket margin.${failing}`
  );
}
