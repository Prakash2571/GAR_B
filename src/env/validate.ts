/**
 * MODE-AWARE ENVIRONMENT VALIDATION — refuse to enter live execution with incomplete credentials.
 *
 * THE GAP THIS CLOSES
 *
 * Before this module, not one secret was validated at startup. Each failed at the moment it was first
 * needed, and "first needed" was sometimes deep inside a live trading session:
 *
 *   · `BROKER_TOKEN_ENCRYPTION_KEY` was decoded lazily at the first token WRITE
 *     (src/brokerState/brokerSessions.ts). A deployment could boot, arm, and only discover the key was
 *     missing when it tried to persist a session — after the broker login had already succeeded.
 *   · Broker credential completeness was a readiness BLOCKER (src/brokers/registry.ts), which is the
 *     right behaviour for a running system and the wrong moment to learn about a typo.
 *   · `SITE_ACCESS_SECRET` was a stderr warning. Correct for development, but a production deployment
 *     whose gate can never accept a passcode is not serving anything.
 *
 * None of those were unsafe — they all failed closed. They were UNDIAGNOSABLE, and at 09:14 IST the
 * difference matters.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not re-validate the ~200 `BOX_*` knobs. `loadBoxConfig` already does that with helpers whose
 * failure modes were chosen deliberately (`strictLimitInt` and `strictBool` THROW precisely because a
 * typo silently becoming "unlimited" or "protection off" was a real defect once). A second validator
 * with its own opinion about those values is how two sources of truth drift apart. This module owns
 * exactly two things: CREDENTIALS, and the FAIL-SAFE PROPERTY of the live-enable gates.
 *
 * REQUIREDNESS IS ALWAYS EXPLICIT. Never inferred from a name pattern. `./secrets.ts` may guess that
 * something is a secret in order to redact it — guessing makes output safer. Guessing that a variable
 * is REQUIRED would refuse to boot over a variable nobody actually uses, and an unexplained refusal to
 * start is its own outage.
 *
 * NAMES, NEVER VALUES. Every string this module can emit is composed from variable names and fixed
 * prose. No branch interpolates a value, including into an error, including when the value is the
 * thing that is wrong.
 */

import { decodeEncryptionKey } from "../brokerState/tokenCrypto.js";
import { hasUsableValue, type EnvTarget } from "./layer.js";

/** Thrown when the environment cannot support the requested execution mode. */
export class EnvValidationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Environment validation failed with ${problems.length} problem(s).`);
    this.name = "EnvValidationError";
    this.problems = problems;
  }
}

/** How a live-enable flag parsed. */
interface GateBool {
  /** The RESOLVED value. Anything unrecognised is `false` — see {@link parseGateBool}. */
  readonly value: boolean;
  /** True when a value was present but not a recognised boolean. */
  readonly malformed: boolean;
  /** True when nothing was set at all. */
  readonly absent: boolean;
}

/**
 * Parse a live-enable gate, FAIL-SAFE.
 *
 * Mirrors `boolOr` in src/config.ts on purpose, including the property that matters most: an
 * unrecognised value resolves to FALSE, not to the fallback and never to true. `BOX_LIVE_TRADING_ENABLED=ture`
 * must leave order placement disabled. A gate that turned a typo into "enabled" would be the single
 * worst defect this file could contain, so the behaviour is asserted directly in the tests.
 *
 * `malformed` is tracked separately from the resolved value so the operator can be TOLD that their
 * typo disabled trading, rather than silently getting a paper session they believed was live.
 */
export function parseGateBool(raw: string | undefined): GateBool {
  if (raw === undefined || raw.trim().length === 0) {
    return { value: false, malformed: false, absent: true };
  }
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") {
    return { value: true, malformed: false, absent: false };
  }
  if (v === "false" || v === "0" || v === "no" || v === "off") {
    return { value: false, malformed: false, absent: false };
  }
  return { value: false, malformed: true, absent: false };
}

/** Execution modes the engine accepts. Mirrors `ExecutionMode` in src/box/config.ts. */
const KNOWN_EXECUTION_MODES = [
  "paper_touch",
  "paper_latency",
  "paper_legging",
  "live",
] as const;

/** Broker ids this deployment knows. Mirrors `BrokerId`. */
const KNOWN_BROKERS = ["zerodha", "dhan"] as const;
type KnownBroker = (typeof KNOWN_BROKERS)[number];

/** What the environment resolves to, reported without values. */
export interface EnvValidationReport {
  /** The requested execution mode, verbatim, or null when unset. Non-secret, safe to show. */
  readonly executionMode: string | null;
  /** True only when mode is `live` AND the deployment kill switch is on. */
  readonly liveEnabled: boolean;
  readonly activeBroker: KnownBroker;
  readonly loginMode: "in_app" | "provider";
  /** Fatal: the process must not continue. */
  readonly problems: string[];
  /** Worth saying loudly; not fatal. */
  readonly warnings: string[];
}

function resolveActiveBroker(target: EnvTarget): KnownBroker {
  const raw = (target.DEFAULT_ACTIVE_BROKER ?? "").trim().toLowerCase();
  return (KNOWN_BROKERS as readonly string[]).includes(raw) ? (raw as KnownBroker) : "zerodha";
}

function resolveLoginMode(target: EnvTarget): "in_app" | "provider" {
  // Mirrors brokerLoginModeFromEnv in src/index.ts: anything unrecognised means `in_app`, the mode
  // that requires no third-party endpoint.
  return (target.BROKER_LOGIN_MODE ?? "").trim().toLowerCase() === "provider" ? "provider" : "in_app";
}

/** Record a missing required variable, by NAME, with what it is for. */
function requireSet(
  target: EnvTarget,
  name: string,
  purpose: string,
  problems: string[],
): void {
  if (!hasUsableValue(target, name)) {
    problems.push(`Missing required environment variable: ${name} — ${purpose}`);
  }
}

/**
 * Validate the environment for the mode it is asking for.
 *
 * Collects EVERY problem before returning, matching `loadAppConfig`'s contract: an operator fixing
 * credentials before the open should see the whole list in one pass, not discover the second missing
 * key after fixing the first and restarting.
 */
export function validateEnvironment(
  target: EnvTarget = process.env as EnvTarget,
): EnvValidationReport {
  const problems: string[] = [];
  const warnings: string[] = [];

  const rawMode = (target.BOX_EXECUTION_MODE ?? "").trim();
  const executionMode = rawMode.length === 0 ? null : rawMode;

  // An unknown execution mode is fatal here rather than later. `executionMode()` in box/config.ts
  // already throws, but it runs lazily inside boot() AFTER the socket is bound, which turns a typo
  // into a half-started process. Catching it pre-listen is purely about diagnosability.
  if (executionMode !== null && !(KNOWN_EXECUTION_MODES as readonly string[]).includes(executionMode)) {
    problems.push(
      `BOX_EXECUTION_MODE is not a recognised mode. Valid values: ` +
        `${KNOWN_EXECUTION_MODES.join(", ")}. Execution selection is safety-critical, so an ` +
        `unrecognised value is refused rather than resolved to a default.`,
    );
  }

  const boxLive = parseGateBool(target.BOX_LIVE_TRADING_ENABLED);
  const zerodhaLive = parseGateBool(target.ZERODHA_LIVE_TRADING_ENABLED);
  const dhanLive = parseGateBool(target.DHAN_LIVE_TRADING_ENABLED);

  // A malformed gate is reported but NEVER resolved to true. Saying so matters: without this the
  // operator gets a paper session they believe is live, which is safe and deeply confusing.
  for (const [name, gate] of [
    ["BOX_LIVE_TRADING_ENABLED", boxLive],
    ["ZERODHA_LIVE_TRADING_ENABLED", zerodhaLive],
    ["DHAN_LIVE_TRADING_ENABLED", dhanLive],
  ] as const) {
    if (gate.malformed) {
      warnings.push(
        `${name} is set to a value that is not a recognised boolean, so it resolved to FALSE ` +
          `(live trading disabled). Recognised: true/false, 1/0, yes/no, on/off. This is fail-safe ` +
          `by design — a gate is never enabled by a value we could not read.`,
      );
    }
  }

  const liveEnabled = executionMode === "live" && boxLive.value;
  const activeBroker = resolveActiveBroker(target);
  const loginMode = resolveLoginMode(target);

  if (executionMode === "live" && !boxLive.value) {
    // index.ts already exits for this; stating it here makes the reason explicit in one place and
    // keeps this report honest about why `liveEnabled` is false.
    problems.push(
      `BOX_EXECUTION_MODE=live requires BOX_LIVE_TRADING_ENABLED=true. Live execution is ` +
        `double-gated at the deployment level and fails closed rather than degrading to paper.`,
    );
  }

  /* ── Always: the things whose absence is a security or integrity problem in any mode ────── */

  // Reported, not fatal, outside live: the site gate FAILS CLOSED without it (every protected route
  // 401s), so a developer gets a safe, diagnosable process. In live it is fatal — a live deployment
  // nobody can log into cannot be supervised, and an unsupervised live deployment is the problem.
  if (!hasUsableValue(target, "SITE_ACCESS_SECRET")) {
    const message =
      `SITE_ACCESS_SECRET is not set. The access gate is FAIL CLOSED: no passcode can be accepted ` +
      `and every protected route returns 401. An unset secret NEVER means "no passcode required".`;
    if (liveEnabled) problems.push(`Missing required environment variable: SITE_ACCESS_SECRET — ${message}`);
    else warnings.push(message);
  }

  /* ── Live only: credentials without which real orders cannot be placed safely ───────────── */

  if (liveEnabled) {
    requireSet(
      target,
      "DATABASE_URL",
      "PostgreSQL is the operational authority for reservations, positions and reconciliation. " +
        "Live execution without it cannot prove what it owns.",
      problems,
    );

    // Validated for SHAPE too, not merely presence. A key that is present but does not decode to 32
    // bytes fails at the first token write today — after a successful broker login, mid-session.
    if (!hasUsableValue(target, "BROKER_TOKEN_ENCRYPTION_KEY")) {
      problems.push(
        `Missing required environment variable: BROKER_TOKEN_ENCRYPTION_KEY — broker access tokens ` +
          `are sealed with AES-256-GCM before storage. Must decode to exactly 32 bytes (64-char hex ` +
          `or base64).`,
      );
    } else {
      try {
        decodeEncryptionKey(target.BROKER_TOKEN_ENCRYPTION_KEY);
      } catch (err) {
        // decodeEncryptionKey's messages name the variable and describe the SHAPE problem (byte
        // length, encoding) and never echo the key. Verified before forwarding.
        problems.push(err instanceof Error ? err.message : "BROKER_TOKEN_ENCRYPTION_KEY is invalid.");
      }
    }

    // The ACTIVE broker's credentials, in whichever way this deployment obtains a token.
    if (loginMode === "in_app") {
      if (activeBroker === "zerodha") {
        requireSet(target, "KITE_API_KEY", "Zerodha in-app login (request-token exchange).", problems);
        requireSet(target, "KITE_API_SECRET", "Zerodha in-app login (checksum).", problems);
      } else {
        requireSet(target, "DHAN_CLIENT_ID", "Dhan in-app login.", problems);
        requireSet(target, "DHAN_API_KEY", "Dhan in-app login.", problems);
        requireSet(target, "DHAN_API_SECRET", "Dhan in-app login.", problems);
      }
    } else {
      if (activeBroker === "zerodha") {
        requireSet(
          target,
          "KITE_TOKEN_BROKER_URL",
          "BROKER_LOGIN_MODE=provider fetches the token from this endpoint; it has no default " +
            "because a wrong host would receive a passcode.",
          problems,
        );
        requireSet(target, "KITE_TOKEN_BROKER_PASSCODE", "Authenticates to the token provider.", problems);
      } else {
        requireSet(target, "DHAN_TOKEN_URL", "BROKER_LOGIN_MODE=provider token endpoint.", problems);
        requireSet(target, "DHAN_TOKEN_BROKER_PASSCODE", "Authenticates to the token provider.", problems);
      }
    }

    // The active broker's own gate must also be on, or live mode cannot place an order and the
    // operator should be told now rather than after arming.
    const brokerGate = activeBroker === "zerodha" ? zerodhaLive : dhanLive;
    const brokerGateName =
      activeBroker === "zerodha" ? "ZERODHA_LIVE_TRADING_ENABLED" : "DHAN_LIVE_TRADING_ENABLED";
    if (!brokerGate.value) {
      warnings.push(
        `${brokerGateName} is not true, so no real order will reach ${activeBroker} even though the ` +
          `deployment gates are open. This is a valid supervised-test configuration; it is reported ` +
          `so a silent paper session is never mistaken for a live one.`,
      );
    }
  }

  /* ── Feature-scoped: required only when the feature is switched on ──────────────────────── */

  if (parseGateBool(target.MONGO_EXPORT_ENABLED).value) {
    requireSet(
      target,
      "MONGODB_URI",
      "MONGO_EXPORT_ENABLED=true, and the async read replica cannot be reached without a DSN.",
      problems,
    );
  }

  return { executionMode, liveEnabled, activeBroker, loginMode, problems, warnings };
}

/** Validate and THROW on any fatal problem. The boot path uses this. */
export function assertEnvironmentValid(target: EnvTarget = process.env as EnvTarget): EnvValidationReport {
  const report = validateEnvironment(target);
  if (report.problems.length > 0) throw new EnvValidationError(report.problems);
  return report;
}
