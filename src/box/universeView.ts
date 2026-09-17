/**
 * THE TRADABLE UNIVERSE, AS AN OPERATOR NEEDS TO SEE IT BEFORE PRESSING RUN — pure, no I/O.
 *
 * WHY THIS EXISTS
 *
 * The engine has always known its universe (`board` joined against `chains`), but nothing exposed
 * it. An operator could therefore only discover WHICH underlyings were being watched by reading the
 * opportunities that came back, and could only exclude a name by already knowing its symbol. With
 * `BOX_MAX_UNDERLYINGS=1` that was survivable; with the whole F&O universe enabled it is not — a
 * blocklist you cannot browse is a blocklist you cannot use.
 *
 * THE PART THAT IS NOT OBVIOUS: A WIDE UNIVERSE BREAKS THE PER-LEG QUANTITY CAP
 *
 * `BOX_LIVE_MAX_OPEN_LEG_QUANTITY` is ONE global number, and F&O lot sizes span orders of magnitude
 * (an index lot of 75 against a single-stock lot in the thousands). With one chosen underlying the
 * cap could be set to exactly that instrument's lot — the documented advice, and it worked. Across
 * ~200 underlyings that is impossible: any single value is either too small for most names or so
 * large it no longer bounds anything.
 *
 * The consequence is a silent one, which is why this module computes it explicitly. A name whose lot
 * exceeds the cap is not "unlikely to trade" — it CANNOT trade, ever, and the refusal happens deep
 * on the entry path (`entryQuantityEnvelopeBlockReason`) where it reads as an execution failure
 * rather than as a configuration mismatch. So {@link projectUniverse} labels every row with whether
 * it is admissible under the CURRENT caps, and the operator sees the answer before arming rather
 * than inferring it from an absence of trades.
 *
 * The intended workflow this enables: set the per-leg cap to the largest lot you are willing to
 * trade, then exclude everything above it. The cap and the blocklist then agree, and
 * `BOX_LIVE_MAX_BOX_CAPITAL_RUPEES` becomes the real economic bound rather than a second quantity
 * limit fighting the first.
 *
 * PURE BY CONSTRUCTION. It takes plain data and returns plain data, so the projection can be unit
 * tested against every awkward combination without an engine, a broker or a database.
 */

/** The four legs of a Box. Mirrors `BoxOrderManager.BOX_ENTRY_LEG_COUNT`. */
export const BOX_ENTRY_LEG_COUNT = 4;

/** Why a name cannot trade under the current configuration, or null when it can. */
export type UniverseInadmissibility =
  /** One lot exceeds `BOX_LIVE_MAX_OPEN_LEG_QUANTITY`, so no single leg could ever be submitted. */
  | "lot_exceeds_per_leg_cap"
  /** Four legs of one lot exceed `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY`. */
  | "four_legs_exceed_gross_cap"
  /** The option chain has no strike carrying BOTH a CE and a PE, so no box can be formed. */
  | "no_paired_strikes"
  /** The chain reports a non-positive lot size, so quantity arithmetic is meaningless. */
  | "unusable_lot_size";

/** One underlying, as the pre-run picker shows it. */
export interface UniverseUnderlying {
  readonly symbol: string;
  readonly name: string;
  readonly is_index: boolean;
  /** One lot, in units. 0 when the chain did not report a usable lot size. */
  readonly lot_size: number;
  /** The nearest non-expired expiry this chain resolved to, or null when none did. */
  readonly expiry: string | null;
  /** Strikes carrying BOTH a CE and a PE — the only ones a box can be built from. */
  readonly paired_strikes: number;
  /** True when the operator blocklist forbids entry on this name. */
  readonly excluded: boolean;
  /** The operator's note, when one was recorded. */
  readonly excluded_reason: string | null;
  /**
   * Whether this name could trade at all under the CURRENT quantity caps, ignoring the market.
   * False is a configuration fact, not a market condition.
   */
  readonly admissible: boolean;
  /** Why not, when `admissible` is false. */
  readonly inadmissible_reason: UniverseInadmissibility | null;
  /** One bounded sentence for the UI. Null when admissible. */
  readonly inadmissible_detail: string | null;
  /**
   * Whether the engine currently holds a live window for this name — i.e. is OBSERVING it.
   *
   * The engine's own record, not a derivation. This is the field that answers "which underlyings is
   * it actually watching?", and it is separate from `admissible` on purpose: a name can be perfectly
   * tradable and still unobserved because a cap gave its place to something else.
   */
  readonly watched: boolean;
  /** Why not, when `watched` is false and the name is not excluded. */
  readonly not_watched_reason: UniverseNotWatched | null;
}

/** The quantity caps a name is judged against. */
export interface UniverseCaps {
  /** `BOX_LIVE_MAX_OPEN_LEG_QUANTITY` — units per single order leg. */
  readonly maxOpenLegQuantity: number;
  /** `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY` — units across all open legs. */
  readonly maxGrossOpenLegQuantity: number;
}

/** The minimum a caller must supply per board row. */
export interface UniverseBoardRow {
  readonly symbol: string;
  readonly name?: string | undefined;
  readonly is_index?: boolean | undefined;
}

/** The minimum a caller must supply per chain. */
export interface UniverseChain {
  readonly lot_size: number;
  readonly expiry: string;
  readonly strikes: readonly number[];
}

/**
 * Why a name that COULD be entered is nonetheless not being observed right now.
 *
 * Distinct from {@link UniverseInadmissibility}, which is about whether an entry could ever be
 * submitted. A name can be perfectly admissible and still not watched, because being admissible does
 * not win it a place in the universe.
 */
export type UniverseNotWatched =
  /** The operator blocklist removed it, so no window is built and its tokens return to the budget. */
  | "excluded"
  /** BOX_MAX_UNDERLYINGS capped the list before reaching it. */
  | "underlying_cap"
  /** BOX_MAX_SUBSCRIBED_TOKENS ran out. */
  | "token_budget"
  /** Discovery is off (the scanner is stopped) and it carries no exposure, so nothing wants it. */
  | "discovery_off";

/** What the engine is actually observing, and why anything else is not. */
export interface UniverseWatchState {
  /** Underlyings with a live window after the last pass. GROUND TRUTH, not inferred. */
  readonly windows: ReadonlySet<string>;
  /** Names BOX_MAX_UNDERLYINGS cut. */
  readonly skippedForUnderlyingCap: ReadonlySet<string>;
  /** Names the token budget cut. */
  readonly skippedForBudget: ReadonlySet<string>;
  /** False when the scanner is stopped, which leaves everything unwatched for a third reason. */
  readonly discovering: boolean;
}

/** What the operator blocklist says about one symbol. */
export interface UniverseExclusion {
  readonly reason: string | null;
}

/**
 * Judge one underlying against the quantity caps.
 *
 * Ordered most-fundamental first: an unusable lot size makes every later comparison meaningless, and
 * a chain with no paired strikes cannot form a box whatever the caps say. Exported so the same
 * verdict can be asserted directly in tests.
 */
export function judgeAdmissibility(
  chain: UniverseChain | undefined,
  caps: UniverseCaps,
): { reason: UniverseInadmissibility; detail: string } | null {
  if (chain === undefined || !(chain.lot_size > 0)) {
    return {
      reason: "unusable_lot_size",
      detail:
        "The option chain did not report a usable lot size, so no order quantity can be derived for " +
        "this underlying.",
    };
  }
  if (chain.strikes.length < 2) {
    return {
      reason: "no_paired_strikes",
      detail:
        `Only ${chain.strikes.length} strike(s) carry both a CE and a PE for the nearest expiry. A box ` +
        `needs two such strikes, so none can be formed here.`,
    };
  }
  // The per-leg cap first: it is the barrier that exists specifically to stop an oversized lot being
  // half-executed, and its message is the one that names the number to change.
  if (caps.maxOpenLegQuantity > 0 && chain.lot_size > caps.maxOpenLegQuantity) {
    return {
      reason: "lot_exceeds_per_leg_cap",
      detail:
        `One lot is ${chain.lot_size} unit(s), above BOX_LIVE_MAX_OPEN_LEG_QUANTITY=` +
        `${caps.maxOpenLegQuantity}. Every entry on this name is refused before the first leg is sent.`,
    };
  }
  const fourLegs = chain.lot_size * BOX_ENTRY_LEG_COUNT;
  if (caps.maxGrossOpenLegQuantity > 0 && fourLegs > caps.maxGrossOpenLegQuantity) {
    return {
      reason: "four_legs_exceed_gross_cap",
      detail:
        `Four legs of one lot need ${fourLegs} unit(s) of gross quantity, above ` +
        `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=${caps.maxGrossOpenLegQuantity}. The whole attempt is ` +
        `refused before any leg posts.`,
    };
  }
  return null;
}

/**
 * Project the joined universe into the pre-run picker's list.
 *
 * Ordering is INDICES FIRST, then alphabetical — deliberately the same order
 * `prioritiseUniverse` applies when the token budget binds, so the list an operator reads is the
 * order the engine will actually select in. A picker sorted differently from the selector would
 * quietly mislead about which names survive a budget squeeze.
 *
 * Rows whose symbol has no chain are DROPPED, not shown as unusable: the board∩chains join is what
 * defines the universe, and a board row with no option chain was never a candidate for anything.
 */
export function projectUniverse(args: {
  readonly board: readonly UniverseBoardRow[];
  readonly chains: ReadonlyMap<string, UniverseChain>;
  readonly exclusions: ReadonlyMap<string, UniverseExclusion>;
  readonly caps: UniverseCaps;
  readonly watch: UniverseWatchState;
}): UniverseUnderlying[] {
  const rows: UniverseUnderlying[] = [];
  for (const item of args.board) {
    const chain = args.chains.get(item.symbol);
    if (chain === undefined) continue;
    const verdict = judgeAdmissibility(chain, args.caps);
    const exclusion = args.exclusions.get(item.symbol);
    const watched = args.watch.windows.has(item.symbol);
    rows.push({
      symbol: item.symbol,
      name: item.name ?? item.symbol,
      is_index: item.is_index === true,
      lot_size: chain.lot_size > 0 ? chain.lot_size : 0,
      expiry: chain.expiry === "" ? null : chain.expiry,
      paired_strikes: chain.strikes.length,
      excluded: exclusion !== undefined,
      excluded_reason: exclusion?.reason ?? null,
      admissible: verdict === null,
      inadmissible_reason: verdict?.reason ?? null,
      inadmissible_detail: verdict?.detail ?? null,
      watched,
      not_watched_reason: watched
        ? null
        : whyNotWatched(item.symbol, exclusion !== undefined, args.watch),
    });
  }
  rows.sort((a, b) => {
    if (a.is_index !== b.is_index) return a.is_index ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });
  return rows;
}

/**
 * Why an unwatched name is unwatched.
 *
 * Ordered by what the operator can act on. The blocklist comes first because it is their own decision
 * and explains the absence completely; the two caps come next, most-specific first, because an
 * operator who has set `BOX_MAX_UNDERLYINGS` deliberately should be told THAT is what bound rather
 * than being sent to look at a token budget with room to spare. `discovery_off` is last: it is a
 * whole-engine state, so it only explains a name when nothing more specific does.
 *
 * Returns null when nothing known accounts for it — better an honest absence than a guessed cause.
 */
function whyNotWatched(
  symbol: string,
  excluded: boolean,
  watch: UniverseWatchState,
): UniverseNotWatched | null {
  if (excluded) return "excluded";
  if (watch.skippedForUnderlyingCap.has(symbol)) return "underlying_cap";
  if (watch.skippedForBudget.has(symbol)) return "token_budget";
  if (!watch.discovering) return "discovery_off";
  return null;
}

/** Headline counts for the RUN summary, so the UI need not re-derive them. */
export interface UniverseSummary {
  readonly total: number;
  readonly indices: number;
  readonly excluded: number;
  /**
   * Not excluded AND admissible — ELIGIBLE, which is not the same as observed.
   *
   * This counts what nothing forbids. It does NOT account for `BOX_MAX_UNDERLYINGS` or the token
   * budget, both of which can leave an eligible name unobserved, so it is an upper bound on what the
   * scanner will look at rather than a promise. {@link UniverseSummary.watched} is the actual number.
   */
  readonly watchable: number;
  /** Not excluded but INADMISSIBLE under the current caps: silently dead without this count. */
  readonly blocked_by_caps: number;
  /**
   * How many the engine is ACTUALLY observing right now.
   *
   * The number an operator means when they ask what is being watched. It exists because `watchable`
   * alone was actively misleading: with `BOX_MAX_UNDERLYINGS=1` and 215 joined names, `watchable`
   * reported 215 while exactly ONE underlying had a window — a field named for what will be watched,
   * reporting a number that was not it.
   */
  readonly watched: number;
  /** Eligible, not excluded, and STILL not observed — the gap between the two counts above. */
  readonly eligible_not_watched: number;
}

export function summariseUniverse(rows: readonly UniverseUnderlying[]): UniverseSummary {
  let indices = 0;
  let excluded = 0;
  let watchable = 0;
  let blockedByCaps = 0;
  let watched = 0;
  let eligibleNotWatched = 0;
  for (const row of rows) {
    if (row.is_index) indices++;
    // Counted over EVERY row, including excluded ones: an excluded name carrying exposure keeps its
    // window so the monitor can exit it, and hiding that would misreport what the feed is carrying.
    if (row.watched) watched++;
    if (row.excluded) {
      excluded++;
      continue;
    }
    // Counted only for names the operator has NOT excluded: a name they already declined is not a
    // configuration problem they need told about.
    if (row.admissible) {
      watchable++;
      if (!row.watched) eligibleNotWatched++;
    } else blockedByCaps++;
  }
  return {
    total: rows.length,
    indices,
    excluded,
    watchable,
    blocked_by_caps: blockedByCaps,
    watched,
    eligible_not_watched: eligibleNotWatched,
  };
}
