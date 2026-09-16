/**
 * The site-passcode HTTP surface, mounted under /api/access.
 *
 *   POST /api/access/verify   public, rate-limited. Checks the passcode and, on
 *                             success, mints a session + CSRF token and sets the
 *                             cookies. This is the ONLY public mutating route.
 *   GET  /api/access/status   returns whether the caller has a live session and,
 *                             if so, the CSRF token for subsequent mutating calls.
 *   POST /api/access/logout   revokes the session row and clears the cookies.
 *
 * ARMS NOTHING
 * A successful verify grants the operator the FULL Box CONTROL surface (role
 * "full"), but it does not — and must not — arm live trading or enable real
 * orders. The BOX_EXECUTION_MODE / BOX_LIVE_TRADING_ENABLED / per-broker gates and
 * the runtime arming controls are entirely independent and are never touched here.
 */

import type { Express, Request, Response } from "express";
import type { AppConfig } from "../config.js";
import { clearSessionCookies, csrfCookieName, readCookie, setSessionCookies } from "./cookies.js";
import { CSRF_HEADER, csrfMatches, normalizeCsrfHeader, originAllowed } from "./csrf.js";
import { trustedClientIp } from "../clientIp.js";
import { sendApiError } from "./middleware.js";
import type { AccessSessionConfig } from "./sessionStore.js";
import {
  isSecretConfigured,
  mintSession,
  revokeSession,
  validateSession,
  verifyPasscode,
} from "./sessionStore.js";

export interface AccessRouteDeps {
  config: AppConfig;
  session: AccessSessionConfig;
  /** The verify rate-limit middleware (10 / 5 min / IP). */
  verifyRateLimit: import("express").RequestHandler;
}

/**
 * The client IP recorded on a minted session, from the SAME trusted derivation the limiter uses.
 *
 * This used to read the first `X-Forwarded-For` element independently of the limiter. Since nginx
 * APPENDS to that header, position 0 was the caller's own value — so the forged address was persisted
 * as the session's origin and the audit trail said whatever the client wanted it to say. Fixing only
 * the limiter would have left that poisoned, which is why both now share one helper.
 */
function clientIp(req: Request): string | undefined {
  const ip = trustedClientIp(req);
  return ip === "unknown" ? undefined : ip;
}

export function registerAccessRoutes(app: Express, deps: AccessRouteDeps): void {
  const { config, session } = deps;
  const csrfName = csrfCookieName(config);
  const ttlSeconds = Math.floor(session.ttlHours * 60 * 60);

  /**
   * POST /api/access/verify — check the passcode.
   *
   * Generic failure: a wrong passcode and an UNSET secret produce the exact same
   * 401 body, so the response never distinguishes "wrong" from "not configured".
   * verifyPasscode fails closed when the secret is unset, so this route can never
   * mint a session without a real, matching passcode.
   */
  app.post("/api/access/verify", deps.verifyRateLimit, async (req: Request, res: Response) => {
    try {
      const presented =
        typeof (req.body as { passcode?: unknown } | undefined)?.passcode === "string"
          ? ((req.body as { passcode: string }).passcode)
          : undefined;

      if (!verifyPasscode(session, presented)) {
        // Identical body whether the passcode was wrong or the secret is unset.
        sendApiError(res, 401, "invalid_passcode", "Invalid passcode.");
        return;
      }

      const minted = await mintSession(session, {
        ip: clientIp(req),
        userAgent: req.header("user-agent") ?? undefined,
        role: "full",
      });

      setSessionCookies(res, config, {
        sessionToken: minted.sessionToken,
        csrfToken: minted.csrfToken,
        csrfCookieName: csrfName,
        maxAgeSeconds: ttlSeconds,
      });

      // The CSRF token is also returned in the body so an SPA can capture it
      // without reading the cookie. It grants nothing on its own — a mutating
      // request still needs the HttpOnly session cookie AND a matching Origin.
      res.status(200).json({
        authenticated: true,
        role: minted.role,
        csrf_token: minted.csrfToken,
        expires_at: minted.expiresAt.toISOString(),
      });
    } catch {
      // Never leak the cause of a mint/storage failure.
      sendApiError(res, 503, "access_unavailable", "Access is temporarily unavailable.");
    }
  });

  /**
   * GET /api/access/status — is there a live session?
   *
   * Public (no requireOperator) so the passcode page can ask "am I already in?"
   * without a 401 loop. Returns the CSRF token for a live session so the SPA can
   * recover it after a reload; returns `authenticated:false` otherwise. Never
   * reveals whether the secret is configured.
   */
  app.get("/api/access/status", async (req: Request, res: Response) => {
    try {
      const token = readCookie(req, config.sessionCookieName);
      const live = await validateSession(token);
      if (!live) {
        res.status(200).json({ authenticated: false });
        return;
      }
      // Echo the CSRF token from the cookie if present (it is JS-readable anyway),
      // so a reloaded SPA can repopulate its header source. We never store or
      // return the raw token from the DB — only the cookie can supply it.
      const csrfFromCookie = readCookie(req, csrfName);
      res.status(200).json({
        authenticated: true,
        role: live.role,
        expires_at: live.expiresAt.toISOString(),
        ...(csrfFromCookie && csrfMatches(csrfFromCookie, live.csrfTokenHash)
          ? { csrf_token: csrfFromCookie }
          : {}),
      });
    } catch {
      sendApiError(res, 503, "access_unavailable", "Access is temporarily unavailable.");
    }
  });

  /**
   * POST /api/access/logout — revoke the session and clear the cookies.
   *
   * ASYMMETRIC BY DESIGN — and it does NOT weaken CSRF protection.
   * This route is not behind `requireOperator`, so it enforces CSRF + Origin inline.
   *
   *  - WITH a live session: this is a real state-changing mutation (it revokes the
   *    session row), so it is protected by the SAME strict discipline as any other
   *    mutation — an exact allowed Origin AND a non-empty `x-csrf-token` HEADER whose
   *    sha256 matches the session-bound digest. The readable CSRF cookie is NEVER
   *    accepted as a substitute for the header (see src/access/csrf.ts).
   *
   *  - WITHOUT a live session (expired/revoked/unknown): there is NO session to
   *    protect. A forged cross-site "logout" of a session that no longer exists
   *    changes nothing on the server, so requiring a CSRF header here would protect
   *    nothing while stranding a browser that still holds a dead cookie — it could
   *    never clear it (the header source is gone with the session). We therefore
   *    still clear the cookies and return 200 `{authenticated:false}` without a
   *    header. This is safe precisely because the CSRF header only ever guards a
   *    LIVE session's state; with no live session there is no state to guard.
   */
  app.post("/api/access/logout", async (req: Request, res: Response) => {
    try {
      const token = readCookie(req, config.sessionCookieName);
      const live = await validateSession(token);

      if (live) {
        if (!originAllowed(req.headers.origin, config.csrfAllowedOrigin)) {
          sendApiError(res, 403, "bad_origin", "Request origin is not allowed.");
          return;
        }
        // The token MUST come from the HEADER — the readable CSRF cookie is never a
        // substitute (a cross-site POST would carry the cookie automatically). An
        // empty/whitespace header is rejected exactly like a missing one.
        const presented = normalizeCsrfHeader(req.header(CSRF_HEADER));
        if (!csrfMatches(presented, live.csrfTokenHash)) {
          sendApiError(res, 403, "csrf_failed", "Invalid or missing CSRF token.");
          return;
        }
        await revokeSession(token);
      }

      // Always clear the cookies, even if the session was already dead, so the
      // browser stops presenting a revoked/expired credential.
      clearSessionCookies(res, config, csrfName);
      res.status(200).json({ authenticated: false });
    } catch {
      sendApiError(res, 503, "access_unavailable", "Access is temporarily unavailable.");
    }
  });
}
