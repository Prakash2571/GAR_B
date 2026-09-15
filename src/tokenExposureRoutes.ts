/**
 * TOKEN EXPOSURE, mounted under /api/tokens.
 *
 *   GET /api/tokens/zerodha   the current Zerodha access token + the api key it pairs with.
 *   GET /api/tokens/dhan      the current Dhan access token + the client id it pairs with.
 *
 * These are the two links other servers fetch a token from, so this deployment is the ONE
 * place a broker login happens and every other service borrows the result instead of
 * running its own login.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * READ THIS FIRST: THIS MODULE IS A DELIBERATE, NARROW EXCEPTION TO A STANDING RULE
 * ─────────────────────────────────────────────────────────────────────────────────────
 * Everywhere else in this backend it is an invariant that NO route returns a raw or
 * encrypted access token — src/brokerRoutes.ts, src/runtime/projections.ts and
 * docs/BROKER_TOKENS.md all state it, and decryption is confined to
 * src/brokerState/brokerSessions.ts. This module returns the plaintext token ON PURPOSE,
 * because distributing the token to sibling services is its entire reason to exist.
 *
 * That makes these two routes the highest-value target in the whole API, so the exception
 * is fenced in every way that does not defeat the purpose:
 *
 *   1. OFF BY DEFAULT, FAIL CLOSED. With `TOKEN_EXPOSURE_KEY` unset there is no way to
 *      get a token out of here: every request answers 503. Nobody acquires this surface
 *      by upgrading — they have to choose it.
 *   2. A DEDICATED CREDENTIAL, NOT THE OPERATOR SESSION. Callers are servers, not
 *      browsers, so they authenticate with a long shared secret in the
 *      `x-token-access-key` HEADER — never a query string (which lands in access logs,
 *      proxy logs and browser history). It is compared in CONSTANT TIME. This is
 *      deliberately NOT the site passcode and NOT a session cookie: a machine credential
 *      that leaks must be revocable without logging every operator out, and it must not
 *      be usable to drive the trading UI.
 *   3. WEAK SECRETS ARE REFUSED AT THE DOOR. A key shorter than
 *      `MIN_TOKEN_EXPOSURE_KEY_LENGTH` is treated as a misconfiguration (503), not
 *      honoured, because a guessable key here is equivalent to publishing the token.
 *   4. RATE LIMITED per IP, so the shared secret cannot be brute-forced quickly.
 *   5. READ-ONLY AND SIDE-EFFECT FREE. No GET here mints, refreshes, invalidates or
 *      switches anything. It cannot be used to change what this deployment trades.
 *   6. NEVER LOGGED. No branch writes the token, the identity or the presented key to the
 *      console — including the failure branches, which log only a code.
 *   7. NO CACHING. `Cache-Control: no-store` is already applied globally by
 *      corsMiddleware, and it matters most here: an intermediary caching this response
 *      would hand the token to the next caller without a credential.
 *   8. NOT UNDER /api/broker/*. Kept on its own prefix so the documented
 *      "no /api/broker/* route ever returns a token" invariant stays literally true and
 *      reviewers are not misled about which surface is sensitive.
 *
 * DEPLOYMENT REQUIREMENT: TLS IS NOT OPTIONAL HERE. This response is a bearer credential
 * in a body. Terminate TLS in front of it (see deploy/nginx.conf) and restrict the route
 * to the networks that legitimately need it. `Secure` transport is the operator's job; the
 * code cannot enforce it from behind a reverse proxy that already terminated the
 * connection.
 *
 * FRESHNESS IS THE CALLER'S PROBLEM, AND THE PAYLOAD SAYS SO
 * A token is only returned when it is CURRENTLY USABLE: Zerodha's must be from today's
 * IST day (Kite sessions die at the day boundary) and Dhan's must not be past a stated
 * expiry. Anything else is 409 with a reason rather than a stale token, because handing a
 * sibling service a dead credential turns one broken login into several. `expires_at` and
 * `login_date` are returned so a caller can cache correctly instead of polling.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { sendApiError } from "./access/middleware.js";
import { parseBrokerId, type BrokerId } from "./brokerRoutes.js";
import { rateLimit } from "./ratelimit.js";

/**
 * Minimum length for `TOKEN_EXPOSURE_KEY`.
 *
 * 32 characters of random text is ~190 bits at base64url — far past brute force even
 * without the rate limiter. The point of a floor is that a human-chosen key ("letmein")
 * must be REFUSED rather than merely discouraged: this endpoint hands out a live trading
 * credential, so a weak gate is the same as no gate.
 */
export const MIN_TOKEN_EXPOSURE_KEY_LENGTH = 32;

/** The header a calling server presents its shared secret in. Never a query parameter. */
export const TOKEN_ACCESS_HEADER = "x-token-access-key";

/** Window and cap for the exposure routes, per IP. */
export const TOKEN_EXPOSURE_WINDOW_MS = 60_000;
export const TOKEN_EXPOSURE_MAX_REQUESTS = 30;

/** One broker's currently usable credential, as read from the durable store. */
export interface ExposedToken {
  accessToken: string;
  /**
   * The value the token must be PAIRED with to authenticate:
   *   • zerodha → the Kite api key   (Authorization: token <identity>:<access_token>)
   *   • dhan    → the dhan client id (client-id: <identity>, access-token: <access_token>)
   */
  identity: string;
  /** IST day the session was established, "YYYY-MM-DD". */
  loginDate: string;
  /** Epoch ms the token stops working, or null when the broker stated none. */
  expiresAtMs: number | null;
}

/** Why a token could not be served. Stable codes; safe to return in a body. */
export type TokenUnavailableReason =
  | "no_session"
  | "session_expired"
  | "session_stale_day"
  | "store_unavailable";

export type TokenLookup =
  | { ok: true; token: ExposedToken }
  | { ok: false; reason: TokenUnavailableReason };

/**
 * The narrow provider src/index.ts supplies.
 *
 * Declared as an interface (rather than importing `brokerSessions.ts` here) for the same
 * reason `ActiveBrokerProvider` is: this module must not be able to reach into the token
 * store, decide freshness policy, or acquire anything. It asks one question and formats
 * the answer.
 */
export interface TokenExposureProvider {
  /** The currently usable token for `broker`, or a reason there is none. */
  currentToken(broker: BrokerId): Promise<TokenLookup>;
  /** Which broker is trading right now. Informational for the caller. */
  activeBroker(): BrokerId;
}

export interface TokenExposureConfig {
  /** `TOKEN_EXPOSURE_KEY`. Empty/unset ⇒ the whole surface answers 503. */
  accessKey: string;
}

export interface TokenExposureRouteDeps {
  tokens: TokenExposureProvider;
  config: TokenExposureConfig;
  /** Injectable so tests can mount without the shared limiter's timers. */
  rateLimiter?: RequestHandler;
}

/** Read the configured key from the environment. Trimmed; never logged. */
export function tokenExposureConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TokenExposureConfig {
  return { accessKey: env.TOKEN_EXPOSURE_KEY?.trim() ?? "" };
}

/** Is the surface configured well enough to serve at all? */
export function tokenExposureEnabled(config: TokenExposureConfig): boolean {
  return config.accessKey.length >= MIN_TOKEN_EXPOSURE_KEY_LENGTH;
}

/**
 * Constant-time comparison of the presented key against the configured one.
 *
 * Lengths are compared first because `timingSafeEqual` throws on a length mismatch. That
 * leaks only the length of the configured key, which is not the secret — and a
 * short-circuit on the CONTENT is what would actually let an attacker walk the key one
 * byte at a time.
 */
export function tokenAccessKeyMatches(presented: string, configured: string): boolean {
  if (presented.length !== configured.length || configured.length === 0) return false;
  return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(configured, "utf8"));
}

/** The wire shape both routes return. NO field here is derived from the request. */
interface ExposedTokenBody {
  broker: BrokerId;
  access_token: string;
  identity: string;
  login_date: string;
  expires_at: string | null;
  /** Whether this broker is the one currently trading. */
  active: boolean;
  /** When this answer was produced, so a caller can reason about its own cache. */
  fetched_at: string;
}

export function registerTokenExposureRoutes(app: Express, deps: TokenExposureRouteDeps): void {
  const { tokens, config } = deps;
  const limiter =
    deps.rateLimiter ??
    rateLimit({
      windowMs: TOKEN_EXPOSURE_WINDOW_MS,
      max: TOKEN_EXPOSURE_MAX_REQUESTS,
      message: "Too many token requests. Please slow down.",
    });

  app.get("/api/tokens/:broker", limiter, async (req: Request, res: Response) => {
    // 1. Is the surface switched on at all? Answered BEFORE the credential is examined,
    //    so a deployment that never opted in cannot be probed for key validity.
    if (!tokenExposureEnabled(config)) {
      sendApiError(
        res,
        503,
        "token_exposure_disabled",
        config.accessKey.length === 0
          ? "Token exposure is disabled. Set TOKEN_EXPOSURE_KEY to enable it."
          : `Token exposure is disabled: TOKEN_EXPOSURE_KEY must be at least ${MIN_TOKEN_EXPOSURE_KEY_LENGTH} characters.`,
      );
      return;
    }

    // 2. The shared secret, from the header only.
    const presented = req.header(TOKEN_ACCESS_HEADER)?.trim() ?? "";
    if (!tokenAccessKeyMatches(presented, config.accessKey)) {
      // One message for missing AND wrong, so a caller cannot tell which it was. The
      // presented value is never echoed and never logged.
      sendApiError(res, 401, "token_access_denied", "A valid token access key is required.");
      return;
    }

    // 3. Which broker. Validated against the closed set, never trusted from the path.
    const broker = parseBrokerId(req.params.broker);
    if (!broker) {
      sendApiError(res, 404, "bad_broker", 'broker must be "zerodha" or "dhan".');
      return;
    }

    let lookup: TokenLookup;
    try {
      lookup = await tokens.currentToken(broker);
    } catch {
      // A store/decrypt failure must never be reported as "no session": a caller told
      // there is no token may go and mint a competing one.
      sendApiError(
        res,
        503,
        "token_store_unavailable",
        "The token store is temporarily unavailable.",
      );
      return;
    }

    if (!lookup.ok) {
      // 409, not 404: the broker is a valid resource that currently has no usable
      // credential — a distinction a polling sibling service needs in order to back off
      // rather than treat the URL as wrong.
      sendApiError(
        res,
        409,
        `token_unavailable_${lookup.reason}`,
        describeUnavailable(broker, lookup.reason),
      );
      return;
    }

    const body: ExposedTokenBody = {
      broker,
      access_token: lookup.token.accessToken,
      identity: lookup.token.identity,
      login_date: lookup.token.loginDate,
      expires_at:
        lookup.token.expiresAtMs === null ? null : new Date(lookup.token.expiresAtMs).toISOString(),
      active: tokens.activeBroker() === broker,
      fetched_at: new Date().toISOString(),
    };
    // Belt-and-braces alongside the global `no-store`: this body must never be cached by
    // an intermediary, because caching it removes the credential check.
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.status(200).json(body);
  });
}

/** Operator-facing sentence for an unavailable token. Contains no credential. */
function describeUnavailable(broker: BrokerId, reason: TokenUnavailableReason): string {
  switch (reason) {
    case "no_session":
      return `No ${broker} session is stored. Sign in to ${broker} from the workspace first.`;
    case "session_expired":
      return `The stored ${broker} token has passed its expiry. Sign in to ${broker} again.`;
    case "session_stale_day":
      return `The stored ${broker} token is from an earlier trading day. Sign in to ${broker} again.`;
    case "store_unavailable":
      return "The token store is temporarily unavailable.";
    default:
      return `No usable ${broker} token is available.`;
  }
}
