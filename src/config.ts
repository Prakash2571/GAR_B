/**
 * APPLICATION configuration — deliberately NOT the Box strategy configuration.
 *
 * `src/box/config.ts` is ported unchanged from CalSpread and owns every `BOX_*`
 * knob, its validation and its fail-closed behaviour. This file owns the things
 * that are true of the PROCESS: which port it listens on, which origin may talk to
 * it, how long shutdown may take, and the two independent live-trading deployment
 * gates that must both be explicit before real orders are even possible.
 *
 * FAIL CLOSED, AT BOOT, WITH A LIST.
 * Configuration errors are collected and reported together rather than thrown one
 * at a time, because an operator fixing a production `.env` at 08:55 IST should
 * see every problem in one pass.
 */

export type NodeEnvName = "development" | "test" | "production";

export interface AppConfig {
  port: number;
  nodeEnv: NodeEnvName;
  /** Always Asia/Kolkata in practice; validated so a typo cannot silently shift the trading day. */
  appTimezone: string;
  /** Exact origin allowed to call the API with credentials. Never a wildcard. */
  frontendUrl: string;
  /** Origin required on mutating requests. Defaults to `frontendUrl`. */
  csrfAllowedOrigin: string;
  sessionCookieName: string;
  siteSessionTtlHours: number;
  shutdownTimeoutMs: number;
  /** Apply pending SQL migrations during boot. False = assert-only. */
  migrateOnBoot: boolean;
  /** `true` when NODE_ENV is production; relaxes nothing, only tightens. */
  isProduction: boolean;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const nodeEnvRaw = (env.NODE_ENV ?? "development").trim();
  const nodeEnv: NodeEnvName =
    nodeEnvRaw === "production" || nodeEnvRaw === "test" ? nodeEnvRaw : "development";
  const isProduction = nodeEnv === "production";

  const port = intOr(env.PORT, 3001);
  if (!(port > 0 && port < 65_536)) problems.push(`PORT must be a valid TCP port (got "${env.PORT}")`);

  // The whole token scheduler, the P&L day key and the trading-session day are IST
  // decisions. A deployment that set this to anything else would be describing a
  // different trading day from the one the exchange keeps, so it is rejected rather
  // than honoured.
  const appTimezone = (env.APP_TIMEZONE ?? "Asia/Kolkata").trim() || "Asia/Kolkata";
  if (appTimezone !== "Asia/Kolkata") {
    problems.push(
      `APP_TIMEZONE must be "Asia/Kolkata" — every trading-day, token-scheduling and P&L-day decision in GTS Box is an IST decision (got "${appTimezone}")`,
    );
  }

  const frontendUrl = (env.FRONTEND_URL ?? "").trim();
  if (!frontendUrl) {
    problems.push("FRONTEND_URL is required: CORS is exact-origin with credentials, never a wildcard");
  } else if (!isAbsoluteHttpUrl(frontendUrl)) {
    problems.push(`FRONTEND_URL must be an absolute http(s) origin (got "${frontendUrl}")`);
  } else if (isProduction && !frontendUrl.startsWith("https://")) {
    problems.push("FRONTEND_URL must be https in production: the session cookie is Secure-only");
  }

  const csrfAllowedOrigin = (env.CSRF_ALLOWED_ORIGIN ?? frontendUrl).trim();
  if (csrfAllowedOrigin && !isAbsoluteHttpUrl(csrfAllowedOrigin)) {
    problems.push(`CSRF_ALLOWED_ORIGIN must be an absolute http(s) origin (got "${csrfAllowedOrigin}")`);
  }

  const sessionCookieName = (env.SESSION_COOKIE_NAME ?? "strikedge_session").trim() || "strikedge_session";
  if (!/^[A-Za-z0-9_-]+$/.test(sessionCookieName)) {
    problems.push("SESSION_COOKIE_NAME may only contain letters, digits, underscore and hyphen");
  }

  const siteSessionTtlHours = numberOr(env.SITE_SESSION_TTL_HOURS, 24);
  if (!(siteSessionTtlHours > 0 && siteSessionTtlHours <= 24 * 30)) {
    problems.push(`SITE_SESSION_TTL_HOURS must be > 0 and <= 720 (got "${env.SITE_SESSION_TTL_HOURS}")`);
  }

  const shutdownTimeoutMs = intOr(env.SHUTDOWN_TIMEOUT_MS, 20_000);
  if (!(shutdownTimeoutMs >= 1_000)) {
    problems.push(`SHUTDOWN_TIMEOUT_MS must be at least 1000 (got "${env.SHUTDOWN_TIMEOUT_MS}")`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port,
    nodeEnv,
    appTimezone,
    frontendUrl: stripTrailingSlash(frontendUrl),
    csrfAllowedOrigin: stripTrailingSlash(csrfAllowedOrigin || frontendUrl),
    sessionCookieName,
    siteSessionTtlHours,
    shutdownTimeoutMs,
    // Default TRUE for a single-process PM2 fork deployment, where boot-time
    // migration is the documented procedure and the advisory lock makes a
    // simultaneous second starter safe. Set false to require `npm run migrate`
    // as an explicit release step; boot then refuses if the schema is behind.
    migrateOnBoot: boolOr(env.PG_MIGRATE_ON_BOOT, true),
    isProduction,
  };
}

function isAbsoluteHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function stripTrailingSlash(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function intOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? n : raw === undefined || raw === "" ? fallback : NaN;
}

function numberOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw === undefined || raw === "" ? fallback : NaN;
}

/**
 * Booleans are strict on purpose. A typo like `BOX_LIVE_TRADING_ENABLED=ture`
 * must not be read as `true`, and a safety gate must never be enabled by an
 * unrecognised value.
 */
export function boolOr(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "") return fallback;
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return false;
}
