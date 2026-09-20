/**
 * WHAT A BROKER'S "AVAILABLE FUNDS" FIGURE ACTUALLY MEANS — and why guessing is a funding bug.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The stage-funding model needs two numbers: how much the account can spend, and how much is
 * already encumbered by other orders and positions. Both brokers expose a funds endpoint with an
 * "available" and a "utilised" figure — but whether `available` is ALREADY NET of `utilised`
 * determines the arithmetic completely, and getting it wrong is a real money bug in one direction:
 *
 *   available is NET, and we subtract utilised anyway
 *     ⇒ we UNDERSTATE spendable funds ⇒ we refuse entries we could afford.
 *     Annoying, visible, and SAFE.
 *
 *   available is GROSS, and we do not subtract utilised
 *     ⇒ we OVERSTATE spendable funds ⇒ we admit an entry the account cannot fund
 *     ⇒ the broker rejects a leg mid-sequence ⇒ partially-executed exposure to recover from.
 *     DANGEROUS.
 *
 * The two errors are not symmetric, so the default when the semantics are not established must be
 * the understating one. That is what `unverified` does here, and it says so in the refusal text so
 * an operator knows precisely which fact to go and confirm rather than being left with an
 * unexplained refusal.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A DECLARED TABLE AND NOT AN INLINE `-` OPERATOR
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * "Determine whether broker-reported available funds are already net of encumbrances" is a
 * per-broker documentary fact with a verification date and a source, not a coding preference. Held
 * as data, it can be cited, reviewed, re-verified when a broker changes its API, and — critically —
 * carry an honest `unverified` value instead of an assumption dressed as arithmetic.
 */

import type { BrokerId } from "./latencyModel.js";

/**
 * Whether a broker's `available` funds figure is already reduced by what is currently encumbered.
 *
 *  - `net_of_encumbrance`   — `available` is spendable as-is. Subtracting `utilised` would
 *                             DOUBLE-COUNT the encumbrance.
 *  - `gross_of_encumbrance` — `available` includes encumbered funds; `utilised` must be subtracted.
 *  - `unverified`           — not established from primary documentation in this environment. The
 *                             conservative (understating) interpretation is applied and the refusal
 *                             text says so. NEVER silently treated as either of the above.
 */
export type AvailableFundsSemantics =
  | "net_of_encumbrance"
  | "gross_of_encumbrance"
  | "unverified";

export interface BrokerFundsSemantics {
  readonly availableIsNetOfEncumbrance: AvailableFundsSemantics;
  /** The field the adapter reads for `available`, so a reviewer can check the mapping. */
  readonly availableField: string;
  /** The field the adapter reads for `utilised`. */
  readonly utilisedField: string;
  /** Primary source consulted. */
  readonly source: string;
  /** ISO date the source was consulted. */
  readonly verifiedOn: string;
  readonly note: string;
}

/**
 * THE DECLARED SEMANTICS, per broker.
 *
 * ZERODHA — `net_of_encumbrance`.
 *   The adapter reads `available.live_balance` and `utilised.debits` from `GET /user/margins/equity`.
 *   Zerodha's own published description of the Kite funds view is that the available margin figure is
 *   the amount usable to place new trades, and that it already reflects premium received, realised
 *   and unrealised P&L and collateral benefits. A figure defined as "what you can use to place new
 *   trades" is by definition net of what is already blocked, so `utilised.debits` is a corroborating
 *   observation and must NOT be subtracted again.
 *   Source: https://support.zerodha.com/category/trading-and-markets/general-kite/funds/articles/kite-dashboard-and-fund-values-calculation
 *   Consulted 2026-09-13. Content paraphrased for licensing compliance.
 *   RESIDUAL RISK: this is the vendor's SUPPORT documentation for the Kite funds screen, not a field-
 *   by-field statement in the API reference (which could not be retrieved in this environment). The
 *   mapping from the screen's "available margin" to the API's `available.live_balance` is a reasonable
 *   but not vendor-confirmed identification, and remains NOT VERIFIED against a live account.
 *
 * DHAN — `unverified`.
 *   The adapter reads `availabelBalance` (the vendor's own spelling) and `utilizedAmount` from the
 *   fund-limit endpoint. The v2 funds documentation describes the endpoint as returning available
 *   funds together with margin requirements, but the field-level statement of whether
 *   `availabelBalance` is already reduced by `utilizedAmount` could not be retrieved here, and the
 *   endpoint also exposes `withdrawableBalance` and `blockedPayoutAmount`, which are further distinct
 *   notions of "available". Rather than pick one, this stays `unverified`: the conservative
 *   understating interpretation is applied and every refusal names the unverified semantics.
 *   Source: https://dhanhq.co/docs/v2/funds/ — consulted 2026-09-13 (index/summary only; the field
 *   table was not retrievable).
 *   TO RESOLVE: read the fund-limit response for the real account with a known open position and
 *   confirm whether `availabelBalance + utilizedAmount` equals the pre-trade figure. That is a
 *   deployed read-only check (Gate B), not something code can settle.
 */
export const BROKER_FUNDS_SEMANTICS: Readonly<Record<BrokerId, BrokerFundsSemantics>> = {
  zerodha: {
    availableIsNetOfEncumbrance: "net_of_encumbrance",
    availableField: "available.live_balance",
    utilisedField: "utilised.debits",
    source:
      "https://support.zerodha.com/category/trading-and-markets/general-kite/funds/articles/kite-dashboard-and-fund-values-calculation",
    verifiedOn: "2026-09-13",
    note:
      "Zerodha describes the available margin as the amount usable to place new trades, already " +
      "reflecting premium received, realised/unrealised P&L and collateral benefits. Subtracting " +
      "utilised.debits again would double-count the encumbrance. The screen-to-API-field " +
      "identification is not vendor-confirmed and is NOT VERIFIED against a live account.",
  },
  dhan: {
    availableIsNetOfEncumbrance: "unverified",
    availableField: "availabelBalance",
    utilisedField: "utilizedAmount",
    source: "https://dhanhq.co/docs/v2/funds/",
    verifiedOn: "2026-09-13",
    note:
      "The field-level statement of whether availabelBalance is already reduced by utilizedAmount " +
      "could not be retrieved, and the endpoint exposes further distinct notions of available " +
      "(withdrawableBalance, blockedPayoutAmount). The conservative understating interpretation is " +
      "applied until a deployed read-only check settles it.",
  },
};

/* ════════════════════════ THE FULL BREAKDOWN, AND WHICH PART IS SPENDABLE ════════════════════════ */

/**
 * EVERY numeric field the broker's funds endpoint carried, keyed by the BROKER'S OWN field name.
 *
 * WHY THIS EXISTS. The adapter used to read exactly two numbers out of a response that carries a
 * dozen, and discard the rest. An operator who saw a headline far below what their broker's own
 * screen showed had no way to find out why, and neither did anyone reading the code: the evidence
 * needed to explain the number was fetched, parsed and thrown away in the same function.
 *
 * Keyed by the vendor's field names (`available.live_balance`, `utilised.span`, …) rather than
 * normalised into our own vocabulary, deliberately — the whole point is to be able to hold this
 * beside the broker's documentation and the broker's screen and compare them directly. A normalised
 * name would put our interpretation between the operator and the fact.
 *
 * `null` is UNKNOWN, never zero, exactly as everywhere else in this module.
 */
export type FundsComponents = Readonly<Record<string, number | null>>;

/**
 * WHICH reported component is treated as spendable.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS CONFIGURABLE AND WHY THE DEFAULT DOES NOT CHANGE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Kite's equity margins response carries several distinct notions of "available", and which one
 * matches the figure an operator reads off the Kite funds screen is exactly the identification this
 * module already records as NOT VERIFIED against a live account. A large gap between our headline
 * and the screen is therefore expected to be a FIELD-SELECTION question, not an arithmetic one.
 *
 * It is not safe for this code to pick differently on a guess. From the header: overstating spendable
 * funds admits an entry the account cannot fund, the broker rejects a leg mid-sequence, and there is
 * partially-executed exposure to recover from. Understating merely refuses affordable entries.
 *
 * So the choice is exposed as configuration with the CONSERVATIVE default unchanged, and the full
 * breakdown is published beside it. An operator compares the published components against their own
 * funds screen, sees which one the screen agrees with, and selects it on EVIDENCE. That is a
 * one-line change they can justify; it is not a guess this file can make for them.
 */
export type FundsBasis =
  /** `available.live_balance` — the shipped default. Cash-side, already net of debits. */
  | "live_balance"
  /**
   * The segment's top-level `net`.
   *
   * Kite's own bottom line for the segment. In most observed responses this equals `live_balance`,
   * so selecting it is usually a no-op — which is precisely why it is safe to offer.
   */
  | "net"
  /**
   * `available.live_balance + available.collateral`.
   *
   * FOR AN ACCOUNT WHOSE TRADING POWER COMES FROM PLEDGED HOLDINGS. This is the only basis that can
   * report materially MORE than the default, and therefore the only one that can admit an entry the
   * default would refuse.
   *
   * THE RISK, STATED PLAINLY: Zerodha's support documentation says the available figure already
   * reflects collateral benefits. If that is true for `live_balance`, this basis DOUBLE-COUNTS the
   * collateral and OVERSTATES spendable funds — the dangerous direction. Select it only after
   * confirming against the published breakdown that `live_balance` does NOT already include
   * `collateral` for your account.
   */
  | "live_balance_plus_collateral";

export const FUNDS_BASES: readonly FundsBasis[] = [
  "live_balance",
  "net",
  "live_balance_plus_collateral",
];

/** The default basis: the shipped behaviour, unchanged. */
export const DEFAULT_FUNDS_BASIS: FundsBasis = "live_balance";

export function isFundsBasis(value: unknown): value is FundsBasis {
  return typeof value === "string" && (FUNDS_BASES as readonly string[]).includes(value);
}

/** Canonical component keys, so the resolver and the adapters cannot drift on spelling. */
export const FUNDS_COMPONENT_KEYS = {
  net: "net",
  cash: "available.cash",
  liveBalance: "available.live_balance",
  collateral: "available.collateral",
  openingBalance: "available.opening_balance",
  intradayPayin: "available.intraday_payin",
  adhocMargin: "available.adhoc_margin",
  debits: "utilised.debits",
  span: "utilised.span",
  exposure: "utilised.exposure",
  optionPremium: "utilised.option_premium",
  m2mRealised: "utilised.m2m_realised",
  m2mUnrealised: "utilised.m2m_unrealised",
} as const;

function component(components: FundsComponents | null | undefined, key: string): number | null {
  if (!components) return null;
  const value = components[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Resolve the spendable-side figure for the requested basis.
 *
 * Falls back to the caller's `availableRupees` whenever the basis cannot be satisfied from the
 * components — a basis naming a field the broker did not report must not silently become ₹0, and it
 * must not become a refusal either, because the DEFAULT reading may still be perfectly usable. The
 * fallback is reported in `detail` so the substitution is never silent.
 */
export function resolveAvailableForBasis(args: {
  readonly basis: FundsBasis;
  readonly components: FundsComponents | null | undefined;
  /** The figure the adapter already selected (the default basis). Used as the fallback. */
  readonly availableRupees: number | null;
}): { readonly value: number | null; readonly detail: string; readonly satisfied: boolean } {
  const { basis, components } = args;

  if (basis === "live_balance") {
    const value = component(components, FUNDS_COMPONENT_KEYS.liveBalance) ?? args.availableRupees;
    return { value, detail: FUNDS_COMPONENT_KEYS.liveBalance, satisfied: value !== null };
  }

  if (basis === "net") {
    const net = component(components, FUNDS_COMPONENT_KEYS.net);
    if (net !== null) return { value: net, detail: "net (the segment's own bottom line)", satisfied: true };
    return {
      value: args.availableRupees,
      detail:
        `BOX_ZERODHA_FUNDS_BASIS=net was requested but 'net' was not reported, so ` +
        `${FUNDS_COMPONENT_KEYS.liveBalance} is used instead`,
      satisfied: false,
    };
  }

  // live_balance_plus_collateral
  const live = component(components, FUNDS_COMPONENT_KEYS.liveBalance) ?? args.availableRupees;
  const collateral = component(components, FUNDS_COMPONENT_KEYS.collateral);
  if (live === null) {
    return {
      value: null,
      detail: `${FUNDS_COMPONENT_KEYS.liveBalance} was not reported, so no figure can be formed`,
      satisfied: false,
    };
  }
  if (collateral === null) {
    return {
      value: live,
      detail:
        `BOX_ZERODHA_FUNDS_BASIS=live_balance_plus_collateral was requested but ` +
        `${FUNDS_COMPONENT_KEYS.collateral} was not reported, so ${FUNDS_COMPONENT_KEYS.liveBalance} ` +
        `alone is used — the conservative outcome`,
      satisfied: false,
    };
  }
  return {
    value: live + collateral,
    detail:
      `${FUNDS_COMPONENT_KEYS.liveBalance} ₹${live} plus ${FUNDS_COMPONENT_KEYS.collateral} ` +
      `₹${collateral} (operator-selected basis; verify the broker does not already include ` +
      `collateral in live_balance, or this OVERSTATES spendable funds)`,
    satisfied: true,
  };
}

/** The declared semantics for a broker name, or null when none are declared for it. */
export function knownBrokerFundsSemantics(broker: string | null): BrokerFundsSemantics | null {
  if (broker === null) return null;
  return Object.prototype.hasOwnProperty.call(BROKER_FUNDS_SEMANTICS, broker)
    ? (BROKER_FUNDS_SEMANTICS[broker as BrokerId] ?? null)
    : null;
}

/** The spendable-funds figure, and an audit note explaining exactly how it was derived. */
export interface UsableFundsVerdict {
  /** ₹ genuinely available to fund a NEW entry, or null when it cannot be established. */
  readonly value_rupees: number | null;
  /** How the figure was derived. Always safe to log; contains no account identifier. */
  readonly basis: string;
  /** True when the broker's funds semantics are not established and a conservative default applied. */
  readonly semanticsUnverified: boolean;
  /** True when the encumbrance was needed but not supplied. */
  readonly encumbranceMissing: boolean;
  /**
   * Whether `value_rupees` is ALREADY reduced by the account's encumbrance.
   *
   * THE ANTI-DOUBLE-COUNT FLAG, and the reason it exists:
   *
   * `value_rupees` is always intended to be SPENDABLE funds — what is left after everything
   * already blocked on the account. This function reaches that figure two different ways: for a
   * `net_of_encumbrance` broker the reported `available` already IS spendable, and for
   * `gross_of_encumbrance` / `unverified` brokers the utilisation is subtracted here.
   *
   * The funding model, meanwhile, was independently ADDING the same utilisation into the
   * requirement it compares against this figure. Adding U to the requirement is only valid if the
   * funds figure is GROSS. Because it is net either way, the account was being charged for its
   * existing encumbrance twice:
   *     available(A − U)  ≥  requirement(R + U)   ⟺   A ≥ R + 2U
   * which refuses affordable entries by an amount that grows with unrelated activity on the
   * account. Consumers must consult this flag and add the encumbrance to the requirement ONLY
   * when it is false.
   *
   * Note this is about CONSISTENCY, not laxity: the fail-closed behaviour when the encumbrance is
   * required but missing still lives here (see the `gross_of_encumbrance` and `unverified` arms,
   * which return `value_rupees: null`), which is the correct side of the comparison for it.
   */
  readonly encumbranceNettedFromAvailable: boolean;
}

/**
 * Derive spendable funds from a broker funds observation, honouring the declared semantics.
 *
 * `availableRupees` / `utilisedRupees` are `null` for MISSING, never for zero — a trustworthy
 * reported zero is a real figure and is treated as one. `Number.isFinite(0)` is true, so presence
 * must be decided by the provider (which sets null) and never inferred from the value.
 */
export function usableFundsRupees(args: {
  /**
   * The broker the figures were read from. A plain string because it arrives from the evidence
   * identity, which is deliberately stringly-typed. An UNRECOGNISED broker yields no figure rather
   * than a default: applying one broker's funds semantics to another's numbers is the mistake this
   * module exists to prevent.
   */
  readonly broker: string | null;
  readonly availableRupees: number | null;
  readonly utilisedRupees: number | null;
  /**
   * Every numeric field the funds endpoint carried. Optional: callers that have only the two
   * headline numbers still work exactly as before.
   */
  readonly components?: FundsComponents | null | undefined;
  /**
   * Which component to treat as spendable. Omitted ⇒ {@link DEFAULT_FUNDS_BASIS}, i.e. the shipped
   * behaviour. Resolved HERE so the dashboard tile and the live admission gate cannot end up
   * applying different bases to the same account — the same reason the netting arithmetic lives here.
   */
  readonly basis?: FundsBasis | null | undefined;
}): UsableFundsVerdict {
  const semantics = knownBrokerFundsSemantics(args.broker);
  if (!semantics) {
    return {
      value_rupees: null,
      basis:
        `funds semantics are not declared for broker '${args.broker ?? "unknown"}', so spendable ` +
        `funds cannot be established; applying another broker's semantics would be a guess about money`,
      semanticsUnverified: true,
      encumbranceMissing: args.utilisedRupees === null,
      // No figure was produced, so there is nothing for a consumer to double-count.
      encumbranceNettedFromAvailable: false,
    };
  }
  /*
   * THE BASIS IS RESOLVED FIRST, and only then are the netting semantics applied.
   *
   * The two questions are independent and must stay so: "which reported number is the spendable
   * side?" (this) and "is that number already net of the encumbrance?" (the switch below). Folding
   * them together is how a field-selection change would silently alter the netting.
   */
  const requestedBasis = args.basis ?? DEFAULT_FUNDS_BASIS;
  const resolved = resolveAvailableForBasis({
    basis: requestedBasis,
    components: args.components,
    availableRupees: args.availableRupees,
  });
  const available = resolved.value;
  const utilised = args.utilisedRupees;
  /** Prefix appended to every basis string below, so the selected field is always on the record. */
  const basisPrefix = requestedBasis === DEFAULT_FUNDS_BASIS ? "" : `[basis=${requestedBasis}] `;

  if (available === null || !Number.isFinite(available)) {
    return {
      value_rupees: null,
      basis:
        `${basisPrefix}${args.broker}: no available-funds figure was supplied ` +
        `(${resolved.detail})`,
      semanticsUnverified: semantics.availableIsNetOfEncumbrance === "unverified",
      encumbranceMissing: utilised === null,
      encumbranceNettedFromAvailable: false,
    };
  }

  switch (semantics.availableIsNetOfEncumbrance) {
    case "net_of_encumbrance": {
      // Do NOT subtract. `utilised` is corroborating detail, not a second deduction.
      //
      // BUT ONLY CLAIM IT WAS NETTED WHEN WE CAN SEE IT. The identification of Zerodha's
      // `available.live_balance` as already-net rests on vendor SUPPORT documentation, not on a
      // field-level API statement, and this module records that as NOT VERIFIED against a live
      // account. While that is true, a reported `utilised` figure is the only corroboration
      // available, and its ABSENCE must not quietly become a claim.
      //
      // So: when the encumbrance is known, it is genuinely netted already and the requirement must
      // not re-add it (that was the double count). When it is MISSING, this returns `false`, which
      // leaves the encumbrance as a required-but-unknown component of the binding requirement and
      // therefore REFUSES — exactly the fail-closed behaviour the additive model used to provide
      // by accident. Removing the double count must not also remove that refusal.
      const encumbranceKnown = utilised !== null && Number.isFinite(utilised);
      return {
        value_rupees: available,
        basis:
          `${basisPrefix}${args.broker}: ₹${available} from ${resolved.detail}, documented as ` +
          `already net of encumbrances, so ${semantics.utilisedField} is NOT subtracted again` +
          (encumbranceKnown
            ? ` (${semantics.utilisedField} ₹${utilised} corroborates it)`
            : `; but ${semantics.utilisedField} was NOT reported, so the already-net claim cannot ` +
              `be corroborated and the encumbrance stays a required UNKNOWN component of the ` +
              `funding requirement`),
        semanticsUnverified: false,
        encumbranceMissing: !encumbranceKnown,
        encumbranceNettedFromAvailable: encumbranceKnown,
      };
    }

    case "gross_of_encumbrance": {
      if (utilised === null || !Number.isFinite(utilised)) {
        // The encumbrance is REQUIRED under these semantics and was not supplied. Missing is not
        // zero: assuming nothing else is blocked on the account is precisely the hazard that other
        // applications trading the same account create.
        return {
          value_rupees: null,
          basis:
            `${args.broker}: ${semantics.availableField} is gross of encumbrances but ` +
            `${semantics.utilisedField} was not supplied, so spendable funds cannot be established`,
          semanticsUnverified: false,
          encumbranceMissing: true,
          encumbranceNettedFromAvailable: false,
        };
      }
      return {
        value_rupees: available - utilised,
        basis:
          `${args.broker}: ${semantics.availableField} ₹${available} less ` +
          `${semantics.utilisedField} ₹${utilised}`,
        semanticsUnverified: false,
        encumbranceMissing: false,
        // Subtracted HERE, so the requirement must not add it again.
        encumbranceNettedFromAvailable: true,
      };
    }

    case "unverified": {
      // CONSERVATIVE BY CONSTRUCTION. The two possible errors are not symmetric: understating
      // spendable funds refuses affordable entries (safe and visible), while overstating them admits
      // an entry the account cannot fund and leaves partially-executed exposure to recover from. So
      // when the encumbrance is known we subtract it, accepting that we may be double-counting, and
      // we SAY that is what we are doing.
      if (utilised === null || !Number.isFinite(utilised)) {
        return {
          value_rupees: null,
          basis:
            `${args.broker}: funds semantics are NOT VERIFIED and ${semantics.utilisedField} was ` +
            `not supplied, so spendable funds cannot be established conservatively`,
          semanticsUnverified: true,
          encumbranceMissing: true,
          encumbranceNettedFromAvailable: false,
        };
      }
      return {
        value_rupees: available - utilised,
        basis:
          `${args.broker}: funds semantics are NOT VERIFIED, so the CONSERVATIVE reading is used — ` +
          `${semantics.availableField} ₹${available} less ${semantics.utilisedField} ₹${utilised}. ` +
          `If ${semantics.availableField} is in fact already net, this UNDERSTATES spendable funds ` +
          `(refusing affordable entries) rather than overstating them. Resolve with a deployed ` +
          `read-only funds read; see docs/BROKER_LIMITS.md.`,
        semanticsUnverified: true,
        encumbranceMissing: false,
        // Subtracted HERE under the conservative reading, so the requirement must not add it too.
        encumbranceNettedFromAvailable: true,
      };
    }
  }
}
