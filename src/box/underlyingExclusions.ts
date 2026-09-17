/**
 * THE OPERATOR'S UNDERLYING BLOCKLIST — pure state and arithmetic, no I/O.
 *
 * WHAT THIS IS FOR
 *
 * An operator needs to be able to say "never enter this name" and have that hold in EVERY execution
 * mode — `paper_touch`, `paper_latency`, `paper_legging` and `live` alike — without editing an
 * environment variable and restarting. A supervised live test is the sharpest case: the whole point
 * is to take one carefully chosen box, and the ability to remove names from consideration at 09:20
 * without a redeploy is the difference between a controlled trial and a rushed one.
 *
 * THE ONE INVARIANT THAT MATTERS MOST
 *
 * An exclusion refuses ENTRY. It must NEVER refuse an exit, a reduction, a protective cancel or a
 * flatten. Excluding a name whose box is already open would otherwise trap real exposure behind a
 * preference, which is the precise inversion of what a safety control is for. Every consumer of this
 * module is therefore on an entry path, and the engine keeps an excluded underlying's legs
 * subscribed for as long as it carries exposure (see `mustKeep` in `BoxEngine.refreshUniverse`).
 *
 * WHY THE LOAD STATE IS PART OF THE MODEL
 *
 * A blocklist that cannot be read is not an empty blocklist. If the durable list is unreadable we
 * do not know which names are forbidden, so the only safe answer to "may I enter?" is no — the same
 * discipline `BoxTradingSessionManager` applies to an unreadable session record ("an unread session
 * is not an unarmed session"). That is why {@link UnderlyingExclusionBook} tracks HOW it came to
 * hold what it holds, and why {@link exclusionEntryRefusal} refuses on `failed` and `never_loaded`
 * rather than waving entry through.
 *
 * `unpersisted` is deliberately NOT a refusal. It means box persistence is not configured at all, so
 * no exclusion could ever have been saved and none is being forgotten. Refusing every entry because
 * a database the deployment never had is absent would break paper development for no safety gain —
 * and live execution independently requires healthy persistence via
 * `BoxOrderManager.entryBlockReasonAfterControls`, so live is covered by a different guard.
 *
 * ENFORCEMENT IS IN MEMORY, ON PURPOSE
 *
 * Every check is a synchronous `Set`/`Map` read. Two reasons. First, the scanner's hot path runs at
 * tick rate and must not await anything. Second, and more subtly, `BoxExecutionCoordinator`'s entry
 * prologue forbids any `await` between its guards and `claim()` — a check-then-act window there is a
 * TOCTOU bug that has already been paid for once in this codebase (see the comment block above
 * `coordinateEntry`). A blocklist consulted over the network could not be placed there at all. So a
 * mid-session database outage cannot lose the blocklist: only a WRITE can fail, and a failed write
 * is reported to the operator rather than silently dropped.
 */

/**
 * The most names one deployment may exclude.
 *
 * Bounded because the list is read on every entry decision and rendered in full by the UI, and
 * because a blocklist approaching the size of the universe is a configuration mistake expressed the
 * wrong way — `BOX_MAX_UNDERLYINGS` or an allow-list is the right tool at that point. 500 is far
 * above any plausible operator list and far below anything that could cost measurable time.
 */
export const MAX_EXCLUDED_UNDERLYINGS = 500;

/** The longest operator note an exclusion may carry. Mirrored by a CHECK in migration 012. */
export const MAX_EXCLUSION_REASON_LENGTH = 280;

/**
 * The longest symbol we will accept.
 *
 * Real NSE F&O underlying names are comfortably inside this. The bound exists so a hostile or
 * mistyped body cannot push an unbounded string into the durable list and from there into every
 * status payload.
 */
const MAX_SYMBOL_LENGTH = 32;

/**
 * Which characters may appear in an underlying symbol.
 *
 * Uppercase letters, digits, `&`, `-` and `_`. `&` is required — `M&M` and `M&MFIN` are real NSE
 * underlyings, and a naive `A-Z0-9` filter silently drops exactly the names an operator is most
 * likely to want excluded during a corporate action.
 */
const SYMBOL_PATTERN = /^[A-Z0-9&\-_]+$/;

/** One excluded underlying, with the provenance of the decision. */
export interface UnderlyingExclusion {
  /** Normalised: trimmed and uppercased. Never blank. */
  readonly symbol: string;
  /** Operator note, or null when none was recorded. Never an empty string. */
  readonly reason: string | null;
  /** The operator ROLE that excluded it. Never a token or session identifier. */
  readonly excluded_by: string | null;
  /** Epoch milliseconds. */
  readonly excluded_at: number;
}

/**
 * How the in-memory book came to hold what it holds.
 *
 *   never_loaded — nothing has been read yet. Entry is refused: we cannot assert a name is allowed.
 *   loaded       — the durable list was read successfully. The book is authoritative.
 *   failed       — a read was attempted and failed. Entry is refused; the read is retried.
 *   unpersisted  — box persistence is not configured, so no durable list can exist. Entry allowed.
 */
export type ExclusionLoadState = "never_loaded" | "loaded" | "failed" | "unpersisted";

/** Normalise a symbol for comparison and storage, or null when it is not a usable symbol. */
export function normaliseUnderlyingSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const symbol = raw.trim().toUpperCase();
  if (symbol.length === 0 || symbol.length > MAX_SYMBOL_LENGTH) return null;
  if (!SYMBOL_PATTERN.test(symbol)) return null;
  return symbol;
}

/**
 * Validate one exclusion request body.
 *
 * Returns the normalised values rather than mutating the input, so the caller persists and enforces
 * exactly the same string. A validator that accepted `" nifty "` and then stored it unchanged would
 * produce a row the in-memory `Set` never matches — protection that reads as present and is not.
 */
export function validateExclusionInput(input: {
  symbol?: unknown;
  reason?: unknown;
}): { ok: true; symbol: string; reason: string | null } | { ok: false; error: string } {
  const symbol = normaliseUnderlyingSymbol(input.symbol);
  if (symbol === null) {
    return {
      ok: false,
      error:
        `symbol must be an underlying name of 1-${MAX_SYMBOL_LENGTH} characters using ` +
        `A-Z, 0-9, &, - or _ (for example NIFTY, RELIANCE or M&M).`,
    };
  }
  if (input.reason === undefined || input.reason === null) {
    return { ok: true, symbol, reason: null };
  }
  if (typeof input.reason !== "string") {
    return { ok: false, error: "reason must be a string when provided." };
  }
  const reason = input.reason.trim();
  if (reason.length === 0) return { ok: true, symbol, reason: null };
  if (reason.length > MAX_EXCLUSION_REASON_LENGTH) {
    return { ok: false, error: `reason must be at most ${MAX_EXCLUSION_REASON_LENGTH} characters.` };
  }
  return { ok: true, symbol, reason };
}

/**
 * The in-memory blocklist.
 *
 * Pure: it owns no clock, no database and no logger. The engine supplies timestamps and drives the
 * load; this class only ever answers questions about what it was told.
 */
export class UnderlyingExclusionBook {
  private entries = new Map<string, UnderlyingExclusion>();
  private state: ExclusionLoadState = "never_loaded";
  private error: string | null = null;

  /** Replace the whole book from a successful durable read. */
  loaded(list: readonly UnderlyingExclusion[]): void {
    this.entries = new Map(list.map((e) => [e.symbol, e]));
    this.state = "loaded";
    this.error = null;
  }

  /** Record that the durable read FAILED. Entry is refused until a later read succeeds. */
  loadFailed(error: string): void {
    this.state = "failed";
    this.error = error;
  }

  /** Record that no durable list can exist because persistence is not configured. */
  unpersisted(): void {
    this.entries.clear();
    this.state = "unpersisted";
    this.error = null;
  }

  get loadState(): ExclusionLoadState {
    return this.state;
  }

  get loadError(): string | null {
    return this.error;
  }

  /**
   * Whether this book may be relied on to decide that a name is ALLOWED.
   *
   * Note the asymmetry: an unreadable book can still prove a name is FORBIDDEN if it happens to
   * hold it, but it can never prove one is permitted. Only the permitting direction needs this.
   */
  get readable(): boolean {
    return this.state === "loaded" || this.state === "unpersisted";
  }

  /** Whether the deployment can durably store an exclusion at all. */
  get persistent(): boolean {
    return this.state !== "unpersisted";
  }

  get size(): number {
    return this.entries.size;
  }

  /** Case- and whitespace-insensitive membership. */
  has(underlying: string): boolean {
    const symbol = normaliseUnderlyingSymbol(underlying);
    return symbol !== null && this.entries.has(symbol);
  }

  get(underlying: string): UnderlyingExclusion | undefined {
    const symbol = normaliseUnderlyingSymbol(underlying);
    return symbol === null ? undefined : this.entries.get(symbol);
  }

  /** Every exclusion, ordered by symbol so the UI and the tests see a stable list. */
  list(): UnderlyingExclusion[] {
    return [...this.entries.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  }

  /** Just the symbols, ordered. */
  symbols(): string[] {
    return this.list().map((e) => e.symbol);
  }

  /**
   * Add or replace one exclusion.
   *
   * Idempotent by symbol, matching the primary key in migration 012: excluding a name that is
   * already excluded restates the same fact with fresh provenance rather than erroring.
   */
  set(entry: UnderlyingExclusion): void {
    this.entries.set(entry.symbol, entry);
  }

  /** Remove one exclusion. Returns whether it was present. */
  delete(underlying: string): boolean {
    const symbol = normaliseUnderlyingSymbol(underlying);
    return symbol === null ? false : this.entries.delete(symbol);
  }

  /** Whether adding one more symbol would exceed {@link MAX_EXCLUDED_UNDERLYINGS}. */
  wouldExceedCap(symbol: string): boolean {
    return !this.entries.has(symbol) && this.entries.size >= MAX_EXCLUDED_UNDERLYINGS;
  }
}

/** Why an entry was refused by the blocklist layer. */
export interface ExclusionRefusal {
  /** A stable snake_case code, suitable for a metric label or a readiness blocker. */
  readonly code: "underlying_excluded" | "underlying_exclusions_unreadable";
  /** One bounded sentence for an operator. */
  readonly detail: string;
}

/**
 * The blocklist verdict for one underlying, or null when entry may proceed.
 *
 * Total and synchronous, so it is safe to call from the scanner's tick path and from inside the
 * coordinator's no-await prologue.
 */
export function exclusionEntryRefusal(
  book: UnderlyingExclusionBook,
  underlying: string,
): ExclusionRefusal | null {
  if (!book.readable) {
    return {
      code: "underlying_exclusions_unreadable",
      detail:
        `The excluded-underlyings blocklist could not be read (${book.loadError ?? "it has not been loaded yet"}), ` +
        `so no name can be confirmed tradable and new entry is refused. Exits, reductions and ` +
        `protective cancels are unaffected, and the read is retried automatically.`,
    };
  }
  const entry = book.get(underlying);
  if (entry === undefined) return null;
  return {
    code: "underlying_excluded",
    detail:
      `${entry.symbol} is on the operator blocklist, so no new box will be entered on it` +
      (entry.reason === null ? "." : `: ${entry.reason}`) +
      ` Any box already open on it is still monitored and will still exit.`,
  };
}
