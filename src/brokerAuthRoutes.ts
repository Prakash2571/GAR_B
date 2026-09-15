/**
 * IN-APP BROKER LOGIN, mounted under /api/broker.
 *
 *   POST /api/broker/:broker/login/start   begin a browser login; returns the consent URL.
 *   GET  /api/broker/:broker/callback      the broker's redirect lands here.
 *   POST /api/broker/:broker/logout        drop ONE broker's session.
 *
 * WHAT THIS REPLACES
 * Previously both access tokens were pulled from an EXTERNAL provider over HTTP and both
 * in-app OAuth paths were throwing stubs, so starting a trading day meant standing up a
 * second service. These routes move the whole exchange in-process: the operator clicks
 * "Connect", authenticates at the broker, and the token is minted, sealed and installed
 * here. The app secret never leaves this process and never appears in a URL.
 *
 * THE TWO SESSIONS ARE INDEPENDENT, BY CONSTRUCTION
 * Every route is scoped to ONE broker taken from the path. There is no route that touches
 * both, no shared mutable login state (the pending-login store is keyed by broker), and
 * the manager's completion paths only ever touch a feed when that broker is the ACTIVE
 * one. So logging into Zerodha while Dhan is live establishes a standby Zerodha session
 * and disturbs nothing, and vice versa. Choosing which one TRADES stays where it already
 * was: the blocker-guarded POST /api/broker/select.
 *
 * WHY THE CALLBACK IS NOT BEHIND `requireOperator`
 * The session cookie is `SameSite=Strict`, so a redirect arriving from kite.zerodha.com or
 * auth.dhan.co carries NO cookie — `requireOperator` would 401 every genuine login, and
 * loosening the cookie to `Lax` would weaken the session everywhere to buy nothing. The
 * callback is instead authenticated by the pending-login store: a login must have been
 * started moments earlier by a request that DID carry a valid operator session, the entry
 * is single-use, and Zerodha's nonce is additionally matched in constant time. See
 * src/brokerAuth/pendingLogins.ts for the full argument, including why Dhan's proof is
 * necessarily weaker (it round-trips nothing of ours).
 *
 * WHY A GET PERFORMS A STATE CHANGE
 * OAuth redirects are GETs; there is no choice. Two things compensate. First, the
 * single-use pending-login entry means an unsolicited or replayed callback does nothing.
 * Second, the callback refuses while the process is not `ready` — otherwise a login
 * completing mid-boot could be silently overwritten by `restore()` adopting the stored
 * session a moment later, leaving the operator "signed in" to a session the manager had
 * already discarded.
 *
 * NO SECRETS CROSS THIS BOUNDARY
 * `login/start` returns only a consent URL (public api key / single-use consent id) and an
 * expiry. The callback returns no body at all — it redirects. `logout` returns a boolean.
 * No route here emits a raw or encrypted token, a checksum, an app secret, a request
 * token or any encryption metadata. Failure reasons are STABLE CODES, never broker prose,
 * so nothing a broker says can be reflected into the frontend URL.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { getOperatorRole, sendApiError } from "./access/middleware.js";
import { parseBrokerId, type BrokerId } from "./brokerRoutes.js";
import type { PendingLoginRejection, PendingLoginStore } from "./brokerAuth/pendingLogins.js";

/**
 * Why a login attempt ended without a session. Every value is a fixed identifier from
 * THIS file — never a broker-supplied string — because it is reflected into the redirect
 * URL the browser follows.
 */
export type LoginFailureReason =
  | PendingLoginRejection
  | "not_ready"
  | "not_configured"
  | "broker_denied"
  | "missing_credential"
  | "exchange_failed";

/** The narrow login surface src/index.ts supplies, backed by the ActiveBrokerManager. */
export interface BrokerLoginProvider {
  /** Build the Zerodha consent URL around a single-use nonce. Throws when unconfigured. */
  beginZerodhaLogin(state: string): { loginUrl: string };
  /** Exchange a Zerodha `request_token`; installs and persists the session. */
  completeZerodhaLogin(requestToken: string): Promise<unknown>;
  /** Create a Dhan consent and return the browser URL. Throws when unconfigured. */
  beginDhanLogin(): Promise<{ consentAppId: string; loginUrl: string }>;
  /** Exchange a Dhan `tokenId`; installs and persists the session. */
  completeDhanLogin(tokenId: string): Promise<unknown>;
  logoutZerodha(): Promise<void>;
  logoutDhan(): Promise<void>;
  /** Whether the broker's app credentials are present. Never returns a secret. */
  credentialsFor(broker: BrokerId): { ok: true } | { ok: false; reason: string };
}

export interface BrokerAuthRouteDeps {
  requireOperator: RequestHandler;
  login: BrokerLoginProvider;
  pending: PendingLoginStore;
  /**
   * Where the browser is sent once the round-trip finishes. The EXACT configured
   * frontend origin (`config.frontendUrl`) — never anything derived from the request, so
   * this cannot become an open redirect.
   */
  frontendUrl: string;
  /**
   * Whether the process has finished booting. The callback refuses when false; see the
   * "WHY A GET PERFORMS A STATE CHANGE" note above.
   */
  mutationsAllowed: () => boolean;
  /** Optional hook so index.ts can push a fresh SSE snapshot after a session changes. */
  onSessionChanged?: (broker: BrokerId) => void;
}

/**
 * Build the URL the browser is redirected to after a login round-trip.
 *
 * Pure and exported so the redirect contract is unit-testable: the frontend reads
 * `broker_login` and `status` off the workspace URL to render its notice, and a silent
 * change to either name would leave the operator with no feedback at all.
 */
export function loginResultRedirect(
  frontendUrl: string,
  broker: BrokerId,
  outcome: { ok: true } | { ok: false; reason: LoginFailureReason },
): string {
  // `/box` is an EXISTING frontend route, chosen deliberately so the SPA router needs no
  // new path and no new server rewrite rule.
  const url = new URL("/box", frontendUrl.endsWith("/") ? frontendUrl : `${frontendUrl}/`);
  url.searchParams.set("broker_login", broker);
  url.searchParams.set("status", outcome.ok ? "connected" : "failed");
  if (!outcome.ok) url.searchParams.set("reason", outcome.reason);
  return url.toString();
}

/** Read the first value of a query parameter, or "" — never an array or an object. */
function queryString(req: Request, name: string): string {
  const raw = (req.query as Record<string, unknown>)[name];
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0].trim();
  return "";
}

/**
 * Did the BROKER itself report a failure (user cancelled, consent denied)?
 *
 * Checked before the missing-credential branch so "you clicked cancel" is not reported as
 * "the broker sent us nothing", which would look like an integration bug.
 */
function brokerReportedDenial(req: Request): boolean {
  const status = queryString(req, "status").toLowerCase();
  if (status === "error" || status === "failed" || status === "cancelled") return true;
  return queryString(req, "error") !== "" || queryString(req, "errorMessage") !== "";
}

export function registerBrokerAuthRoutes(app: Express, deps: BrokerAuthRouteDeps): void {
  const { requireOperator, login, pending } = deps;

  const fail = (res: Response, broker: BrokerId, reason: LoginFailureReason): void => {
    // 303 See Other: the browser must follow with a GET regardless of how it arrived.
    res.redirect(303, loginResultRedirect(deps.frontendUrl, broker, { ok: false, reason }));
  };

  /**
   * Begin a browser login for ONE broker.
   *
   * Requires a live operator session (this is the request that PROVES an operator
   * initiated the round-trip, which is what the callback later relies on). Starting a
   * login for one broker supersedes only that broker's previous attempt.
   */
  app.post("/api/broker/:broker/login/start", requireOperator, async (req: Request, res: Response) => {
    const broker = parseBrokerId(req.params.broker);
    if (!broker) {
      sendApiError(res, 400, "bad_broker", 'broker must be "zerodha" or "dhan".');
      return;
    }

    const configured = login.credentialsFor(broker);
    if (!configured.ok) {
      // 409, not 500: an unconfigured broker is a deployment state the operator can fix,
      // and the reason names the missing variables (never a value).
      sendApiError(res, 409, "broker_not_configured", configured.reason);
      return;
    }

    const startedBy = getOperatorRole(req) ?? "operator";
    try {
      if (broker === "zerodha") {
        // Mint the nonce FIRST: Kite round-trips it through `redirect_params`, so it has
        // to be inside the URL we hand back.
        const entry = pending.start("zerodha", { startedBy });
        const { loginUrl } = login.beginZerodhaLogin(entry.nonce);
        res.status(200).json({
          broker,
          login_url: loginUrl,
          expires_at: new Date(entry.expiresAtMs).toISOString(),
        });
        return;
      }

      // Dhan issues the consent id itself, so the consent call comes first and its id is
      // recorded alongside the pending entry for the audit line.
      const consent = await login.beginDhanLogin();
      const entry = pending.start("dhan", { startedBy, consentId: consent.consentAppId });
      res.status(200).json({
        broker,
        login_url: consent.loginUrl,
        expires_at: new Date(entry.expiresAtMs).toISOString(),
      });
    } catch (err) {
      // A failed start must not leave a claimable entry behind: the callback would then
      // accept a round-trip this deployment never actually initiated.
      pending.clear(broker);
      // eslint-disable-next-line no-console
      console.warn(`[BrokerLogin] ${broker} login start failed:`, err instanceof Error ? err.message : err);
      sendApiError(
        res,
        502,
        "broker_login_unavailable",
        `Could not start the ${broker} login. The broker's authentication service did not respond as expected.`,
      );
    }
  });

  /**
   * The broker's redirect target. NOT behind `requireOperator` — see the file header.
   *
   * Every exit is a redirect to the frontend, never a JSON body: the browser is a
   * top-level navigation here, so an API error shape would render as raw text.
   */
  app.get("/api/broker/:broker/callback", async (req: Request, res: Response) => {
    const broker = parseBrokerId(req.params.broker);
    if (!broker) {
      // Nothing to correlate and no broker to name; send the operator back to the
      // workspace rather than leaving a bare error page.
      res.redirect(303, loginResultRedirect(deps.frontendUrl, "zerodha", {
        ok: false,
        reason: "no_pending_login",
      }));
      return;
    }

    // Refuse before consuming the pending entry: a login that cannot be safely completed
    // must remain claimable once the process is ready, not be burned by a mid-boot hit.
    if (!deps.mutationsAllowed()) {
      fail(res, broker, "not_ready");
      return;
    }

    // ZERODHA round-trips our nonce as `state`; DHAN round-trips nothing of ours. The
    // requirement is decided HERE by broker, never by whether a `state` happened to be
    // present — otherwise omitting it would silently downgrade the check.
    const requireNonce = broker === "zerodha";
    const claimed = pending.consume(broker, queryString(req, "state") || null, { requireNonce });
    if (!claimed.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[BrokerLogin] ${broker} callback refused: ${claimed.reason}`);
      fail(res, broker, claimed.reason);
      return;
    }

    if (brokerReportedDenial(req)) {
      fail(res, broker, "broker_denied");
      return;
    }

    const credential = broker === "zerodha" ? queryString(req, "request_token") : queryString(req, "tokenId");
    if (!credential) {
      fail(res, broker, "missing_credential");
      return;
    }

    try {
      if (broker === "zerodha") await login.completeZerodhaLogin(credential);
      else await login.completeDhanLogin(credential);
    } catch (err) {
      // The manager has already recorded an operator-facing reason on this broker's slot,
      // which the status endpoint surfaces. The redirect carries only a stable code — a
      // broker's own message must never be reflected into a URL.
      // eslint-disable-next-line no-console
      console.warn(
        `[BrokerLogin] ${broker} token exchange failed:`,
        err instanceof Error ? err.message : err,
      );
      fail(res, broker, "exchange_failed");
      return;
    }

    deps.onSessionChanged?.(broker);
    // eslint-disable-next-line no-console
    console.log(`[BrokerLogin] ${broker} session established by ${claimed.pending.startedBy}.`);
    res.redirect(303, loginResultRedirect(deps.frontendUrl, broker, { ok: true }));
  });

  /**
   * Sign out of ONE broker.
   *
   * Scoped to the named broker only. Signing out of the STANDBY broker leaves the active
   * broker's session, feed, subscriptions and books completely untouched; signing out of
   * the ACTIVE broker stops its feed and invalidates its books (fail closed) but still
   * does not touch the other broker's stored session.
   */
  app.post("/api/broker/:broker/logout", requireOperator, async (req: Request, res: Response) => {
    const broker = parseBrokerId(req.params.broker);
    if (!broker) {
      sendApiError(res, 400, "bad_broker", 'broker must be "zerodha" or "dhan".');
      return;
    }
    try {
      // Drop any in-flight login for this broker too: after an explicit sign-out, a
      // callback from the abandoned round-trip must not silently sign the operator in.
      pending.clear(broker);
      if (broker === "zerodha") await login.logoutZerodha();
      else await login.logoutDhan();
      deps.onSessionChanged?.(broker);
      res.status(200).json({ ok: true, broker });
    } catch {
      sendApiError(res, 503, "broker_logout_unavailable", `Could not sign out of ${broker}.`);
    }
  });
}
