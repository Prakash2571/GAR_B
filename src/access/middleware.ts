/**
 * The access-gate middleware surface.
 *
 * EXPORTS (the seam other modules depend on — see docs/INTERNAL_SEAMS.md, seam 6)
 *  - requireOperator  : RequestHandler that 401s any request without a live session
 *                       cookie, and additionally enforces CSRF + Origin on mutating
 *                       methods. On success it attaches the validated session to the
 *                       request so downstream handlers can read the role synchronously.
 *  - getOperatorRole  : (req) => "full" | "trade" | null, read from the session the
 *                       middleware attached. The two-role shape is preserved from
 *                       the predecessor codebase's getAdminRole so src/box/routes.ts ports with a
 *                       one-line import change; the passcode gate only ever mints "full".
 *  - corsMiddleware   : hand-rolled exact-origin CORS with credentials (never `*`).
 *  - apiError / errorHandler : the single JSON error shape and Express error handler.
 *  - startSessionSweeper : the bounded periodic expiry sweep.
 *
 * WHY getOperatorRole TAKES A REQUEST, NOT A TOKEN STRING
 * the predecessor codebase authenticated with an `x-admin-token` HEADER and an in-memory Map, so
 * `getAdminRole(token)` was a synchronous string lookup. This backend authenticates
 * with an HttpOnly SESSION COOKIE validated against PostgreSQL (async). The role is
 * therefore resolved once, in `requireOperator`, and cached on the request; the
 * synchronous accessor reads that cache. This is the one auth adaptation
 * `src/box/routes.ts` needed beyond the import rename, and it is why a session token
 * in a query string is structurally incapable of authenticating an SSE stream — the
 * accessor never looks at the query string at all.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AppConfig } from "../config.js";
import { boundedError } from "../pg/pool.js";
import { readCookie } from "./cookies.js";
import { CSRF_HEADER, csrfMatches, isMutatingMethod, normalizeCsrfHeader, originAllowed } from "./csrf.js";
import type { OperatorRole, ValidatedSession } from "./sessionStore.js";
import { sweepExpiredSessions, validateSession } from "./sessionStore.js";

/** What requireOperator attaches to a request once a session is validated. */
export interface OperatorContext extends ValidatedSession {
  /** The raw session token from the cookie (never logged, never returned). */
  sessionToken: string;
}

// Augment Express's Request with the validated operator session. Declared here so
// every consumer that imports this module sees the typed field.
declare module "express-serve-static-core" {
  interface Request {
    operator?: OperatorContext;
  }
}

/* --------------------------------- errors --------------------------------- */

/**
 * The single JSON error shape for the whole API.
 *
 * NEVER carries a stack trace, SQL text, a credential or a broker/session token.
 * `code` is a stable machine-readable string; `error` is a short human message.
 */
export interface ApiErrorBody {
  error: string;
  code: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Construct-and-send helper other modules can use for a clean JSON error. */
export function sendApiError(res: Response, status: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: message, code };
  res.status(status).json(body);
}

/**
 * The terminal Express error handler.
 *
 * Any thrown/next-ed error collapses to a bounded, secret-free JSON body. `pg`
 * attaches the failing SQL to its errors and stacks leak internals, so NEITHER is
 * ever serialised: `boundedError` (from the pool module) already strips SQL and
 * truncates, and we only ever emit a generic message for unknown errors.
 */
export function errorHandler(): (err: unknown, req: Request, res: Response, next: NextFunction) => void {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof ApiError) {
      sendApiError(res, err.status, err.code, err.message);
      return;
    }
    // Log the bounded form server-side (no stack, no SQL) for operators; the client
    // gets a generic message with no internals.
    // eslint-disable-next-line no-console
    console.error("[api] unhandled error:", boundedError(err));
    sendApiError(res, 500, "internal_error", "Unexpected server error.");
  };
}

/* ---------------------------------- CORS ---------------------------------- */

/**
 * Hand-rolled, exact-origin CORS with credentials.
 *
 * The allowed origin is `config.frontendUrl` — a single exact origin, echoed back
 * only when it matches the request's Origin. It is NEVER `*`, because
 * `Access-Control-Allow-Origin: *` is illegal together with
 * `Access-Control-Allow-Credentials: true` and browsers reject the pair; more
 * importantly a wildcard with credentials would let any site read authenticated
 * responses. A non-matching Origin gets no ACAO header at all (the browser then
 * blocks the response), which is the correct fail-closed behaviour.
 */
export function corsMiddleware(config: AppConfig): RequestHandler {
  const allowed = config.frontendUrl;
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && origin === allowed) {
      res.header("Access-Control-Allow-Origin", allowed);
      res.header("Access-Control-Allow-Credentials", "true");
      res.header("Vary", "Origin");
      res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.header("Access-Control-Allow-Headers", `Content-Type, ${CSRF_HEADER}`);
    }
    // Never cache API responses; live financial data must not be revalidated as 304.
    res.header("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      // Preflight: 204 with the headers already set (or not set, for a foreign origin).
      res.sendStatus(204);
      return;
    }
    next();
  };
}

/* ------------------------------- auth guard ------------------------------- */

export interface RequireOperatorDeps {
  config: AppConfig;
}

/**
 * Build the `requireOperator` middleware.
 *
 * On EVERY request it validates the session cookie against PostgreSQL. A missing or
 * dead (expired/revoked/unknown) session is a 401 — a direct API call without a
 * valid session never reaches a protected handler, so a frontend overlay is never
 * relied on for security.
 *
 * On MUTATING methods (POST/PUT/PATCH/DELETE) it additionally requires:
 *   1. an Origin header matching CSRF_ALLOWED_ORIGIN, and
 *   2. a NON-EMPTY x-csrf-token HEADER whose sha256 matches the session-bound
 *      digest (constant time). The readable CSRF cookie is NEVER accepted as a
 *      substitute for the header — see src/access/csrf.ts for why a cookie fallback
 *      would silently defeat CSRF protection.
 * Either failure is a 403 before the handler runs.
 */
export function createRequireOperator(deps: RequireOperatorDeps): RequestHandler {
  const { config } = deps;
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = readCookie(req, config.sessionCookieName);
    void validateSession(token)
      .then((session) => {
        if (!session) {
          sendApiError(res, 401, "unauthenticated", "Authentication required.");
          return;
        }
        // Attach for the synchronous getOperatorRole accessor + downstream handlers.
        req.operator = { ...session, sessionToken: token as string };

        if (isMutatingMethod(req.method)) {
          // 1) Origin must match the configured allowed origin. A missing Origin on
          // a state-changing request is refused (see csrf.originAllowed).
          if (!originAllowed(req.headers.origin, config.csrfAllowedOrigin)) {
            sendApiError(res, 403, "bad_origin", "Request origin is not allowed.");
            return;
          }
          // 2) CSRF header must match the session-bound token, in constant time.
          // The token MUST arrive in the x-csrf-token HEADER — the JS-readable CSRF
          // cookie is NEVER accepted as a substitute. A cross-site form POST makes the
          // browser attach our cookies automatically, so honouring the cookie would
          // silently defeat the header requirement; the attacker's page cannot READ
          // our cookie (same-origin policy), so only a header it cannot forge proves
          // the request originated from our own SPA. A present-but-empty/whitespace
          // header is rejected exactly like a missing one.
          const presented = normalizeCsrfHeader(req.header(CSRF_HEADER));
          if (!csrfMatches(presented, session.csrfTokenHash)) {
            sendApiError(res, 403, "csrf_failed", "Invalid or missing CSRF token.");
            return;
          }
        }
        next();
      })
      .catch((err) => {
        // A storage outage must fail closed, not open. Never leak the cause.
        // eslint-disable-next-line no-console
        console.error("[access] session validation failed:", boundedError(err));
        if (!res.headersSent) sendApiError(res, 503, "auth_unavailable", "Authentication is temporarily unavailable.");
      });
  };
}

/**
 * The synchronous role accessor `src/box/routes.ts` uses (renamed from
 * the predecessor codebase's `getAdminRole`). Reads the role the middleware validated and
 * attached; returns null when there is no live session on the request. It NEVER
 * consults a header or query-string token, so a session token supplied in an SSE
 * query string cannot authenticate anything.
 */
export function getOperatorRole(req: Request): OperatorRole | null {
  return req.operator?.role ?? null;
}

/* -------------------------------- sweeper --------------------------------- */

/**
 * Start the bounded periodic expiry sweep. Returns a stop() the boot/shutdown
 * wiring can call. The interval is unref'd so it never keeps the process alive on
 * its own, and each tick is bounded by LIMIT inside sweepExpiredSessions.
 */
export function startSessionSweeper(intervalMs = 5 * 60_000): { stop: () => void } {
  const timer = setInterval(() => {
    void sweepExpiredSessions().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[access] session sweep failed:", boundedError(err));
    });
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
  };
}
