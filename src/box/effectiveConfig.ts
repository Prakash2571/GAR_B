/**
 * EFFECTIVE CONFIGURATION SURFACE — resolved values WITH provenance.
 *
 * WHY THIS FILE EXISTS
 * A `.env` file is not the configuration; it is a *request* for a configuration.
 * The value actually in force can differ from what an operator typed, for three
 * documented reasons that `src/box/config.ts` implements:
 *
 *   1. An UNSET or blank variable falls back to a code default.
 *   2. An OUT-OF-RANGE value is CLAMPED into range (see `clampInt`/`clampPct`).
 *   3. An UNPARSEABLE value falls back to the default (see `num`/`bool`).
 *
 * So "what is running?" cannot be answered by reading the file. This module
 * answers it: for every knob it reports the resolved value AND where that value
 * came from — `default`, `env`, `env_clamped`, or `env_invalid_fallback` — so an
 * operator can see, at runtime, that (say) `BOX_LIVE_MAX_OPEN_BOXES=99` is
 * actually running as `20` (clamped), not `99`.
 *
 * PRECEDENCE (lowest to highest), stated once and enforced by construction:
 *
 *   code default  <  process environment (.env / PM2 env)
 *
 * There is no separate "config file" layer in this process: the only external
 * source is the environment (a `.env` is loaded INTO `process.env` by the process
 * manager before the code runs). Runtime operator API controls (entry arming,
 * execution permission) are a SEPARATE, session-scoped permission plane; they can
 * withdraw a permission but never widen a configured numeric limit, and they are
 * reported by `/api/box/status` `.arm`, not here. This module reports the boot
 * resolution only, which is exactly the layer whose provenance is ambiguous.
 *
 * INTEGRATION
 * The resolver reads the SAME `process.env` and applies the SAME parse/clamp rules
 * as {@link loadBoxConfig}, and a test asserts the resolved values equal the
 * loaded config field-for-field. It is not a parallel parser that could drift: it
 * is a provenance-annotated view of the one the engine boots from.
 *
 * WHO CONSUMES THIS (be honest — audit D7)
 * This module is an OPERATOR PRE-FLIGHT TOOL, invoked ONLY by its own CLI `main`
 * (`node dist/box/effectiveConfig.js`) below. It is NOT wired into the running
 * trading process: no HTTP route, engine path, or status payload calls
 * `resolveEffectiveConfig()`. That is by design and useful — an operator runs it
 * BEFORE boot to see what a `.env` will actually resolve to (and where each value
 * came from) — but nothing in the live process reads it, so this comment must not
 * imply a "status route" that does not exist. The tests that call it
 * (config.test.mjs / effectiveConfig.test.mjs) verify the resolver matches the
 * loader; they are the only other callers.
 *
 * RUNTIME SURFACES
 *   - `resolveEffectiveConfig()` — structured data, consumed by the CLI `main` below
 *     and by the parity test. No running-process caller.
 *   - `renderEffectiveConfig()`  — a human-readable table, for the CLI's stdout / logs.
 *   - `node dist/box/effectiveConfig.js` — the operator pre-flight command: prints the
 *     table for the CURRENT env, with `--json` for the structured form. No new
 *     dependency; pure Node. This is the ONLY production entry point.
 */

import { loadBoxConfig, type BoxConfig } from "./config.js";

/** Where a resolved value came from. */
export type ConfigProvenance =
  /** No env var set (or blank/whitespace) — the code default is in force. */
  | "default"
  /** The env var was set, parsed cleanly, and is used verbatim. */
  | "env"
  /** The env var was set but out of range; it was CLAMPED into range. */
  | "env_clamped"
  /** The env var was set but unparseable; the code default is in force. */
  | "env_invalid_fallback";

export interface ResolvedConfigValue {
  /** The BoxConfig field name. */
  readonly key: string;
  /** The environment variable that controls it (the primary one, if aliased). */
  readonly envVar: string;
  /** The value actually in force (after parse/clamp/fallback). */
  readonly value: unknown;
  /** The code default for this knob. */
  readonly default: unknown;
  /** The raw env string, or null if unset/blank. */
  readonly rawEnv: string | null;
  /** How `value` was arrived at. */
  readonly source: ConfigProvenance;
  /** A short human note (e.g. why it was clamped), when relevant. */
  readonly note?: string;
}

type Kind = "int" | "pct" | "number" | "bool" | "enum" | "string";

interface KnobSpec {
  key: keyof BoxConfig | string;
  envVar: string;
  /** Additional env vars consulted (aliases), in precedence order after `envVar`. */
  aliases?: readonly string[];
  kind: Kind;
  default: unknown;
  /** For int/pct/number kinds. */
  min?: number;
  max?: number;
  /** For enum kind. */
  choices?: readonly string[];
}

/**
 * The knob registry.
 *
 * This mirrors the parse in {@link loadBoxConfig}. It is deliberately DECLARATIVE
 * (bounds + default) rather than re-implementing the arithmetic, so the resolver's
 * clamp/fallback logic below is written ONCE and a test proves the resolved values
 * equal the real config. Knobs whose parsing is bespoke (sample lists, region
 * aliasing, derived defaults) are resolved by comparing against the loaded config
 * rather than re-deriving, so they can never disagree with what boots.
 */
const KNOBS: readonly KnobSpec[] = [
  // ---- Execution model / kill switches ----
  { key: "executionMode", envVar: "BOX_EXECUTION_MODE", kind: "enum", default: "paper_latency",
    choices: ["paper_touch", "paper_latency", "paper_legging", "live"] },
  { key: "liveTradingEnabled", envVar: "BOX_LIVE_TRADING_ENABLED", kind: "bool", default: false },
  { key: "shadowModeEnabled", envVar: "BOX_SHADOW_MODE_ENABLED", kind: "bool", default: false },
  { key: "paperExecutionProfile", envVar: "BOX_PAPER_EXECUTION_PROFILE", kind: "enum", default: "standard",
    choices: ["standard", "live_parity", "stress"] },

  // ---- Size / session ----
  { key: "liveMaxOpenBoxes", envVar: "BOX_LIVE_MAX_OPEN_BOXES", kind: "int", default: 1, min: 0, max: 20 },
  { key: "liveMaxConcurrentExecutions", envVar: "BOX_LIVE_MAX_CONCURRENT_EXECUTIONS", kind: "int", default: 1, min: 1, max: 4 },
  { key: "liveEntrySubmitConcurrency", envVar: "BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY", kind: "int", default: 1, min: 1, max: 4 },
  { key: "liveMaxResidualLegs", envVar: "BOX_LIVE_MAX_RESIDUAL_LEGS", kind: "int", default: 1, min: 0, max: 4 },
  { key: "oneActiveBoxPerUnderlying", envVar: "BOX_ONE_ACTIVE_BOX_PER_UNDERLYING", kind: "bool", default: false },
  { key: "sessionMaxCompletedTrades", envVar: "BOX_SESSION_MAX_COMPLETED_TRADES", kind: "int", default: 0, min: 0, max: 10_000 },
  { key: "maxConcurrentPerUnderlying", envVar: "BOX_MAX_CONCURRENT_PER_UNDERLYING", kind: "int", default: 2, min: 0, max: 16 },

  // ---- Quantity envelope ----
  { key: "liveMaxOpenLegQuantity", envVar: "BOX_LIVE_MAX_OPEN_LEG_QUANTITY", kind: "int", default: 100, min: 1, max: 1_000_000 },
  { key: "liveMaxGrossOpenLegQuantity", envVar: "BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY", kind: "int", default: 400, min: 1, max: 4_000_000 },

  // ---- Capital / loss breaker ----
  { key: "liveMaxBoxCapitalRupees", envVar: "BOX_LIVE_MAX_BOX_CAPITAL_RUPEES", kind: "int", default: 0, min: 0, max: 1_000_000_000 },
  { key: "liveDailyLossLimit", envVar: "BOX_LIVE_DAILY_LOSS_LIMIT", kind: "int", default: 5_000, min: 0, max: 10_000_000 },
  { key: "liveRejectLimit", envVar: "BOX_LIVE_REJECT_LIMIT", kind: "int", default: 3, min: 1, max: 100 },
  { key: "liveConsecutiveFailureLimit", envVar: "BOX_LIVE_CONSECUTIVE_FAILURE_LIMIT", kind: "int", default: 3, min: 1, max: 100 },

  // ---- Economic admission (fresh funds/margin evidence) ----
  { key: "liveRequireFundsCover", envVar: "BOX_LIVE_REQUIRE_FUNDS_COVER", kind: "bool", default: false },
  { key: "liveRequireMarginEvidence", envVar: "BOX_LIVE_REQUIRE_MARGIN_EVIDENCE", kind: "bool", default: false },
  { key: "liveFundsFreshnessMaxAgeMs", envVar: "BOX_LIVE_FUNDS_FRESHNESS_MAX_AGE_MS", kind: "int", default: 5_000, min: 250, max: 600_000 },
  { key: "liveMarginFreshnessMaxAgeMs", envVar: "BOX_LIVE_MARGIN_FRESHNESS_MAX_AGE_MS", kind: "int", default: 5_000, min: 250, max: 600_000 },

  // ---- Freshness / coherence (whole-second exchange stamps: NO sub-second exchange threshold) ----
  { key: "quoteMaxAgeMs", envVar: "BOX_QUOTE_MAX_AGE_MS", kind: "number", default: 15_000 },
  { key: "feedMaxAgeMs", envVar: "BOX_FEED_MAX_AGE_MS", kind: "number", default: 5_000 },
  { key: "underlyingMaxAgeMs", envVar: "BOX_UNDERLYING_MAX_AGE_MS", kind: "number", default: 10_000 },
  { key: "maxCrossLegReceiveDispersionMs", envVar: "BOX_MAX_CROSS_LEG_RECEIVE_DISPERSION_MS", kind: "int", default: 500, min: 0, max: 60_000 },
  { key: "maxCrossLegExchangeDispersionMs", envVar: "BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS", kind: "int", default: 250, min: 0, max: 60_000 },
  { key: "maxReceiveToExchangeDelayMs", envVar: "BOX_MAX_RECEIVE_TO_EXCHANGE_DELAY_MS", kind: "int", default: 5_000, min: 0, max: 120_000 },
  { key: "coherenceZeroDispersionDisablesInLive", envVar: "BOX_COHERENCE_ZERO_DISPERSION_DISABLES_IN_LIVE", kind: "bool", default: false },

  // ---- Order-event ingestion backpressure (never-drop threshold, not a cap) ----
  { key: "orderEventQueuePressureThreshold", envVar: "BOX_ORDER_EVENT_QUEUE_PRESSURE", kind: "number", default: 512 },

  // ---- Bounded lifecycle deadlines ----
  { key: "liveOrderMutationDeadlineMs", envVar: "BOX_LIVE_ORDER_MUTATION_DEADLINE_MS", kind: "int", default: 4_000, min: 250, max: 30_000 },
  { key: "liveHttpTimeoutMs", envVar: "BOX_LIVE_HTTP_TIMEOUT_MS", kind: "int", default: 5_000, min: 250, max: 30_000 },
  { key: "liveAckTimeoutMs", envVar: "BOX_LIVE_ACK_TIMEOUT_MS", kind: "int", default: 3_000, min: 250, max: 30_000 },
  { key: "liveWorkingTimeoutMs", envVar: "BOX_LIVE_WORKING_TIMEOUT_MS", kind: "int", default: 30_000, min: 1_000, max: 600_000 },
  { key: "livePartialTimeoutMs", envVar: "BOX_LIVE_PARTIAL_TIMEOUT_MS", kind: "int", default: 10_000, min: 500, max: 300_000 },
  { key: "liveCancelTimeoutMs", envVar: "BOX_LIVE_CANCEL_TIMEOUT_MS", kind: "int", default: 5_000, min: 250, max: 60_000 },
  { key: "liveMaxModifications", envVar: "BOX_LIVE_MAX_MODIFICATIONS", kind: "int", default: 2, min: 0, max: 10 },
  { key: "liveMaxChaseTicks", envVar: "BOX_LIVE_MAX_CHASE_TICKS", kind: "int", default: 2, min: 0, max: 20 },

  // ---- Rate / pacing ----
  { key: "liveBrokerMinIntervalMs", envVar: "BOX_LIVE_BROKER_MIN_INTERVAL_MS", kind: "int", default: 250, min: 50, max: 5_000 },
  { key: "liveBrokerOrderMinIntervalMs", envVar: "BOX_LIVE_BROKER_ORDER_MIN_INTERVAL_MS", kind: "int", default: 0, min: 0, max: 5_000 },
  { key: "liveReconcileIntervalMs", envVar: "BOX_LIVE_RECONCILE_INTERVAL_MS", kind: "int", default: 60_000, min: 5_000, max: 900_000 },
  { key: "liveFeedReconnectWarmupMs", envVar: "BOX_LIVE_FEED_RECONNECT_WARMUP_MS", kind: "int", default: 5_000, min: 0, max: 300_000 },

  // ---- Reservations ----
  { key: "durableReservationsEnabled", envVar: "BOX_DURABLE_RESERVATIONS_ENABLED", kind: "bool", default: true },
  { key: "reservationRequireDurable", envVar: "BOX_RESERVATION_REQUIRE_DURABLE", kind: "bool", default: false },
  { key: "instrumentLockTtlMs", envVar: "BOX_INSTRUMENT_LOCK_TTL_MS", kind: "int", default: 5_000, min: 250, max: 60_000 },
  { key: "executionCoordinatorEnabled", envVar: "BOX_EXECUTION_COORDINATOR_ENABLED", kind: "bool", default: true },
  { key: "internalNettingEnabled", envVar: "BOX_INTERNAL_NETTING_ENABLED", kind: "bool", default: false },

  // ---- Environment diagnostics (event-loop lag lives in executionEnvironment.ts) ----
  { key: "executionEventLoopMetricsEnabled", envVar: "BOX_EXECUTION_EVENT_LOOP_METRICS_ENABLED", kind: "bool", default: true },
  { key: "executionTimingMetricsEnabled", envVar: "BOX_EXECUTION_TIMING_METRICS_ENABLED", kind: "bool", default: true },

  // ---- Entry gate economics ----
  { key: "minExpectedNetProfit", envVar: "BOX_MIN_EXPECTED_NET_PROFIT", kind: "number", default: 1_200 },
  { key: "safetyBuffer", envVar: "BOX_SAFETY_BUFFER", kind: "number", default: 150 },
] as const;

const BOOL_TRUE = new Set(["1", "true", "yes"]);
const BOOL_FALSE = new Set(["0", "false", "no"]);

function rawFromEnv(env: NodeJS.ProcessEnv, spec: KnobSpec): string | null {
  const names = [spec.envVar, ...(spec.aliases ?? [])];
  for (const name of names) {
    const raw = env[name];
    if (raw !== undefined && raw.trim() !== "") return raw;
  }
  return null;
}

/**
 * Resolve ONE knob's provenance from a raw env string, mirroring the parse rules
 * in config.ts. `actual` is the value the real loaded config carries for this
 * key; where the declarative rules cannot express a bespoke parse, we defer to it.
 */
function resolveKnob(spec: KnobSpec, raw: string | null, actual: unknown): ResolvedConfigValue {
  const base = { key: String(spec.key), envVar: spec.envVar, default: spec.default };

  if (raw === null) {
    return { ...base, value: actual, rawEnv: null, source: "default" };
  }

  const trimmed = raw.trim();

  if (spec.kind === "bool") {
    const v = trimmed.toLowerCase();
    if (BOOL_TRUE.has(v) || BOOL_FALSE.has(v)) {
      return { ...base, value: actual, rawEnv: raw, source: "env" };
    }
    // Unrecognised boolean → fallback (config.ts `bool()` returns the fallback).
    return { ...base, value: actual, rawEnv: raw, source: "env_invalid_fallback",
      note: `unrecognised boolean "${raw}"; using default` };
  }

  if (spec.kind === "enum") {
    const v = trimmed.toLowerCase();
    if (spec.choices?.includes(v)) {
      return { ...base, value: actual, rawEnv: raw, source: "env" };
    }
    // executionMode throws on invalid (handled before we get here); profiles fall back.
    return { ...base, value: actual, rawEnv: raw, source: "env_invalid_fallback",
      note: `unrecognised value "${raw}"; using default` };
  }

  // Numeric kinds.
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { ...base, value: actual, rawEnv: raw, source: "env_invalid_fallback",
      note: `non-numeric "${raw}"; using default` };
  }

  if (spec.kind === "int" || spec.kind === "pct") {
    const lo = spec.kind === "pct" ? 0 : spec.min;
    const hi = spec.kind === "pct" ? 100 : spec.max;
    const requested = spec.kind === "pct" ? n : Math.round(n);
    if (lo !== undefined && hi !== undefined && (requested < lo || requested > hi)) {
      return { ...base, value: actual, rawEnv: raw, source: "env_clamped",
        note: `requested ${requested} clamped into [${lo}, ${hi}] → ${String(actual)}` };
    }
    return { ...base, value: actual, rawEnv: raw, source: "env" };
  }

  // Plain number (config.ts `num()`): finite value used as-is.
  return { ...base, value: actual, rawEnv: raw, source: "env" };
}

export interface EffectiveConfigReport {
  /** Precedence, lowest to highest. Documented so the surface is self-describing. */
  readonly precedence: readonly string[];
  /** The independent gates that must BOTH be armed before any real order is possible. */
  readonly liveTradingArmed: boolean;
  /** Per-knob resolved values with provenance. */
  readonly values: readonly ResolvedConfigValue[];
}

/**
 * Resolve the effective configuration for the given environment (defaults to the
 * live `process.env`), annotated with provenance.
 *
 * Throws exactly what {@link loadBoxConfig} throws (e.g. an invalid
 * `BOX_EXECUTION_MODE`, or `live` without the kill switch) — the reporter must
 * never present a configuration the process would refuse to boot with.
 */
export function resolveEffectiveConfig(
  env: NodeJS.ProcessEnv = process.env,
): EffectiveConfigReport {
  // Resolve against the SAME env the loader reads. We temporarily point the loader
  // at `env` by construction: loadBoxConfig reads process.env directly, so when a
  // caller passes a different env we splice it in and restore. This keeps ONE parser.
  const cfg = loadWith(env);

  const values: ResolvedConfigValue[] = KNOBS.map((spec) => {
    const raw = rawFromEnv(env, spec);
    const actual = (cfg as unknown as Record<string, unknown>)[String(spec.key)];
    return resolveKnob(spec, raw, actual);
  });

  return {
    precedence: [
      "1. code default (src/box/config.ts)",
      "2. process environment (.env / PM2 env) — HIGHER wins",
      "note: out-of-range env values are CLAMPED; unparseable env values FALL BACK to default",
      "note: runtime operator API controls (arming) are a separate session permission plane, not shown here",
    ],
    liveTradingArmed: cfg.executionMode === "live" && cfg.liveTradingEnabled === true,
    values,
  };
}

/** Load BoxConfig against an arbitrary env without leaking it into the process. */
function loadWith(env: NodeJS.ProcessEnv): BoxConfig {
  if (env === process.env) return loadBoxConfig();
  const saved = process.env;
  try {
    // eslint-disable-next-line no-global-assign
    (process as { env: NodeJS.ProcessEnv }).env = env;
    return loadBoxConfig();
  } finally {
    (process as { env: NodeJS.ProcessEnv }).env = saved;
  }
}

/** Render the report as a human-readable table (for logs or an operator). */
export function renderEffectiveConfig(report: EffectiveConfigReport): string {
  const lines: string[] = [];
  lines.push("GTS Algo Research — effective Box configuration (resolved, with provenance)");
  lines.push("");
  lines.push("Precedence:");
  for (const p of report.precedence) lines.push(`  ${p}`);
  lines.push("");
  lines.push(
    `Live trading armed: ${report.liveTradingArmed ? "YES" : "no"} ` +
      `(BOX_EXECUTION_MODE=live AND BOX_LIVE_TRADING_ENABLED=true both required)`,
  );
  lines.push("");
  const head = ["knob", "env var", "value", "source", "default"];
  const rows = report.values.map((v) => [
    v.key,
    v.envVar,
    String(v.value),
    v.source,
    String(v.default),
  ]);
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  lines.push(fmt(head));
  lines.push(widths.map((w) => "-".repeat(w ?? 0)).join("  "));
  for (const r of rows) lines.push(fmt(r));
  const flagged = report.values.filter(
    (v) => v.source === "env_clamped" || v.source === "env_invalid_fallback",
  );
  if (flagged.length > 0) {
    lines.push("");
    lines.push("ATTENTION — values that DIFFER from what was requested:");
    for (const v of flagged) {
      lines.push(`  ${v.envVar}="${v.rawEnv}" → ${String(v.value)} (${v.source}${v.note ? `: ${v.note}` : ""})`);
    }
  }
  return lines.join("\n");
}

/**
 * Standalone runtime surface: `node dist/box/effectiveConfig.js [--json]`.
 *
 * Prints the effective configuration for the CURRENT environment. Intended to be
 * run on the deployment host (after the same `.env` is loaded) so an operator can
 * confirm, before arming, exactly what the process will run with.
 */
export function main(argv: readonly string[] = process.argv.slice(2)): void {
  let report: EffectiveConfigReport;
  try {
    report = resolveEffectiveConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`refusing to report: configuration would not boot:\n${msg}\n`);
    process.exitCode = 2;
    return;
  }
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderEffectiveConfig(report)}\n`);
  }
}

// Execute when invoked directly (node dist/box/effectiveConfig.js), not when imported.
if (
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  /effectiveConfig\.js$/.test(process.argv[1])
) {
  main();
}
