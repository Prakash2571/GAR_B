/**
 * DhanHQ v2 browser-login (consent) flow, and the session it produces.
 *
 * THE FLOW (three steps, two of them server-side)
 *   1. POST  {authRoot}{generatePath}?client_id=…      (id + secret headers)
 *        → a consent id
 *   2. The BROWSER visits {consentLoginUrl}?{idParam}=…
 *        → Dhan authenticates the user (password + 2FA) and redirects to the
 *          redirect URL REGISTERED ON THE DHAN APP with ?tokenId=…
 *   3. GET   {authRoot}{consumePath}?tokenId=…         (id + secret headers)
 *        → dhanClientId, dhanClientName, dhanClientUcc, givenPowerOfAttorney,
 *          accessToken, expiryTime
 *
 * WHY THE ENDPOINTS ARE CONFIGURABLE RATHER THAN HARDCODED
 * Dhan has shipped this flow under two naming schemes — an "app" variant
 * (`/app/generate-consent`, `/app/consumeApp-consent`, `app_id`/`app_secret`,
 * `consentAppId`) and a "partner" variant (`/partner/…`, `partner_id`/`partner_secret`,
 * `consentId`) — and which one a given set of credentials speaks depends on how the app
 * was registered. Hardcoding one would silently 404 for half of all deployments and look
 * like a credential problem. Every path, query-parameter name and header name is
 * therefore read from the environment, defaulting to the "app" variant this codebase has
 * always documented. An operator on the partner flow changes .env, not code — see
 * docs/BROKER_TOKENS.md.
 *
 * SECRETS NEVER LEAVE THE SERVER
 * The secret is only ever a request HEADER from this process. It is never a query
 * parameter, never logged, never returned to the browser. The access token is held by
 * the caller and sealed into PostgreSQL; the only session shape the API may publish is
 * `redactedSession()`.
 *
 * THE AUTH HOST IS DELIBERATELY NOT ROUTED THROUGH `DhanHttp`
 * That class injects an `access-token` header and paces itself against the DATA API's
 * limits, whereas these two calls authenticate with the app id/secret pair and happen
 * twice per session. Keeping them separate means the credential headers exist in exactly
 * one place and cannot leak onto a data request.
 *
 * TOKEN EXPIRY IS REAL AND MUST NOT BE GUESSED
 * Dhan states an explicit `expiryTime`. It is honoured directly rather than inferred
 * from a login date the way the Zerodha session is (Kite tokens die at the IST day
 * boundary; Dhan's do not necessarily). When `expiryTime` is absent the expiry is
 * UNKNOWN — treated as "validate by using it", never as "never expires".
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

/* -------------------------------------------------------------------------- */
/*  Endpoint configuration                                                    */
/* -------------------------------------------------------------------------- */

/** Every host, path, parameter and header name the consent flow depends on. */
export interface DhanAuthEndpoints {
  /** Origin (+ optional base path) of the auth host. No trailing slash. */
  authRoot: string;
  /** Path of the consent-generation POST, relative to `authRoot`. */
  generatePath: string;
  /** Path of the consent-consumption GET, relative to `authRoot`. */
  consumePath: string;
  /** Absolute URL the BROWSER is sent to for the interactive login. */
  consentLoginUrl: string;
  /** Query-parameter name carrying the consent id on `consentLoginUrl`. */
  consentIdParam: string;
  /** Request header carrying the app/partner id. */
  idHeader: string;
  /** Request header carrying the app/partner SECRET. */
  secretHeader: string;
}

export const DHAN_DEFAULT_AUTH_ROOT = "https://auth.dhan.co";

/**
 * Resolve the consent endpoints, environment first, defaulting to the "app" variant.
 *
 * `overrides` wins over the environment so a test can point every hop at a loopback
 * mock — the CI egress guard permits nothing else.
 */
export function dhanAuthEndpointsFromEnv(
  overrides: Partial<DhanAuthEndpoints> = {},
): DhanAuthEndpoints {
  const authRoot = (process.env.DHAN_AUTH_ROOT?.trim() || DHAN_DEFAULT_AUTH_ROOT).replace(
    /\/+$/,
    "",
  );
  const consentLoginUrl =
    process.env.DHAN_CONSENT_LOGIN_URL?.trim() || `${authRoot}/login/consentApp-login`;
  return {
    authRoot,
    generatePath: process.env.DHAN_CONSENT_GENERATE_PATH?.trim() || "/app/generate-consent",
    consumePath: process.env.DHAN_CONSENT_CONSUME_PATH?.trim() || "/app/consumeApp-consent",
    consentLoginUrl,
    consentIdParam: process.env.DHAN_CONSENT_ID_PARAM?.trim() || "consentAppId",
    idHeader: process.env.DHAN_AUTH_ID_HEADER?.trim() || "app_id",
    secretHeader: process.env.DHAN_AUTH_SECRET_HEADER?.trim() || "app_secret",
    ...overrides,
  };
}

/** Injected so tests can supply a mock without touching the network. */
export type FetchLike = typeof fetch;

/** Shared options for both consent calls. */
export interface DhanConsentOptions {
  endpoints?: DhanAuthEndpoints;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Set false ONLY in tests, to allow http://127.0.0.1. */
  requireHttps?: boolean;
}

/** Cap the response body so a hostile/broken endpoint cannot exhaust memory. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Bounded `fetch` against the AUTH host.
 *
 * SECURITY POSTURE (mirrors src/tokens/tokenProviderClient.ts deliberately)
 *   - https is required unless a test explicitly opts out.
 *   - `redirect: "manual"`; ANY 3xx is refused rather than followed, so the secret
 *     header can never be replayed to another host.
 *   - a single AbortController bounds headers AND body.
 *   - the body is length-capped before it is parsed.
 *   - the secret appears in exactly one place: the request header built here.
 */
async function authFetch<T>(
  url: string,
  creds: DhanAppCredentials,
  method: "GET" | "POST",
  endpoints: DhanAuthEndpoints,
  opts: DhanConsentOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const requireHttps = opts.requireHttps ?? true;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new DhanError(`The Dhan auth URL is not valid: ${url}`, 0, "CONFIG", null);
  }
  if (requireHttps && target.protocol !== "https:") {
    throw new DhanError("DHAN_AUTH_ROOT must be https.", 0, "CONFIG", null);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(target.toString(), {
      method,
      headers: {
        Accept: "application/json",
        [endpoints.idHeader]: creds.apiKey,
        [endpoints.secretHeader]: creds.apiSecret,
      },
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    throw new DhanError(
      timedOut
        ? `Dhan authentication request timed out after ${timeoutMs}ms.`
        : `Dhan authentication request failed: ${err instanceof Error ? err.message : String(err)}`,
      0,
      timedOut ? "TIMEOUT" : "NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }

  // `redirect: "manual"` surfaces a 3xx as a status (or as an opaque status 0 in some
  // runtimes). Either way it is refused: following it would carry the secret header to
  // whatever host the Location named.
  if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
    throw new DhanError(
      "The Dhan authentication request was redirected; refusing to follow it.",
      res.status,
      "REDIRECT",
      null,
    );
  }

  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new DhanError(
      "The Dhan authentication response was too large to be a consent payload.",
      res.status,
      "MALFORMED",
      null,
    );
  }

  const text = (await res.text().catch(() => "")).slice(0, MAX_BODY_BYTES);
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
 * Read the consent id out of a generate-consent response.
 *
 * Both spellings are accepted because the two Dhan variants disagree
 * (`consentAppId` vs `consentId`), and a deployment discovering that mismatch as
 * "Dhan returned no consent id" would have no way to tell it apart from a real failure.
 */
function readConsentId(body: Record<string, unknown>): string {
  for (const key of ["consentAppId", "consentId", "consent_id", "consentID"]) {
    const v = body[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

/**
 * STEP 1 — create a consent and build the browser login URL.
 *
 * Returns BOTH the consent id and the URL the operator's browser must visit. The id is
 * not a credential (it is single-use, short-lived and useless without the user
 * completing 2FA), which is why it may be handed to the frontend.
 */
export async function generateDhanConsent(
  creds: DhanAppCredentials,
  opts: DhanConsentOptions = {},
): Promise<{ consentAppId: string; loginUrl: string }> {
  const endpoints = opts.endpoints ?? dhanAuthEndpointsFromEnv();
  const url = new URL(`${endpoints.authRoot}${endpoints.generatePath}`);
  url.searchParams.set("client_id", creds.clientId);

  const body = await authFetch<Record<string, unknown>>(
    url.toString(),
    creds,
    "POST",
    endpoints,
    opts,
  );

  const consentAppId = readConsentId(body ?? {});
  if (!consentAppId) {
    throw new DhanError(
      "Dhan did not return a consent id. If this deployment uses the partner flow, set " +
        "DHAN_CONSENT_GENERATE_PATH, DHAN_CONSENT_CONSUME_PATH, DHAN_CONSENT_ID_PARAM, " +
        "DHAN_AUTH_ID_HEADER and DHAN_AUTH_SECRET_HEADER (see docs/BROKER_TOKENS.md).",
      502,
      "MALFORMED",
      null,
    );
  }

  const loginUrl = new URL(endpoints.consentLoginUrl);
  loginUrl.searchParams.set(endpoints.consentIdParam, consentAppId);
  return { consentAppId, loginUrl: loginUrl.toString() };
}

/**
 * STEP 3 — exchange the redirect's `tokenId` for a session.
 *
 * The returned access token is NOT stored here: the caller seals it into PostgreSQL and
 * installs it in the running manager, so decryption and persistence stay in one place.
 */
export async function consumeDhanConsent(
  creds: DhanAppCredentials,
  tokenId: string,
  opts: DhanConsentOptions = {},
): Promise<DhanConsentSession> {
  const endpoints = opts.endpoints ?? dhanAuthEndpointsFromEnv();
  if (!tokenId.trim()) {
    throw new DhanError("Dhan did not supply a consent tokenId.", 400, "MALFORMED", null);
  }

  const url = new URL(`${endpoints.authRoot}${endpoints.consumePath}`);
  url.searchParams.set("tokenId", tokenId.trim());

  const body =
    (await authFetch<Record<string, unknown>>(url.toString(), creds, "GET", endpoints, opts)) ?? {};

  const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  if (!accessToken) {
    throw new DhanError(
      "Dhan returned a consent session without an access token.",
      502,
      "MALFORMED",
      null,
    );
  }

  return {
    // Fall back to the CONFIGURED client id rather than "": the token is bound to this
    // app's client, and an empty identity would be sealed as the row's AAD and make the
    // session undecryptable against the real one.
    dhanClientId: str(body.dhanClientId) || creds.clientId,
    dhanClientName: str(body.dhanClientName),
    dhanClientUcc: str(body.dhanClientUcc),
    givenPowerOfAttorney: body.givenPowerOfAttorney === true,
    accessToken,
    expiryTime: parseExpiry(body.expiryTime),
  };
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
