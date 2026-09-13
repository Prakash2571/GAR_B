/**
 * tokenProviderClient — the ONLY outbound HTTP that fetches a broker access token
 * from CalSpread. GTS Box never performs its own broker OAuth: it asks the
 * CalSpread token route for the token CalSpread already holds, validates it hard,
 * and hands it to the session store to encrypt.
 *
 * SECURITY POSTURE
 *  - The passcode goes in the `x-token-passcode` HEADER, never the query string
 *    (query strings leak into access logs, proxies and Referer headers).
 *  - A redirect to a different host is refused: the passcode must only ever reach
 *    the configured provider host.
 *  - HTTPS is required outside tests. Tests point at a 127.0.0.1 mock over http.
 *  - The request is bounded by a timeout and the response body by a byte limit, so
 *    a hostile or broken provider cannot hang or exhaust memory.
 *
 * WHAT IS NEVER LOGGED
 * Neither passcode, neither raw access token, no Authorization header, no
 * ciphertext/IV/tag, and never a full provider response body. Errors carry a
 * short, redacted reason only.
 *
 * THE RESULT IS A CLASSIFICATION, NOT A SIDE EFFECT
 * This client does not store anything. It returns a discriminated result the
 * acquisition service interprets: `ready` (validated token to store), `retry`
 * (409 / network / 5xx — poll again), `configuration_error` (401/403 — stop
 * hammering), `blocker` (503 — bounded backoff), or `security_error` (identity
 * mismatch / malformed body — never install).
 */

import { istDayKey } from "./istClock.js";

/** Body byte cap. A token response is a few hundred bytes; 64 KiB is generous. */
const MAX_BODY_BYTES = 64 * 1024;

export type BrokerKind = "zerodha" | "dhan";

/** A validated Zerodha token ready to encrypt and store. */
export interface ZerodhaTokenResult {
  broker: "zerodha";
  accessToken: string;
  apiKey: string;
  loginDate: string;
}

/** A validated Dhan token ready to encrypt and store. */
export interface DhanTokenResult {
  broker: "dhan";
  accessToken: string;
  clientId: string;
  loginDate: string;
  /** Explicit expiry epoch ms, or null for "unknown — validate operationally". */
  expiresAtMs: number | null;
}

export type TokenPayload = ZerodhaTokenResult | DhanTokenResult;

/**
 * The disposition of one fetch attempt.
 *  - ready:               a validated token to store.
 *  - retry:               transient (409 / network / 5xx) — poll again next tick.
 *  - configuration_error: 401/403 — passcode/config wrong; STOP polling this broker.
 *  - blocker:             503 — provider route not configured; bounded backoff.
 *  - security_error:      identity mismatch / malformed body — never install.
 */
export type TokenFetchResult =
  | { kind: "ready"; payload: TokenPayload }
  | { kind: "retry"; reason: string }
  | { kind: "configuration_error"; reason: string }
  | { kind: "blocker"; reason: string }
  | { kind: "security_error"; reason: string };

export interface TokenProviderConfig {
  url: string;
  passcode: string;
  /** For Zerodha: KITE_API_KEY_EXPECTED. For Dhan: DHAN_CLIENT_ID_EXPECTED. Optional. */
  expectedIdentity?: string;
  requestTimeoutMs: number;
  /** Set false only in tests to allow http://127.0.0.1. */
  requireHttps?: boolean;
}

/** Injected so tests can supply a mock without touching the network. */
export type FetchLike = typeof fetch;

/**
 * Fetch and validate a token from the provider. `atMs` is the current instant from
 * the IST clock, so "today" is decided by the same arithmetic everywhere and tests
 * can freeze it.
 */
export async function fetchBrokerToken(
  broker: BrokerKind,
  cfg: TokenProviderConfig,
  atMs: number,
  fetchImpl: FetchLike = fetch,
): Promise<TokenFetchResult> {
  const requireHttps = cfg.requireHttps ?? true;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(cfg.url);
  } catch {
    return { kind: "configuration_error", reason: "token provider URL is not a valid URL" };
  }
  if (requireHttps && parsedUrl.protocol !== "https:") {
    return { kind: "configuration_error", reason: "token provider URL must be https" };
  }
  if (!cfg.passcode) {
    return { kind: "configuration_error", reason: "token provider passcode is not set" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(parsedUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        // The passcode NEVER goes in the query string. Only this header.
        "x-token-passcode": cfg.passcode,
      },
      signal: controller.signal,
      // Refuse to follow a redirect: a 3xx to another host would carry the passcode
      // header off the configured host. `manual` surfaces the 3xx as a status we
      // treat as a security error below.
      redirect: "manual",
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return {
      kind: "retry",
      reason: timedOut ? "provider request timed out" : "provider network error",
    };
  } finally {
    clearTimeout(timer);
  }

  // Redirect handling: any 3xx is refused. `redirect: manual` yields an opaque
  // response with status 0 in some runtimes, or the 3xx status in others.
  if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
    const location = res.headers.get("location") ?? "";
    let sameHost = false;
    if (location) {
      try {
        sameHost = new URL(location, parsedUrl).host === parsedUrl.host;
      } catch {
        sameHost = false;
      }
    }
    return {
      kind: "security_error",
      reason: sameHost ? "provider issued a same-host redirect (refused)" : "provider redirected to another host (refused)",
    };
  }

  // Status classification BEFORE reading the body where the status alone decides.
  if (res.status === 409) {
    return { kind: "retry", reason: "no valid upstream broker session yet (409)" };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      kind: "configuration_error",
      reason: `token provider rejected the passcode (HTTP ${res.status})`,
    };
  }
  if (res.status === 503) {
    return { kind: "blocker", reason: "token provider route not configured (503)" };
  }
  if (res.status >= 500) {
    return { kind: "retry", reason: `token provider server error (HTTP ${res.status})` };
  }
  if (res.status !== 200) {
    return { kind: "retry", reason: `unexpected provider status (HTTP ${res.status})` };
  }

  // Bounded body read.
  const bodyText = await readBoundedBody(res);
  if (bodyText === null) {
    return { kind: "security_error", reason: "provider response exceeded the size limit" };
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { kind: "security_error", reason: "provider returned malformed JSON" };
  }

  return broker === "zerodha"
    ? validateZerodha(body, cfg, atMs)
    : validateDhan(body, cfg, atMs);
}

/** Read the body but refuse anything over the cap. */
async function readBoundedBody(res: Response): Promise<string | null> {
  const declared = res.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) return null;
  const text = await res.text().catch(() => "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return null;
  return text;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Zerodha success: { authenticated: true, api_key, access_token, login_date }.
 * login_date MUST equal the current IST day; api_key MUST equal
 * KITE_API_KEY_EXPECTED when configured.
 */
function validateZerodha(body: unknown, cfg: TokenProviderConfig, atMs: number): TokenFetchResult {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.authenticated !== true) {
    return { kind: "retry", reason: "provider reports not-yet-authenticated" };
  }
  const apiKey = asString(b.api_key);
  const accessToken = asString(b.access_token);
  const loginDate = asString(b.login_date);
  if (!apiKey) return { kind: "security_error", reason: "provider omitted api_key" };
  if (!accessToken) return { kind: "security_error", reason: "provider omitted access_token" };
  if (!loginDate) return { kind: "security_error", reason: "provider omitted login_date" };

  const today = istDayKey(atMs);
  if (loginDate !== today) {
    // Zerodha tokens are day-scoped; a token minted on another IST day is not
    // today's token. Treated as "not ready yet", so polling continues.
    return { kind: "retry", reason: "zerodha login_date is not the current IST day" };
  }
  if (cfg.expectedIdentity && apiKey !== cfg.expectedIdentity) {
    return { kind: "security_error", reason: "zerodha api_key does not match KITE_API_KEY_EXPECTED" };
  }
  return {
    kind: "ready",
    payload: { broker: "zerodha", accessToken, apiKey, loginDate },
  };
}

/**
 * Dhan success: { authenticated: true, client_id, access_token, expires_at, login_date }.
 * expires_at must be a FUTURE epoch-ms or null (null = unknown, validated
 * operationally). A PAST expires_at is rejected. login_date must be a valid IST
 * date but need NOT be today when an explicit future expiry is present.
 */
function validateDhan(body: unknown, cfg: TokenProviderConfig, atMs: number): TokenFetchResult {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.authenticated !== true) {
    return { kind: "retry", reason: "provider reports not-yet-authenticated" };
  }
  const clientId = asString(b.client_id);
  const accessToken = asString(b.access_token);
  const loginDate = asString(b.login_date);
  if (!clientId) return { kind: "security_error", reason: "provider omitted client_id" };
  if (!accessToken) return { kind: "security_error", reason: "provider omitted access_token" };
  if (!isValidIstDateString(loginDate)) {
    return { kind: "security_error", reason: "dhan login_date is not a valid date" };
  }
  if (cfg.expectedIdentity && clientId !== cfg.expectedIdentity) {
    return { kind: "security_error", reason: "dhan client_id does not match DHAN_CLIENT_ID_EXPECTED" };
  }

  // expires_at: null | future epoch ms. Anything else (past, non-number) is rejected.
  let expiresAtMs: number | null;
  const rawExpiry = b.expires_at;
  if (rawExpiry === null || rawExpiry === undefined) {
    expiresAtMs = null; // UNKNOWN — validate operationally, never "permanently valid".
  } else if (typeof rawExpiry === "number" && Number.isFinite(rawExpiry)) {
    if (rawExpiry <= atMs) {
      return { kind: "security_error", reason: "dhan token expires_at is in the past" };
    }
    expiresAtMs = rawExpiry;
  } else {
    return { kind: "security_error", reason: "dhan expires_at is neither a number nor null" };
  }

  return {
    kind: "ready",
    payload: { broker: "dhan", accessToken, clientId, loginDate, expiresAtMs },
  };
}

/** A `YYYY-MM-DD` that also parses to a real calendar date. */
export function isValidIstDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m! < 1 || m! > 12 || d! < 1 || d! > 31) return false;
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}
