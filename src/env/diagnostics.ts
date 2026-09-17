/**
 * STARTUP CONFIGURATION DIAGNOSTIC — useful to an operator, useless to an attacker.
 *
 * THE ONE RULE
 *
 * For a `secret` the only fact that ever leaves this module is WHETHER IT IS SET. Not its length, not
 * a prefix, not a hash. A length narrows a brute force; a prefix is often the whole distinguishing
 * part of an API key (`kite_live_…`); a hash of a short passcode is a passcode. `configured` or
 * `missing`, and nothing else.
 *
 * The one refinement is DSN-shaped secrets, which report `configured (host:port/db)`. "Which database
 * am I actually pointed at?" is a real operational question — pointing a live process at a staging
 * database is a genuine incident — and the host is not the credential. This is exactly what
 * `pgStatus()` already publishes, so the diagnostic is not widening any surface.
 *
 * WHY NON-SECRET VALUES ARE SHOWN IN FULL
 *
 * Because hiding them would defeat the purpose. An operator checking whether the deployment came up
 * with the risk limits they intended needs to READ the number. Redacting `BOX_MAX_OPEN_BOXES` would
 * add no security — the value is in a file they own — and would remove the one check that catches a
 * `.env` that did not get applied.
 *
 * PURE. Takes an environment, returns strings. It performs no I/O and reads no global, so a test can
 * assert on the exact output and — more importantly — can assert that a known secret VALUE never
 * appears anywhere in it.
 */

import { hasUsableValue, type EnvTarget } from "./layer.js";
import { classifyEnvVar, describeEnvValue, EXPLICIT_ENV_CLASS } from "./secrets.js";
import type { EnvLoadReport } from "./load.js";
import type { EnvValidationReport } from "./validate.js";

/**
 * The non-secret settings worth printing at boot, in the order an operator reads them.
 *
 * Curated rather than exhaustive: dumping all ~200 `BOX_*` knobs would bury the four that decide
 * whether real money can move. `npm run box:effective-config` already prints the full resolved set
 * with provenance for when that is the question.
 */
const REPORTED_CONFIG: readonly string[] = [
  // What mode, and can it trade at all.
  "NODE_ENV",
  "BOX_EXECUTION_MODE",
  "BOX_LIVE_TRADING_ENABLED",
  "ZERODHA_LIVE_TRADING_ENABLED",
  "DHAN_LIVE_TRADING_ENABLED",
  "DEFAULT_ACTIVE_BROKER",
  "BROKER_LOGIN_MODE",
  // How much exposure is permitted.
  "BOX_MAX_OPEN_BOXES",
  "BOX_ONE_ACTIVE_BOX_PER_UNDERLYING",
  "BOX_MAX_CONCURRENT_PER_UNDERLYING",
  "BOX_SESSION_MAX_ENTRY_ATTEMPTS",
  "BOX_LIVE_MAX_OPEN_LEG_QUANTITY",
  "BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY",
  "BOX_LIVE_MAX_BOX_CAPITAL_RUPEES",
  // What is watched, and how fresh the data must be.
  "BOX_MAX_UNDERLYINGS",
  "BOX_STRIKE_LEVEL",
  "BOX_MAX_SUBSCRIBED_TOKENS",
  "BOX_FEED_MAX_AGE_MS",
  "BOX_QUOTE_MAX_AGE_MS",
  // Process surface.
  "PORT",
  "APP_TIMEZONE",
  "MONGO_EXPORT_ENABLED",
  "BOX_DEPLOYMENT_REGION",
];

/** Longest name, for column alignment. */
function pad(name: string, width: number): string {
  return name.length >= width ? name : name + " ".repeat(width - name.length);
}

/**
 * Render the diagnostic.
 *
 * Returns lines rather than printing, so the caller chooses the stream and a test can inspect every
 * character that would be emitted.
 */
export function renderEnvDiagnostics(args: {
  readonly target: EnvTarget;
  readonly load: EnvLoadReport | null;
  readonly validation: EnvValidationReport;
}): string[] {
  const { target, load, validation } = args;
  const lines: string[] = [];

  lines.push("[Config] Environment resolved. Precedence: process env > secrets file > .env > default.");

  if (load !== null) {
    const s = load.secretsFile;
    lines.push(
      `[Config] secrets file ${s.path}: ` +
        (!s.present
          ? "absent (no credential loaded from a file)"
          : !s.read
            ? "PRESENT BUT NOT READ — see the problem reported below"
            : `read, supplied ${s.applied.length} variable(s)`),
    );
    const e = load.envFile;
    lines.push(
      `[Config] server .env ${e.path}: ` +
        (!e.present
          ? "absent"
          : !e.read
            ? "PRESENT BUT NOT READ — see the problem reported below"
            : `read, supplied ${e.applied.length} variable(s)` +
              (e.overriddenByHigherPrecedence.length > 0
                ? `, ${e.overriddenByHigherPrecedence.length} overridden by a higher-precedence source`
                : "")),
    );
  }

  /* ── Credentials: presence only ─────────────────────────────────────────────────────────── */

  const sensitive = [...EXPLICIT_ENV_CLASS.entries()]
    .filter(([, cls]) => cls !== "config")
    .map(([name]) => name)
    .sort();
  const width = Math.max(...sensitive.map((n) => n.length), ...REPORTED_CONFIG.map((n) => n.length));

  lines.push("[Config] Credentials and identities (presence only — no value is ever printed):");
  for (const name of sensitive) {
    // `describeEnvValue` is the single place that decides how much of a value may be shown. Routing
    // every line through it means a new sensitive variable cannot be printed by a new call site.
    lines.push(`[Config]   ${pad(name, width)}  ${describeEnvValue(name, target[name])}`);
  }

  /* ── Operational configuration: real values ─────────────────────────────────────────────── */

  lines.push("[Config] Operational configuration (values shown; none of these is a credential):");
  for (const name of REPORTED_CONFIG) {
    // Defensive: if a name in the curated list were ever reclassified as sensitive, this still routes
    // through the same redaction rather than trusting the list to have stayed correct.
    const shown = hasUsableValue(target, name)
      ? classifyEnvVar(name) === "config"
        ? String(target[name])
        : describeEnvValue(name, target[name])
      : "(unset — code default applies)";
    lines.push(`[Config]   ${pad(name, width)}  ${shown}`);
  }

  /* ── The resolved safety answer ─────────────────────────────────────────────────────────── */

  lines.push(
    `[Config] EFFECTIVE: live trading ${validation.liveEnabled ? "ENABLED" : "disabled"} ` +
      `(mode=${validation.executionMode ?? "unset"}, broker=${validation.activeBroker}, ` +
      `login=${validation.loginMode}). Runtime controls still start DISARMED and must be armed ` +
      `through the protected API.`,
  );

  return lines;
}
