/**
 * The site-passcode session store — PostgreSQL is the authority.
 *
 * RESPONSIBILITIES
 *  - constant-time comparison of a presented passcode against SITE_ACCESS_SECRET
 *  - mint a 256-bit random session token + a CSRF token on a correct passcode
 *  - persist ONLY the sha256 of each token (a lookup index over an already
 *    unguessable value — see migrations/007_access_sessions.sql for the rationale)
 *  - validate a presented session token: live (not expired, not revoked)
 *  - revoke a session (logout) and clear it
 *  - sweep expired rows on a bounded timer
 *
 * FAIL CLOSED
 * If SITE_ACCESS_SECRET is unset (or blank) the gate is CLOSED, not open:
 * `verifyPasscode` always returns false and every protected route therefore 401s.
 * An unset secret NEVER means "no passcode required". This is asserted by
 * `isSecretConfigured()` and by the fail-closed test.
 *
 * WHAT IS NEVER PERSISTED OR RETURNED
 * The raw passcode, the raw session token and the raw CSRF token never touch the
 * database. The raw session token is returned to the caller exactly once (at mint)
 * so it can be put in the HttpOnly cookie; the raw CSRF token likewise so it can be
 * put in the JS-readable cookie. Neither is ever read back from storage.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withClient } from "../pg/pool.js";
import { generateCsrfToken, hashCsrfToken } from "./csrf.js";

export type OperatorRole = "full" | "trade";

export interface AccessSessionConfig {
  /** The raw site passcode. Empty/undefined => gate is fail-closed. */
  siteAccessSecret: string | undefined;
  /** Session lifetime in hours. */
  ttlHours: number;
}

export interface MintedSession {
  /** Raw session token — for the HttpOnly cookie. Never stored, never re-derived. */
  sessionToken: string;
  /** Raw CSRF token — for the JS-readable cookie / status response. */
  csrfToken: string;
  expiresAt: Date;
  role: OperatorRole;
}

export interface ValidatedSession {
  role: OperatorRole;
  csrfTokenHash: string;
  expiresAt: Date;
}

/** True only when a non-blank passcode is configured. */
export function isSecretConfigured(cfg: AccessSessionConfig): boolean {
  return typeof cfg.siteAccessSecret === "string" && cfg.siteAccessSecret.length > 0;
}

/**
 * Constant-time passcode comparison.
 *
 * Both sides are reduced to a fixed-width sha256 digest BEFORE comparison, so
 * timingSafeEqual always sees two equal-length (32-byte) buffers. Comparing the
 * raw strings would either throw on a length mismatch (leaking length) or require
 * a variable-time length guard; hashing first removes both problems and also means
 * the presented value's length is not itself a side channel.
 *
 * Fails closed: if no secret is configured this returns false without comparing,
 * so an empty-string presented passcode can never match an empty-string secret.
 */
export function verifyPasscode(cfg: AccessSessionConfig, presented: string | undefined): boolean {
  if (!isSecretConfigured(cfg)) return false; // FAIL CLOSED — unset != "no passcode".
  if (typeof presented !== "string" || presented.length === 0) return false;
  const secret = cfg.siteAccessSecret as string;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  // a and b are both 32 bytes by construction.
  return timingSafeEqual(a, b);
}

/** sha256 hex of a session token — the primary-key form stored in Postgres. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A salted, non-reversible hash of a forensic breadcrumb (IP / user agent). */
export function hashBreadcrumb(value: string | undefined): string | null {
  if (!value) return null;
  // Domain-separated so an IP hash can never collide with a UA hash of the same
  // bytes. The salt is a fixed label, not a secret: this is forensic coarse-graining,
  // not authentication.
  //
  // THE LABEL IS COMPATIBILITY-SENSITIVE AND WAS NOT RENAMED WITH THE REBRAND. It is part of
  // the hash input, so changing it changes every digest this function produces — breadcrumbs
  // already stored in `access_sessions` would no longer correlate with newly computed ones,
  // destroying the only value they have. The label is never rendered, never returned by an API
  // and never seen by an operator, so renaming it would cost forensic continuity for nothing.
  return createHash("sha256").update("strikedge-access-breadcrumb\u0000").update(value).digest("hex");
}

/**
 * Mint a new session after a verified passcode.
 *
 * Generates a 256-bit CSPRNG session token and a CSRF token, stores only their
 * digests, and returns the raw tokens to the caller for cookie delivery.
 */
export async function mintSession(
  cfg: AccessSessionConfig,
  opts: { ip?: string | undefined; userAgent?: string | undefined; role?: OperatorRole },
): Promise<MintedSession> {
  const sessionToken = randomBytes(32).toString("base64url"); // 256-bit
  const csrfToken = generateCsrfToken();
  const role: OperatorRole = opts.role ?? "full";
  const now = Date.now();
  const expiresAt = new Date(now + cfg.ttlHours * 60 * 60 * 1000);

  await query(
    `INSERT INTO access_sessions
       (token_hash, csrf_token_hash, created_at, expires_at, last_seen_at, ip_hash, user_agent_hash, role)
     VALUES ($1, $2, now(), $3, now(), $4, $5, $6)`,
    [
      hashSessionToken(sessionToken),
      hashCsrfToken(csrfToken),
      expiresAt.toISOString(),
      hashBreadcrumb(opts.ip),
      hashBreadcrumb(opts.userAgent),
      role,
    ],
  );

  return { sessionToken, csrfToken, expiresAt, role };
}

/**
 * Validate a presented session token.
 *
 * Returns the live session (role + bound CSRF digest) or null. A row that is
 * expired OR revoked is treated as null — the query filters both, so a caller can
 * never act on a dead session. `last_seen_at` is advanced for observability but
 * never extends `expires_at`.
 */
export async function validateSession(token: string | undefined): Promise<ValidatedSession | null> {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const { rows } = await query<{
    role: OperatorRole;
    csrf_token_hash: string;
    expires_at: Date;
  }>(
    `UPDATE access_sessions
        SET last_seen_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING role, csrf_token_hash, expires_at`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  return { role: row.role, csrfTokenHash: row.csrf_token_hash, expiresAt: row.expires_at };
}

/**
 * Revoke a session (logout). Idempotent: revoking an absent or already-revoked
 * row is a no-op. Returns true if a live row was revoked by this call.
 */
export async function revokeSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const { rowCount } = await query(
    `UPDATE access_sessions
        SET revoked_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL`,
    [hashSessionToken(token)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Delete expired rows. Bounded per call by LIMIT so a large backlog is drained
 * over several sweeps rather than in one unbounded statement that could hold locks
 * or run past the statement timeout. Returns the number removed.
 */
export async function sweepExpiredSessions(limit = 1000, client?: PoolClient): Promise<number> {
  const sql = `
    DELETE FROM access_sessions
     WHERE token_hash IN (
       SELECT token_hash FROM access_sessions
        WHERE expires_at <= now()
        LIMIT $1
     )`;
  if (client) {
    const { rowCount } = await client.query(sql, [limit]);
    return rowCount ?? 0;
  }
  return withClient(async (c) => {
    const { rowCount } = await c.query(sql, [limit]);
    return rowCount ?? 0;
  });
}
