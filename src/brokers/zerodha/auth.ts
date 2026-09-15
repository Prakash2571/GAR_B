/**
 * Zerodha (Kite Connect v3) IN-APP browser login, and the session it produces.
 *
 * THE FLOW (three steps, two of them server-side)
 *   1. This backend builds the consent URL
 *        https://kite.zerodha.com/connect/login?v=3&api_key=…&redirect_params=state%3D…
 *      and hands it to the operator's browser. No secret is in that URL: `api_key` is
 *      public and `state` is a single-use nonce, not a credential.
 *   2. The BROWSER visits it. Zerodha authenticates the user (password + TOTP) and
 *      redirects to the redirect URL REGISTERED ON THE KITE APP with
 *        ?request_token=…&action=login&status=success  (+ our echoed state)
 *   3. This backend POSTs the request token to `${apiRoot}/session/token` together with
 *        checksum = sha256(api_key + request_token + api_secret)
 *      and receives `access_token`, `user_id`, `user_name`, `login_time`.
 *
 * WHY THIS EXISTS AGAIN
 * The predecessor design pulled the day's Zerodha token from an EXTERNAL provider over
 * HTTP, so `generateSession()` in src/kite.ts was a throwing stub and there was no
 * login-URL builder at all. That made the operator depend on a second service to start
 * trading. This module restores the exchange so a token can be minted HERE, from a
 * browser login, with the app secret never leaving the process.
 *
 * SECRETS NEVER LEAVE THE SERVER, AND NEVER ENTER A URL
 * `api_secret` is used only to compute the checksum inside this process. It is never a
 * query parameter, never logged, never returned. The `access_token` this module returns
 * is handed straight to the caller for encryption-at-rest; it is not cached here.
 *
 * TOKEN EXPIRY IS A DAY BOUNDARY, NOT AN INSTANT
 * Kite access tokens die at the end of the trading day rather than at a stated
 * timestamp, so this module reports `loginTimeMs` and leaves expiry to the caller's
 * IST day-key comparison. It deliberately does NOT invent an `expiresAt`: a guessed
 * instant would either retire a live token early or keep a dead one.
 *
 * EVERY OUTBOUND HOST IS INJECTABLE
 * `zerodhaAuthEndpointsFromEnv()` reads the roots from the environment and
 * `exchangeZerodhaRequestToken` takes a `fetchImpl`, so the CI egress guard (which
 * permits loopback only) can exercise the real code against a local mock.
 */

import { createHash } from "node:crypto";

/** The Kite login/exchange hosts. Configurable so tests can point at loopback. */
export interface ZerodhaAuthEndpoints {
  /** The browser consent URL, without query parameters. */
  loginUrl: string;
  /** The REST root the request-token exchange is POSTed to. */
  apiRoot: string;
}

export const ZERODHA_DEFAULT_LOGIN_URL = "https://kite.zerodha.com/connect/login";
export const ZERODHA_DEFAULT_API_ROOT = "https://api.kite.trade";

/**
 * A Zerodha auth failure.
 *
 * Deliberately NOT `KiteError` from src/kite.ts: that class belongs to the data/order
 * client, and importing it here would couple the login path to the whole REST client.
 * `code` is a stable machine-readable discriminator the route layer maps to a redirect
 * reason — never a credential and never broker prose.
 */
export class ZerodhaAuthError extends Error {
  /** HTTP status, or 0 when the request never produced a response. */
  readonly status: number;
  /** Stable machine code: CONFIG | NETWORK | TIMEOUT | REDIRECT | REJECTED | MALFORMED. */
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "ZerodhaAuthError";
    this.status = status;
    this.code = code;
  }
}

/** The Kite app credentials, read from the environment. */
export interface ZerodhaAppCredentials {
  /** Public. Appears in the login URL and in the Authorization header. */
  apiKey: string;
  /** SECRET. Only ever used to compute the checksum inside this process. */
  apiSecret: string;
  /**
   * The redirect URL registered on the Kite app.
   *
   * INFORMATIONAL ONLY — Kite ignores any redirect URL we send and always uses the one
   * registered on the app. It is read so the readiness check can tell an operator their
   * app is misconfigured, and so the login-start response can show where the browser
   * will land. It is never transmitted.
   */
  redirectUrl: string;
}

/**
 * Read and VALIDATE the Kite app credentials.
 *
 * Returns a reason string instead of throwing when incomplete, exactly like
 * `readDhanCredentials`, so the health endpoint can report "Zerodha is not configured"
 * as a normal state — a Dhan-only or paper deployment must boot perfectly happily.
 */
export function readZerodhaCredentials():
  | { ok: true; creds: ZerodhaAppCredentials }
  | { ok: false; reason: string } {
  const apiKey = process.env.KITE_API_KEY?.trim() ?? "";
  const apiSecret = process.env.KITE_API_SECRET?.trim() ?? "";
  const redirectUrl = process.env.KITE_REDIRECT_URL?.trim() ?? "";

  const missing: string[] = [];
  if (!apiKey) missing.push("KITE_API_KEY");
  if (!apiSecret) missing.push("KITE_API_SECRET");
  if (missing.length > 0) {
    return { ok: false, reason: `Zerodha is not configured: ${missing.join(", ")} missing.` };
  }
  return { ok: true, creds: { apiKey, apiSecret, redirectUrl } };
}

/** Resolve the login/exchange roots, env first, with the documented defaults. */
export function zerodhaAuthEndpointsFromEnv(
  overrides: Partial<ZerodhaAuthEndpoints> = {},
): ZerodhaAuthEndpoints {
  const loginUrl = process.env.KITE_LOGIN_URL?.trim() || ZERODHA_DEFAULT_LOGIN_URL;
  const apiRoot = process.env.KITE_API_ROOT?.trim() || ZERODHA_DEFAULT_API_ROOT;
  return {
    loginUrl,
    // A trailing slash would produce "//session/token", which Kite 404s.
    apiRoot: apiRoot.replace(/\/+$/, ""),
    ...overrides,
  };
}

/**
 * The Kite login checksum: `sha256(api_key + request_token + api_secret)`, hex.
 *
 * Exported so a test can assert the exact digest against a known triple without
 * reaching the network — this one line is the whole security proof of the exchange,
 * and a silent change to it would look like a broker-side rejection.
 */
export function zerodhaChecksum(apiKey: string, requestToken: string, apiSecret: string): string {
  return createHash("sha256").update(`${apiKey}${requestToken}${apiSecret}`).digest("hex");
}

/**
 * Build the browser consent URL.
 *
 * `state` is echoed back to us through Kite's `redirect_params`, which Kite appends
 * verbatim to the registered redirect URL. It is the CSRF defence for the callback: the
 * session cookie is SameSite=Strict and therefore absent on a cross-site redirect, so
 * the nonce is the only thing that proves this callback belongs to a login an
 * authenticated operator actually started.
 */
export function buildZerodhaLoginUrl(
  creds: ZerodhaAppCredentials,
  opts: { state?: string; endpoints?: ZerodhaAuthEndpoints } = {},
): string {
  const endpoints = opts.endpoints ?? zerodhaAuthEndpointsFromEnv();
  const url = new URL(endpoints.loginUrl);
  url.searchParams.set("v", "3");
  url.searchParams.set("api_key", creds.apiKey);
  if (opts.state) {
    // Kite appends `redirect_params` to the REGISTERED redirect URL as-is, so the value
    // is itself a query string. URLSearchParams encodes the whole thing for us.
    url.searchParams.set("redirect_params", `state=${opts.state}`);
  }
  return url.toString();
}

/** What the request-token exchange returns. NEVER cached in this module. */
export interface ZerodhaLoginSession {
  /** The bearer credential. Handed to the caller for encryption at rest. */
  accessToken: string;
  /** The Zerodha client id, e.g. "AB1234". */
  userId: string;
  userName: string;
  email: string;
  /** The api key the token is bound to — echoed back so the caller can pin it. */
  apiKey: string;
  /** Kite's stated login instant in epoch ms, or null when it sent none. */
  loginTimeMs: number | null;
}

/** Injected so tests can supply a mock without touching the network. */
export type FetchLike = typeof fetch;

export interface ZerodhaExchangeOptions {
  endpoints?: ZerodhaAuthEndpoints;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Set false ONLY in tests, to allow http://127.0.0.1. */
  requireHttps?: boolean;
}

/** Cap the response body so a hostile/broken endpoint cannot exhaust memory. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * STEP 3 — exchange the redirect's `request_token` for an access token.
 *
 * SECURITY POSTURE (mirrors src/tokens/tokenProviderClient.ts deliberately)
 *   - https is required unless a test explicitly opts out.
 *   - `redirect: "manual"`; ANY 3xx is refused rather than followed, so the checksum
 *     and request token cannot be replayed to another host.
 *   - a single AbortController bounds headers AND body.
 *   - the body is length-capped before it is parsed.
 *   - no branch of this function puts the api secret, the checksum or the access token
 *     into a message, a log or an error.
 */
export async function exchangeZerodhaRequestToken(
  creds: ZerodhaAppCredentials,
  requestToken: string,
  opts: ZerodhaExchangeOptions = {},
): Promise<ZerodhaLoginSession> {
  const endpoints = opts.endpoints ?? zerodhaAuthEndpointsFromEnv();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const requireHttps = opts.requireHttps ?? true;

  if (!requestToken.trim()) {
    throw new ZerodhaAuthError("Zerodha did not supply a request token.", 400, "MALFORMED");
  }

  let target: URL;
  try {
    target = new URL(`${endpoints.apiRoot}/session/token`);
  } catch {
    throw new ZerodhaAuthError("KITE_API_ROOT is not a valid URL.", 0, "CONFIG");
  }
  if (requireHttps && target.protocol !== "https:") {
    throw new ZerodhaAuthError("KITE_API_ROOT must be https.", 0, "CONFIG");
  }

  // Form-encoded, per Kite Connect v3. The checksum is computed here and the secret
  // itself is never part of the request.
  const body = new URLSearchParams({
    api_key: creds.apiKey,
    request_token: requestToken,
    checksum: zerodhaChecksum(creds.apiKey, requestToken, creds.apiSecret),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(target.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Kite-Version": "3",
      },
      body: body.toString(),
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    throw new ZerodhaAuthError(
      timedOut
        ? `The Zerodha session exchange timed out after ${timeoutMs}ms.`
        : "The Zerodha session exchange could not reach the broker.",
      0,
      timedOut ? "TIMEOUT" : "NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }

  // `redirect: "manual"` surfaces a 3xx as a status (or as an opaque status 0 in some
  // runtimes). Either way it is refused: following it would replay the request token.
  if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
    throw new ZerodhaAuthError(
      "The Zerodha session exchange was redirected; refusing to follow it.",
      res.status,
      "REDIRECT",
    );
  }

  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ZerodhaAuthError(
      "The Zerodha session response was too large to be a session payload.",
      res.status,
      "MALFORMED",
    );
  }

  const text = (await res.text().catch(() => "")).slice(0, MAX_BODY_BYTES);
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  const envelope = (parsed ?? {}) as {
    status?: unknown;
    message?: unknown;
    error_type?: unknown;
    data?: Record<string, unknown>;
  };

  if (!res.ok || envelope.status !== "success" || !envelope.data) {
    // Kite's own message is safe to surface (it names the failure, e.g. an invalid or
    // already-used request token) and never echoes the secret or the checksum.
    const message =
      typeof envelope.message === "string" && envelope.message
        ? envelope.message
        : `The Zerodha session exchange failed (HTTP ${res.status}).`;
    throw new ZerodhaAuthError(message, res.status || 502, "REJECTED");
  }

  const data = envelope.data;
  const accessToken = typeof data.access_token === "string" ? data.access_token.trim() : "";
  if (!accessToken) {
    throw new ZerodhaAuthError(
      "Zerodha returned a session without an access token.",
      res.status,
      "MALFORMED",
    );
  }

  return {
    accessToken,
    userId: typeof data.user_id === "string" ? data.user_id : "",
    userName: typeof data.user_name === "string" ? data.user_name : "",
    email: typeof data.email === "string" ? data.email : "",
    apiKey: typeof data.api_key === "string" && data.api_key ? data.api_key : creds.apiKey,
    loginTimeMs: parseZerodhaLoginTime(data.login_time),
  };
}

/**
 * Parse Kite's `login_time`, which is "YYYY-MM-DD HH:MM:SS" in IST (no zone marker).
 *
 * Read naively by `Date.parse` that string is interpreted as UTC/local depending on the
 * runtime, which would put the login instant up to 5h30m away from the truth. The IST
 * offset is therefore applied explicitly, matching src/tokens/istClock.ts's fixed +5:30
 * arithmetic. Anything unparseable is null — UNKNOWN, never a guess.
 */
export function parseZerodhaLoginTime(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    // The stamp is IST wall-clock; subtract the fixed +05:30 offset to get the instant.
    return utc - 5.5 * 60 * 60 * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
