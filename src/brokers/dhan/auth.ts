/**
 * DhanHQ v2 API-key browser-login flow, and the session it produces.
 *
 * THE FLOW (three steps, two of them server-side)
 *   1. POST auth.dhan.co/app/generate-consent?client_id=…   (app_id + app_secret)
 *        → consentAppId
 *   2. The BROWSER visits auth.dhan.co/login/consentApp-login?consentAppId=…
 *        → Dhan authenticates the user (password + 2FA) and redirects to our
 *          configured redirect URL with ?tokenId=…
 *   3. GET auth.dhan.co/app/consumeApp-consent?tokenId=…    (app_id + app_secret)
 *        → dhanClientId, dhanClientName, dhanClientUcc, givenPowerOfAttorney,
 *          accessToken, expiryTime
 *
 * SECRETS NEVER LEAVE THE SERVER
 * `app_secret` is only ever a request header from this process, and the access
 * token is held here and in Mongo — never returned to the browser, never in
 * localStorage. The frontend only ever sees the login URL and, afterwards, a
 * boolean-ish status. `redactedSession()` is what the API is allowed to publish.
 *
 * TOKEN EXPIRY IS REAL AND MUST NOT BE GUESSED
 * Dhan states an explicit `expiryTime`. It is honoured directly rather than
 * inferred from a login date the way the Zerodha session is (Kite tokens die at
 * the IST day boundary; Dhan's do not necessarily). When `expiryTime` is absent the
 * expiry is UNKNOWN — which is treated as "validate by using it", never as "never
 * expires".
 */

import { DhanAuthError, DhanError } from "./errors.js";

/** What Dhan returns from consume-consent. */
export interface DhanConsentSession {
  dhanClientId: string;
  dhanClientName: string;
  dhanClientUcc: string;
  givenPowerOfAttorney: boolean;
  accessToken: string;
  /** Epoch ms, or null when Dhan did not state one. */
  expiryTime: number | null;
}

/** The Dhan app credentials, read from the environment. */
export interface DhanAppCredentials {
  clientId: string;
  apiKey: string;
  apiSecret: string;
  redirectUrl: string;
  postbackUrl: string;
}

/**
 * Read and VALIDATE the Dhan app credentials.
 *
 * Returns a reason string instead of throwing when incomplete, so the health
 * endpoint can report "Dhan is not configured" as a normal state — a deployment
 * that only uses Zerodha must boot perfectly happily.
 */
export function readDhanCredentials():
  | { ok: true; creds: DhanAppCredentials }
  | { ok: false; reason: string } {
  const clientId = process.env.DHAN_CLIENT_ID?.trim() ?? "";
  const apiKey = process.env.DHAN_API_KEY?.trim() ?? "";
  const apiSecret = process.env.DHAN_API_SECRET?.trim() ?? "";
  const redirectUrl = process.env.DHAN_REDIRECT_URL?.trim() ?? "";
  const postbackUrl = process.env.DHAN_POSTBACK_URL?.trim() ?? "";

  const missing: string[] = [];
  if (!clientId) missing.push("DHAN_CLIENT_ID");
  if (!apiKey) missing.push("DHAN_API_KEY");
  if (!apiSecret) missing.push("DHAN_API_SECRET");
  if (missing.length > 0) {
    return { ok: false, reason: `Dhan is not configured: ${missing.join(", ")} missing.` };
  }
  return { ok: true, creds: { clientId, apiKey, apiSecret, redirectUrl, postbackUrl } };
}

/**
 * Bounded `fetch` against the AUTH host.
 *
 * The auth host is deliberately NOT routed through `DhanHttp`: that class injects
 * an `access-token` header and paces itself against the data API's limits, whereas
 * these two calls authenticate with `app_id`/`app_secret` and happen twice per
 * session. Keeping them separate means the credential headers exist in exactly one
 * place and cannot leak onto a data request.
 */
async function authFetch<T>(
  url: string,
  creds: DhanAppCredentials,
  method: "GET" | "POST",
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        app_id: creds.apiKey,
        app_secret: creds.apiSecret,
      },
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    throw new DhanError(
      timedOut
        ? `Dhan authentication request timed out after ${timeoutMs}ms.`
        : `Dhan authentication request failed: ${err instanceof Error ? err.message : String(err)}`,
      0,
      "NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text.slice(0, 500) };
    }
  }
  if (!res.ok) {
    const record = (parsed ?? {}) as Record<string, unknown>;
    const message =
      (typeof record.errorMessage === "string" && record.errorMessage) ||
      (typeof record.message === "string" && record.message) ||
      `Dhan authentication failed (HTTP ${res.status}).`;
    if (res.status === 401 || res.status === 403) {
      throw new DhanAuthError(message, res.status, null, parsed);
    }
    throw new DhanError(message, res.status, null, parsed);
  }
  return parsed as T;
}

/**
 * STEP 1 — DISABLED IN STRIKEEDGE.
 *
 * This backend never performs its own Dhan consent flow. The Dhan access token is
 * fetched from the external CalSpread provider (`src/tokens/tokenProviderClient.ts`),
 * validated, encrypted and stored locally. This function is retained only so the
 * ported `ActiveBrokerManager` compiles against the same surface; calling it is a
 * configuration error, because it would begin a browser OAuth GTS Algo Research must not
 * own.
 */
export async function generateDhanConsent(
  _creds: DhanAppCredentials,
  _timeoutMs = 10_000,
): Promise<{ consentAppId: string; loginUrl: string }> {
  throw new DhanError(
    "Dhan consent login is disabled in this backend: the access token is provisioned by the external CalSpread token provider, not by a Dhan consent flow.",
    400,
    "CONSENT_DISABLED",
    null,
  );
}

/**
 * STEP 3 — DISABLED IN STRIKEEDGE.
 *
 * See {@link generateDhanConsent}. There is no redirect `tokenId` to consume
 * because this backend never initiates the browser login. Retained for the ported
 * manager's type surface only.
 */
export async function consumeDhanConsent(
  _creds: DhanAppCredentials,
  _tokenId: string,
  _timeoutMs = 10_000,
): Promise<DhanConsentSession> {
  throw new DhanError(
    "Dhan consent login is disabled in this backend: the access token is provisioned by the external CalSpread token provider, not by a Dhan consent flow.",
    400,
    "CONSENT_DISABLED",
    null,
  );
}

/**
 * Parse Dhan's `expiryTime`, which may be epoch ms, epoch seconds or an ISO string.
 *
 * Returns null for anything unparseable. Null means UNKNOWN, and the caller must
 * treat unknown as "keep using it until a 401 proves otherwise" — never as expired
 * (which would drop a working session) and never as immortal (which would keep a
 * dead one).
 */
export function parseExpiry(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch seconds are ~1e9-1e10; ms are ~1e12. Disambiguate by magnitude.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e11 ? Math.round(numeric * 1000) : Math.round(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** True when a stated expiry is in the past. Unknown expiry is NOT expired. */
export function isDhanTokenExpired(expiryTime: number | null, now = Date.now()): boolean {
  if (expiryTime === null) return false;
  return expiryTime <= now;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The ONLY session shape that may be sent to a browser.
 *
 * No access token, no app secret. Everything here is either an account identifier
 * the user already knows or a timestamp.
 */
export function redactedSession(session: {
  dhan_client_id: string;
  dhan_client_name: string;
  dhan_client_ucc: string;
  given_power_of_attorney: boolean;
  expiry_time: number | null;
  login_date: string;
  login_at?: Date | null;
}): {
  client_id: string;
  client_name: string;
  client_ucc: string;
  power_of_attorney: boolean;
  token_expires_at: number | null;
  token_expired: boolean;
  login_date: string;
  login_at: string | null;
} {
  return {
    client_id: session.dhan_client_id,
    client_name: session.dhan_client_name,
    client_ucc: session.dhan_client_ucc,
    power_of_attorney: session.given_power_of_attorney,
    token_expires_at: session.expiry_time,
    token_expired: isDhanTokenExpired(session.expiry_time),
    login_date: session.login_date,
    login_at: session.login_at ? session.login_at.toISOString() : null,
  };
}
