/**
 * THE SUPERVISED ONE-LOT TRIAL PROFILE — one lot, one box, one attempt, verified rather than hoped.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A PROFILE AND NOT NEW DEFAULTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The first supervised live test must be able to take exactly ONE lot, in exactly ONE box, on
 * exactly ONE attempt. Four independent settings decide that, and every one of them defaults to
 * something deliberately more permissive because this deployment is also a general-purpose engine:
 *
 *   BOX_MAX_OPEN_BOXES                 default 0 → UNLIMITED inventory
 *   BOX_LIVE_MAX_OPEN_BOXES            default 1 → already 1, but independently settable
 *   BOX_SESSION_MAX_COMPLETED_TRADES   default 0 → UNLIMITED cycles
 *   BOX_SESSION_MAX_ENTRY_ATTEMPTS     default 0 → UNLIMITED attempts
 *
 * Changing those DEFAULTS to 1 would silently convert every existing paper deployment into a
 * one-shot one, which is a worse outcome than the problem being solved. So the trial is an explicit,
 * opt-in PROFILE: outside it nothing changes, and inside it the four values are REQUIRED rather than
 * recommended. `BOX_SUPERVISED_ONE_LOT_TRIAL=true` with any of them not equal to 1 REFUSES STARTUP.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY ALL FOUR, WHEN THEY LOOK REDUNDANT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * They are enforced at four different places, against four different counts, and each one is blind
 * to at least one case the others catch. Setting three of them is not "close enough":
 *
 *   BOX_MAX_OPEN_BOXES               coordinator prologue, ALL modes. Counts durable inventory PLUS
 *                                    in-flight entry claims PLUS uncertain reservation holds, so it
 *                                    is the only one that can refuse the second of two entries
 *                                    admitted in the same instant.
 *   BOX_LIVE_MAX_OPEN_BOXES          BoxOrderManager, LIVE only. Read from a count refreshed only
 *                                    AFTER a position exists — useless for the same-instant race,
 *                                    but it is the last line at the send boundary.
 *   BOX_SESSION_MAX_COMPLETED_TRADES session ENTRY gate. Counts CONSUMED cycles, so it refuses a
 *                                    second box while the first is still OPEN, and keeps refusing
 *                                    after the first box CLOSES. Inventory ceilings cannot do that:
 *                                    once the box is closed and flat, inventory is 0 again.
 *   BOX_SESSION_MAX_ENTRY_ATTEMPTS   session ATTEMPT budget, consumed at admission. The only one
 *                                    that bounds an attempt that ABORTED — rejected, unwound or
 *                                    recovered. Such an attempt completes no cycle and leaves no
 *                                    inventory, so all three of the above see a clean slate, and
 *                                    without this a "one trade" trial can submit indefinitely.
 *
 * The last two are the ones that make this a ONE-ATTEMPT test rather than a one-position-at-a-time
 * test, and they are exactly the two that default to unlimited.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It does not decide the QUANTITY. One lot is whatever the live instrument master says a lot is, and
 * that number is not knowable from configuration — see `supervisedTrialQuantities`, which computes
 * the envelope from a lot size supplied by the caller and refuses to assume one.
 */

/** The env flag that turns the profile on. Unset/false ⇒ general-purpose behaviour, unchanged. */
export const SUPERVISED_TRIAL_ENV = "BOX_SUPERVISED_ONE_LOT_TRIAL";

/** Four legs to a box. Local to keep this module dependency-free for the preflight CLI. */
export const TRIAL_LEG_COUNT = 4;

/** Exactly the four settings the profile pins, and why each is independently necessary. */
export const SUPERVISED_ONE_SHOT_SETTINGS = [
  {
    env: "BOX_MAX_OPEN_BOXES",
    field: "maxOpenBoxes",
    why:
      "the only mode-independent inventory ceiling; counts in-flight entry claims, so it is the " +
      "only gate that can refuse two entries admitted in the same instant",
  },
  {
    env: "BOX_LIVE_MAX_OPEN_BOXES",
    field: "liveMaxOpenBoxes",
    why: "the live-only ceiling at the send boundary, read from the post-position count",
  },
  {
    env: "BOX_SESSION_MAX_COMPLETED_TRADES",
    field: "sessionMaxCompletedTrades",
    why:
      "counts CONSUMED cycles, so it still refuses a second box AFTER the first one closes — the " +
      "case every inventory ceiling misses, because a closed box leaves no inventory",
  },
  {
    env: "BOX_SESSION_MAX_ENTRY_ATTEMPTS",
    field: "sessionMaxEntryAttempts",
    why:
      "the only bound on an ABORTED attempt (rejected, unwound or recovered); such an attempt " +
      "completes no cycle and leaves no inventory, so nothing else counts it",
  },
] as const;

/** The subset of resolved config the profile constrains. */
export interface SupervisedTrialSettings {
  readonly maxOpenBoxes: number;
  readonly liveMaxOpenBoxes: number;
  readonly sessionMaxCompletedTrades: number;
  readonly sessionMaxEntryAttempts: number;
}

export interface SupervisedTrialViolation {
  readonly env: string;
  /** The EFFECTIVE value — post-clamp, post-fallback — not what was typed. */
  readonly actual: number;
  readonly required: 1;
  readonly detail: string;
}

/**
 * Every setting that is not exactly 1, with the effective value named.
 *
 * Pure, so the refusal, the preflight report and the tests all read the same verdict. `0` is called
 * out separately because it is the dangerous case: for three of these four it means UNLIMITED, so an
 * operator who leaves it unset has not configured a weaker trial — they have configured no bound at
 * all, which is the opposite of what the profile name promises.
 */
export function supervisedTrialViolations(
  settings: SupervisedTrialSettings,
): SupervisedTrialViolation[] {
  const out: SupervisedTrialViolation[] = [];
  for (const spec of SUPERVISED_ONE_SHOT_SETTINGS) {
    const actual = settings[spec.field];
    if (actual === 1) continue;
    const meaning =
      actual === 0
        ? "0 means UNLIMITED here, so this is not a smaller trial — it is an unbounded one"
        : `${actual} would permit more than the single ${
            spec.field.startsWith("session") ? "cycle/attempt" : "box"
          } this profile exists to enforce`;
    out.push({
      env: spec.env,
      actual,
      required: 1,
      detail: `${spec.env}=${actual} but the supervised one-lot trial requires exactly 1 — ${meaning}. Why this setting cannot be skipped: ${spec.why}.`,
    });
  }
  return out;
}

/**
 * The startup refusal text, or null when the profile is satisfied (or switched off).
 *
 * Refusing to BOOT rather than warning is the same judgement the live-mode kill switches in
 * `config.ts` already make: a supervised trial whose bounds are silently wider than the operator
 * believes is precisely the failure this profile exists to prevent, and a warning at 09:14 is not a
 * control.
 */
export function supervisedTrialStartupRefusal(
  enabled: boolean,
  settings: SupervisedTrialSettings,
): string | null {
  if (!enabled) return null;
  const violations = supervisedTrialViolations(settings);
  if (violations.length === 0) return null;
  return (
    `[Box] ${SUPERVISED_TRIAL_ENV}=true requires one lot, one box, one attempt, and ` +
    `${violations.length} of the 4 required setting(s) do not say so:\n` +
    violations.map((v) => `  · ${v.detail}`).join("\n") +
    `\nSet all four to 1, or unset ${SUPERVISED_TRIAL_ENV} if this deployment is not running the ` +
    `supervised trial. Startup is refused rather than running a trial with wider bounds than intended.`
  );
}

/* ══════════════════════════════ the quantity arithmetic ══════════════════════════════ */

export interface TrialQuantityInput {
  /**
   * ONE LOT, as reported by the LIVE instrument master for the contract actually being traded.
   *
   * NOT a constant, and deliberately a required argument with no default. The test fixtures use 75
   * and an older note guessed 65; both are wrong to rely on. Exchange lot sizes are revised, and the
   * whole envelope below scales with this number — so it is read, never assumed.
   */
  readonly lotSize: number;
  /** `BOX_LIVE_MAX_OPEN_LEG_QUANTITY`. 0 disables. */
  readonly perLegCap: number;
  /** `BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY`. 0 disables. */
  readonly grossCap: number;
}

export interface TrialQuantityArithmetic {
  readonly lotSize: number;
  readonly legs: number;
  /** Units on EACH leg for a one-lot box. */
  readonly perLeg: number;
  /** Units across all four legs. */
  readonly gross: number;
  readonly perLegCap: number;
  readonly grossCap: number;
  readonly perLegOk: boolean;
  readonly grossOk: boolean;
  /** Whether one one-lot box can be entered at all under these caps. */
  readonly admits: boolean;
  /**
   * How many one-lot boxes the GROSS cap alone would allow, or null when the cap is disabled.
   *
   * The number an operator actually needs and the one nobody computes: caps sized for one box at one
   * lot size quietly permit TWO at a smaller lot size. This is why the caps are not a substitute for
   * `BOX_MAX_OPEN_BOXES`.
   */
  readonly boxesPermittedByGrossCap: number | null;
  /** The arithmetic, spelled out line by line for the preflight record. */
  readonly lines: readonly string[];
}

/**
 * Work the trial's quantities out from the REAL lot size, and say what the caps then permit.
 *
 * Every line is derived. Nothing here hardcodes a lot size, and the function refuses a
 * non-positive one rather than substituting a guess.
 */
export function supervisedTrialQuantities(input: TrialQuantityInput): TrialQuantityArithmetic {
  const { perLegCap, grossCap } = input;
  /*
   * NO ROUNDING. THIS USED TO BE `Math.floor(input.lotSize)`.
   *
   * `--lot-size=65.5` therefore became 65, and the report then stated "one lot (live instrument
   * master) = 65 unit(s)" — presenting a fabricated number as a reading taken from the broker. A lot
   * size is an integer contract property, so a fractional input is not an imprecise reading that can
   * be tidied up: it means the operator mistyped it, read the wrong field, or is guessing. Every one
   * of those has to stop the preflight, because the entire envelope is computed from this number and
   * the whole point of the report is that it is not invented.
   */
  const lotSize = input.lotSize;
  if (!Number.isInteger(lotSize) || lotSize <= 0) {
    throw new Error(
      `supervisedTrialQuantities: lotSize must be a POSITIVE INTEGER read from the live instrument ` +
        `master, got ${String(input.lotSize)}. A fractional or non-numeric value is refused rather ` +
        `than rounded — rounding it would report a lot size nobody read. Do not assume 75 or 65.`,
    );
  }
  const perLeg = lotSize;
  const gross = lotSize * TRIAL_LEG_COUNT;
  const perLegOk = perLegCap <= 0 || perLeg <= perLegCap;
  const grossOk = grossCap <= 0 || gross <= grossCap;
  const boxesPermittedByGrossCap = grossCap <= 0 ? null : Math.floor(grossCap / gross);

  const lines = [
    `one lot (live instrument master) = ${lotSize} unit(s)`,
    `per-leg quantity   = 1 lot                 = ${perLeg} unit(s)`,
    `gross quantity     = ${perLeg} x ${TRIAL_LEG_COUNT} legs = ${gross} unit(s)`,
    perLegCap <= 0
      ? `per-leg cap        BOX_LIVE_MAX_OPEN_LEG_QUANTITY=0 (disabled — no per-leg bound)`
      : `per-leg cap        BOX_LIVE_MAX_OPEN_LEG_QUANTITY=${perLegCap} -> ${perLeg} <= ${perLegCap} ? ${perLegOk ? "PASS" : "REFUSED"}`,
    grossCap <= 0
      ? `gross cap          BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=0 (disabled — no gross bound)`
      : `gross cap          BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=${grossCap} -> ${gross} <= ${grossCap} ? ${grossOk ? "PASS" : "REFUSED"}`,
    boxesPermittedByGrossCap === null
      ? `boxes the gross cap alone permits: UNBOUNDED (cap disabled) — BOX_MAX_OPEN_BOXES is the only ceiling`
      : `boxes the gross cap alone permits: floor(${grossCap} / ${gross}) = ${boxesPermittedByGrossCap}` +
        (boxesPermittedByGrossCap > 1
          ? ` — MORE THAN ONE. The caps do NOT bound this trial to a single box; BOX_MAX_OPEN_BOXES=1 is doing that work.`
          : ""),
  ];

  return {
    lotSize,
    legs: TRIAL_LEG_COUNT,
    perLeg,
    gross,
    perLegCap,
    grossCap,
    perLegOk,
    grossOk,
    admits: perLegOk && grossOk,
    boxesPermittedByGrossCap,
    lines,
  };
}

/* ══════════════════════════════ the preflight report ══════════════════════════════ */

/** Exit status for the preflight CLI. Distinct codes so a wrapper script can tell them apart. */
export const PREFLIGHT_EXIT = {
  /** Everything required is satisfied AND one lot is admissible under both caps. */
  PASS: 0,
  /** The preflight did NOT pass: a cap refuses, a bound is wrong, or the quantity is UNVERIFIED. */
  FAIL: 1,
  /** The invocation or the configuration is unusable — bad `--lot-size`, or a config that cannot boot. */
  INVALID: 2,
} as const;

/**
 * THE STRUCTURED PREFLIGHT VERDICT — `ok` is the exit code, and the text can never disagree with it.
 *
 * WHY THIS TYPE EXISTS. `renderSupervisedTrialPreflight` used to return only a string, and the CLI
 * derived nothing from it, so with `--lot-size=101` the report printed
 *
 *     per-leg cap  BOX_LIVE_MAX_OPEN_LEG_QUANTITY=100 -> 101 <= 100 ? REFUSED
 *     gross cap    BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=400 -> 404 <= 400 ? REFUSED
 *
 * and then finished with "VERDICT: the four required settings are satisfied and the quantity
 * arithmetic is shown above." and **exit code 0**. Every individual line was true; the verdict and
 * the exit status were not. A preflight that exits 0 while stating that no leg of the box can be sent
 * is worse than no preflight, because a wrapper script — and a tired operator scrolling to the last
 * line — reads the verdict, not the arithmetic.
 *
 * `ok` is computed from the same facts the text is rendered from, in one place, so the two cannot
 * drift apart again.
 */
export interface SupervisedTrialPreflight {
  /** TRUE only when this configuration could actually run the trial, quantities included. */
  readonly ok: boolean;
  /** Process exit code. See {@link PREFLIGHT_EXIT}. */
  readonly exitCode: number;
  /** Machine-readable reasons the preflight did not pass. Empty iff `ok`. */
  readonly failures: readonly string[];
  /** The operator-facing report. */
  readonly text: string;
}

/**
 * The operator-facing preflight block: the four pinned settings, then the quantity arithmetic.
 *
 * `lotSize` is optional ONLY so the settings half can be printed before an operator has read the
 * instrument master. When it is absent the report says the arithmetic is UNVERIFIED rather than
 * filling in a plausible number — and does NOT pass, because an unverified envelope is not a checked
 * one.
 */
export function supervisedTrialPreflight(args: {
  readonly enabled: boolean;
  readonly settings: SupervisedTrialSettings;
  readonly lotSize?: number | null;
  readonly perLegCap: number;
  readonly grossCap: number;
}): SupervisedTrialPreflight {
  const out: string[] = ["SUPERVISED ONE-LOT TRIAL PREFLIGHT", "=================================="];
  out.push(`${SUPERVISED_TRIAL_ENV}=${args.enabled ? "true" : "false"}`);
  if (!args.enabled) {
    out.push(
      "",
      "The profile is OFF, so none of the four one-shot settings is required and the general-purpose",
      "defaults are in force. This deployment is NOT configured for the supervised trial.",
    );
  }
  out.push(
    "",
    args.enabled
      ? "REQUIRED SETTINGS (each must be exactly 1)"
      : "THE FOUR SETTINGS THE PROFILE WOULD PIN (not required while it is off)",
  );
  const violations = new Map(supervisedTrialViolations(args.settings).map((v) => [v.env, v]));
  for (const spec of SUPERVISED_ONE_SHOT_SETTINGS) {
    const actual = args.settings[spec.field];
    const bad = violations.get(spec.env);
    // With the profile OFF, a value other than 1 is not a failure — it is the general-purpose
    // default doing its job. Marking it FAIL there produced a report that said "FAIL" three times
    // and then "the four required settings are satisfied", which is worse than saying nothing.
    const mark = !args.enabled ? "    " : bad ? "FAIL" : "ok  ";
    const note = !args.enabled
      ? actual === 0
        ? "  (0 = unlimited)"
        : ""
      : bad
        ? "  <- requires 1"
        : "";
    out.push(`  ${mark}  ${spec.env}=${actual}${note}`);
  }

  const failures: string[] = [];
  for (const v of violations.values()) {
    if (args.enabled) failures.push(`${v.env}=${v.actual} (requires 1)`);
  }

  out.push("", "QUANTITY ARITHMETIC");
  let quantities: TrialQuantityArithmetic | null = null;
  if (args.lotSize == null) {
    out.push(
      "  UNVERIFIED — no lot size supplied. Read the CURRENT lot size for the contract being traded",
      "  from the live instrument master and re-run with --lot-size=<n>. Do not assume 75 or 65.",
    );
    // UNVERIFIED IS NOT A PASS. The envelope is the thing most likely to be wrong on the day, and an
    // exit code of 0 here would let a wrapper script treat "we did not check" as "we checked".
    failures.push("quantity envelope UNVERIFIED (no --lot-size supplied)");
  } else {
    quantities = supervisedTrialQuantities({
      lotSize: args.lotSize,
      perLegCap: args.perLegCap,
      grossCap: args.grossCap,
    });
    for (const line of quantities.lines) out.push(`  ${line}`);
    /*
     * A REFUSED CAP IS A PREFLIGHT FAILURE. This is the correction: these two conditions were
     * rendered into the text and then ignored by the verdict and the exit code.
     *
     * Either one means NO leg of a one-lot box can be sent, so the trial cannot run at all — a
     * strictly worse state than a mis-set bound, because it is invisible until the first entry is
     * refused at the send boundary.
     */
    if (!quantities.perLegOk) {
      failures.push(
        `per-leg quantity ${quantities.perLeg} exceeds BOX_LIVE_MAX_OPEN_LEG_QUANTITY=${quantities.perLegCap}`,
      );
    }
    if (!quantities.grossOk) {
      failures.push(
        `gross quantity ${quantities.gross} exceeds BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=${quantities.grossCap}`,
      );
    }
  }

  const refusal = supervisedTrialStartupRefusal(args.enabled, args.settings);

  /*
   * THE VERDICT, computed from `failures` rather than written independently of it.
   *
   * The profile being OFF is reported as NOT CONFIGURED rather than as a pass: this command exists to
   * answer "is this host set up for the supervised trial?", and "no" is not a success.
   */
  const ok = args.enabled && refusal === null && failures.length === 0;
  out.push("");
  if (!args.enabled) {
    out.push(
      `VERDICT: NOT CONFIGURED FOR THE SUPERVISED TRIAL. Set ${SUPERVISED_TRIAL_ENV}=true (and all ` +
        `four settings to 1) on the host that will run it.`,
    );
  } else if (refusal !== null) {
    out.push(`VERDICT: FAILED — STARTUP WOULD BE REFUSED.\n${refusal}`);
  } else if (failures.length > 0) {
    // The four bounds are satisfied, so name what is actually wrong instead of implying all is well.
    const unverified = args.lotSize == null;
    out.push(
      unverified
        ? "VERDICT: NOT VERIFIED — the four required settings are satisfied, but the QUANTITY envelope " +
          "was not checked. Supply the lot size you read from the live instrument master."
        : "VERDICT: FAILED — the four required settings are satisfied, but ONE LOT CANNOT BE SENT " +
          "under the configured quantity caps:",
    );
    if (!unverified) {
      for (const f of failures) out.push(`  · ${f}`);
      out.push(
        "  No leg of a one-lot box would be admitted, so the trial cannot run. Either raise the cap " +
          "you intend to carry, or trade a contract whose lot fits the envelope. Do NOT raise a cap " +
          "merely to make this line go away.",
      );
    }
  } else {
    out.push(
      `VERDICT: PASS — the four required settings are satisfied and one lot of ${quantities?.lotSize} ` +
        `unit(s) is admissible under both quantity caps.`,
    );
  }

  // Every non-pass reached here is a FAIL. `INVALID` (2) is reserved for the CLI's own input and
  // boot-failure paths, which never get as far as building a report.
  return { ok, exitCode: ok ? PREFLIGHT_EXIT.PASS : PREFLIGHT_EXIT.FAIL, failures, text: out.join("\n") };
}

/**
 * Text-only view, kept for callers that render the report and nothing else.
 *
 * DO NOT use this to decide anything. It deliberately cannot express the verdict, which is exactly
 * how the original defect happened — the report was printed and the outcome discarded. Use
 * {@link supervisedTrialPreflight} and read `ok` / `exitCode`.
 */
export function renderSupervisedTrialPreflight(args: {
  readonly enabled: boolean;
  readonly settings: SupervisedTrialSettings;
  readonly lotSize?: number | null;
  readonly perLegCap: number;
  readonly grossCap: number;
}): string {
  return supervisedTrialPreflight(args).text;
}
