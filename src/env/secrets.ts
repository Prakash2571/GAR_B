/**
 * THE ENVIRONMENT CLASSIFICATION REGISTRY — which variables are credentials, which are operational
 * configuration, and how a value may be described in a log or an HTTP response.
 *
 * WHY THIS EXISTS AS ONE MODULE
 *
 * Before this file, "is X a secret?" was answered independently in four places with four different
 * rules (`redactConnectionString` in pg/pool.ts, `redactIdentity` in runtime/projections.ts,
 * `maskAccountId` in box/operationalReadiness.ts, `sanitize` in box/executionFaults.ts). Those remain
 * where they are — they guard live request paths and re-plumbing them would be a behaviour change for
 * no safety gain. What was missing was a single answer for the ENVIRONMENT: the deployment needs to
 * know which names belong in a protected file, which may sit in a readable `.env`, and which must
 * never be printed. That question now has exactly one source of truth.
 *
 * TWO INDEPENDENT DECISIONS, DELIBERATELY DECOUPLED
 *
 *   1. HOW MAY THIS VALUE BE DESCRIBED?  — decided FAIL-CLOSED. {@link classifyEnvVar} consults the
 *      explicit table first and then falls back to NAME PATTERNS, so a variable added next year that
 *      is called `..._SECRET` or `..._PASSCODE` is redacted from the moment it exists, without anyone
 *      remembering to register it. Getting this wrong in the safe direction costs a hidden value in a
 *      diagnostic; getting it wrong in the unsafe direction leaks a credential.
 *
 *   2. IS THIS VALUE REQUIRED?  — decided EXPLICITLY, never by pattern (see `./validate.ts`). A
 *      pattern that guessed requiredness would refuse to boot over a variable it merely suspected
 *      existed, and "the process will not start and I cannot tell you which real setting is wrong" is
 *      its own outage. Patterns may therefore only ever make output *safer*, never startup *stricter*.
 *
 * NO DEPENDENCIES. Node builtins only, and in fact none are needed. This module is imported by the
 * env loader, which runs before anything else in the process, so it must not pull in `pg`, `express`
 * or any transitive initialisation.
 */

// Imported explicitly rather than relying on the ambient global. This module is evaluated before
// anything else in the process, and an explicit import makes it independent of which lib/types the
// compiler happens to have configured.
import { URL } from "node:url";

/**
 * How a variable's value may be treated.
 *
 *   secret   — a credential. NEVER printed, NEVER returned over HTTP, belongs in the protected
 *              secrets file rather than in `.env`.
 *   identity — not a credential (it cannot authenticate anything on its own) but it names a real
 *              account, key or host. Masked in diagnostics, and legitimately lives in `.env`. This
 *              class exists because the codebase already draws exactly this line: broker account
 *              labels are masked (`AB••34`) rather than hidden, since an operator must be able to
 *              confirm WHICH account is connected without the value being quotable.
 *   config   — non-sensitive operational configuration. The value may be shown in full, which is the
 *              entire point: an operator debugging a risk limit needs to see the number.
 */
export type EnvClass = "secret" | "identity" | "config";

/**
 * Every variable that is NOT plain configuration, named explicitly.
 *
 * Only secrets and identities are listed. Configuration is the default, so this table stays short and
 * a reader can see the whole sensitive surface in one screen. Each entry says where the value is read,
 * because "is this still used?" is the first question during a rotation.
 */
export const EXPLICIT_ENV_CLASS: ReadonlyMap<string, EnvClass> = new Map<string, EnvClass>([
  /* ── Site / session ─────────────────────────────────────────────────────────────────────── */
  // The passcode for the whole site gate. Unset means fail-closed (every protected route 401s), so
  // this is a credential whose ABSENCE is safe and whose disclosure is total compromise.
  ["SITE_ACCESS_SECRET", "secret"],

  /* ── At-rest token encryption (src/brokerState/tokenCrypto.ts) ──────────────────────────── */
  // AES-256-GCM key for stored broker access tokens. Must decode to exactly 32 bytes.
  ["BROKER_TOKEN_ENCRYPTION_KEY", "secret"],
  // Rotation material, read only by src/scripts/rotateBrokerTokenKey.ts.
  ["BROKER_TOKEN_OLD_KEY", "secret"],
  ["BROKER_TOKEN_NEW_KEY", "secret"],

  /* ── The one deliberate token-egress surface (src/tokenExposureRoutes.ts) ───────────────── */
  // Bearer key for GET /api/tokens/*, compared with timingSafeEqual. Holding it yields live broker
  // access tokens, so it is as sensitive as the tokens themselves.
  ["TOKEN_EXPOSURE_KEY", "secret"],

  /* ── Datastores: DSNs carry an embedded password ────────────────────────────────────────── */
  ["DATABASE_URL", "secret"],
  ["MONGODB_URI", "secret"],
  ["LEGACY_BOX_MONGODB_URI", "secret"],

  /* ── Zerodha / Kite ─────────────────────────────────────────────────────────────────────── */
  ["KITE_API_KEY", "secret"],
  ["KITE_API_SECRET", "secret"],
  // Passcode presented to the token provider; it travels with an access token.
  ["KITE_TOKEN_BROKER_PASSCODE", "secret"],
  // NOT a credential: this is the api key the process EXPECTS to see, used for comparison only. It
  // names the Kite app, so it is masked rather than hidden.
  ["KITE_API_KEY_EXPECTED", "identity"],

  /* ── Dhan ───────────────────────────────────────────────────────────────────────────────── */
  ["DHAN_API_KEY", "secret"],
  ["DHAN_API_SECRET", "secret"],
  ["DHAN_TOKEN_BROKER_PASSCODE", "secret"],
  // Account identifiers and the static egress IP: real identifiers, not credentials.
  ["DHAN_CLIENT_ID", "identity"],
  ["DHAN_CLIENT_ID_EXPECTED", "identity"],
  ["DHAN_STATIC_PUBLIC_IP", "identity"],
  ["DHAN_STATIC_IP_EXPECTED", "identity"],

  /* ── Explicitly NOT secrets, listed to stop the patterns below guessing wrong ───────────── */
  // A HEADER NAME (e.g. "X-Auth-Secret"), not a secret. It ends in `_HEADER` so no pattern matches
  // it, but it is pinned here because the word "SECRET" in the middle invites a future broader rule.
  ["DHAN_AUTH_SECRET_HEADER", "config"],
  // Token-provider endpoints. Security-relevant (a passcode is POSTed to them) but not credentials,
  // and an operator must be able to see which host is being dialled. Pinned so no `_URL`-style rule
  // ever hides them.
  ["KITE_TOKEN_BROKER_URL", "config"],
  ["DHAN_TOKEN_URL", "config"],
]);

/**
 * NAME PATTERNS that make an UNREGISTERED variable a secret.
 *
 * Fail-closed defaults for names nobody has classified yet. Anchored at the END on purpose: the
 * suffix is what reliably indicates a credential, whereas a substring rule would swallow
 * `BOX_MAX_SUBSCRIBED_TOKENS` (a count), `BROKER_TOKEN_POLL_INTERVAL_MS` (a duration) and
 * `DHAN_AUTH_SECRET_HEADER` (a header name) — three real variables in this repo that are plainly not
 * credentials.
 *
 * Reminder of the rule from the module header: matching here affects REDACTION ONLY. It never makes a
 * variable required, so a false positive costs visibility, never availability.
 */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /_SECRET$/,
  /_PASSCODE$/,
  /_PASSWORD$/,
  /_KEY$/,
  /_URI$/,
  /_DSN$/,
  /_ACCESS_TOKEN$/,
  /_AUTH_TOKEN$/,
  /_PRIVATE_KEY$/,
  /_CREDENTIALS$/,
];

/**
 * Classify one variable name.
 *
 * Explicit table wins, so a name that looks like a credential but is not (`DHAN_AUTH_SECRET_HEADER`)
 * can be pinned, and a name that does not look like one but is can be too.
 */
export function classifyEnvVar(name: string): EnvClass {
  const explicit = EXPLICIT_ENV_CLASS.get(name);
  if (explicit !== undefined) return explicit;
  for (const pattern of SECRET_NAME_PATTERNS) {
    if (pattern.test(name)) return "secret";
  }
  return "config";
}

/** Convenience: whether this name must never have its value printed. */
export function isSecretEnvVar(name: string): boolean {
  return classifyEnvVar(name) === "secret";
}

/** Every explicitly-registered secret name, sorted. Used by the loader, validator and tests. */
export function registeredSecretNames(): string[] {
  return [...EXPLICIT_ENV_CLASS.entries()]
    .filter(([, cls]) => cls === "secret")
    .map(([name]) => name)
    .sort();
}

/**
 * Mask an identity: keep the last 4 characters so an operator can confirm WHICH account or key is in
 * play, hide the rest.
 *
 * Deliberately the same shape as `redactIdentity` in src/runtime/projections.ts, so the two surfaces
 * agree on how an identity looks. Values of 4 characters or fewer are masked ENTIRELY rather than
 * shown — for a short value "the last 4" is the whole thing.
 */
export function maskIdentity(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) return "";
  if (value.length <= 4) return "•".repeat(value.length);
  return `${"•".repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}

/**
 * Summarise a connection string as `host:port/database`, dropping user and password entirely.
 *
 * Same intent as `redactConnectionString` in src/pg/pool.ts, reimplemented here with no dependencies
 * because this module loads before `pg` is imported. An unparseable DSN collapses to `(configured)`
 * rather than being echoed: a string we could not parse is exactly the string we must not print,
 * since we cannot know which part of it is the password.
 */
export function summariseDsn(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) return "";
  try {
    const url = new URL(value);
    const port = url.port === "" ? "" : `:${url.port}`;
    const db = url.pathname === "" || url.pathname === "/" ? "" : url.pathname;
    if (url.hostname === "") return "(configured)";
    return `${url.hostname}${port}${db}`;
  } catch {
    return "(configured)";
  }
}

/**
 * How a variable may be reported in a diagnostic, given whether it is set.
 *
 * The contract this function exists to enforce: for a `secret` the ONLY information that ever leaves
 * is whether it is present. Not its length, not a prefix, not a hash — a length narrows a brute
 * force and a prefix is often the whole distinguishing part of an API key.
 *
 * DSN-shaped secrets are the one nuance: `DATABASE_URL: configured` is nearly useless when the
 * question is "which database am I pointed at?", and pointing at the wrong database is a real
 * operational failure. So those report host/port/database with the credentials stripped, which is
 * what `pgStatus()` already publishes.
 */
export function describeEnvValue(name: string, raw: string | undefined): string {
  const value = (raw ?? "").trim();
  const cls = classifyEnvVar(name);
  if (value.length === 0) return "missing";
  switch (cls) {
    case "secret": {
      // A DSN names a target as well as carrying a password, and the target is the operational fact an
      // operator needs ("which database am I pointed at?"). Anything we could NOT parse falls back to
      // bare `configured`: an unparseable string is exactly the one we must not print, since we cannot
      // tell which part of it is the password.
      if (!/_URI$|_URL$|_DSN$/.test(name)) return "configured";
      const target = summariseDsn(value);
      return target === "" || target === "(configured)" ? "configured" : `configured (${target})`;
    }
    case "identity":
      return maskIdentity(value);
    default:
      return value;
  }
}

/**
 * Redact a value for inclusion in an arbitrary message.
 *
 * Use this when composing text that MIGHT contain a value — a parser warning, an error path. For
 * secrets it returns a fixed placeholder rather than anything derived from the input, so no property
 * of the secret survives into the string.
 */
export function redactEnvValue(name: string, raw: string | undefined): string {
  const cls = classifyEnvVar(name);
  if (cls === "config") return raw ?? "";
  if (cls === "identity") return maskIdentity(raw ?? "");
  return "[redacted]";
}
