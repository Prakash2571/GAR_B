/**
 * GTS Algo Research backend entrypoint.
 *
 * This file replaces the predecessor codebase's 5,584-line `src/index.ts`. Everything that was not
 * the Box strategy — calendar spreads, futures analytics, option-OI capture, the
 * hourly/EOD schedulers, Yahoo dividends, the F&O board pages, the browser-wide
 * market-data SSE, the Zerodha OAuth login and the admin-token layer — is gone.
 * What remains is: configuration, PostgreSQL, the access gate, the Box module, the
 * dual-broker runtime, the token acquisition service and the Mongo projector,
 * assembled in a documented order.
 *
 * TWO ORDERINGS ARE LOAD-BEARING AND ARE THE REASON THIS FILE READS TOP-TO-BOTTOM.
 *
 * BOOT
 *   1. parse and validate configuration
 *   2. start PostgreSQL and run/check migrations
 *   3. load access-session infrastructure
 *   4. load Box settings/session state
 *   5. reconstruct open positions, intents, attempts and residual exposure
 *   6. start the Mongo outbox projector INDEPENDENTLY (never a boot dependency)
 *   7. start the daily token broker
 *   8. once a valid token exists, load instruments
 *   9. start the dedicated Box market-data feed
 *  10. reconcile unresolved live broker state
 *  11. start the always-on position monitor
 *  12. keep new scanner discovery STOPPED until explicitly started
 *  13. never auto-arm live entry
 *
 * SHUTDOWN
 *   1. block new Box entry            5. stop market-data subscriptions/socket
 *   2. stop scanner discovery         6. stop monitoring/timers WITHOUT flattening
 *   3. stop mutating HTTP             7. flush bounded Mongo outbox work
 *   4. stop token polling             8. close HTTP/SSE  9. close Mongo  10. close PG
 *
 * SIGTERM IS NOT AN INSTRUCTION TO LIQUIDATE. Open positions stay open and the
 * durable recovery path adopts them on restart. See `src/shutdown.ts`.
 */

import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";

import { loadAppConfig, boolOr, ConfigError } from "./config.js";
import { closePg, initPg, isPgReady, pgConfigFromEnv, pgStatus, query } from "./pg/pool.js";
import { assertMigrated, listMigrationFiles, runMigrations } from "./pg/migrate.js";

import { KiteClient } from "./kite.js";
import { TickerHub } from "./hub.js";
import { ActiveBrokerManager } from "./brokers/registry.js";
import type { BrokerId } from "./brokers/types.js";
import { LocalChargeCalculator } from "./box/localCharges.js";
import { registerBoxModule, type BoxModule } from "./box/index.js";
// SECTION 7: the shape of the readiness evidence this module injects into the ONE decision.
import type { ReadinessBlocker } from "./box/operationalReadiness.js";
import { countUnresolvedBoxOrderIntentsForBroker } from "./box/repository.js";
import {
  deriveFnoBoard,
  istDayKey,
  isMarketOpen,
  makeIdResolver,
  makePriceChargeGroups,
} from "./boxSupport.js";

import { createRequireOperator, corsMiddleware, errorHandler, getOperatorRole, startSessionSweeper } from "./access/middleware.js";
import { registerAccessRoutes } from "./access/routes.js";
import { createVerifyRateLimit } from "./access/rateLimit.js";
import type { AccessSessionConfig } from "./access/sessionStore.js";

import { registerRuntimeStatusRoutes, type RuntimeStatusSnapshot } from "./runtime/statusRoutes.js";
import { registerBrokerRoutes, type SwitchResult } from "./brokerRoutes.js";
import {
  projectExportStatus,
  projectBrokerSession,
  projectBrokerHealth,
} from "./runtime/projections.js";

import { BrokerTokenAcquisitionService } from "./tokens/brokerTokenService.js";
import { systemClock } from "./tokens/istClock.js";
import type { BrokerProviderConfigs } from "./tokens/brokerTokenService.js";
import {
  clearDhanSession,
  loadDhanSession,
  loadKiteSession,
  saveDhanSession,
  saveKiteSession,
  __internal as brokerSessionInternals,
} from "./brokerState/brokerSessions.js";
import { registerBrokerAuthRoutes } from "./brokerAuthRoutes.js";
import { PendingLoginStore } from "./brokerAuth/pendingLogins.js";
import {
  registerTokenExposureRoutes,
  tokenExposureConfigFromEnv,
  tokenExposureEnabled,
  type TokenLookup,
} from "./tokenExposureRoutes.js";
import { isDhanTokenExpired } from "./brokers/dhan/auth.js";
import { readZerodhaCredentials } from "./brokers/zerodha/auth.js";

import { MongoExportClient, exportConfigFromEnv } from "./outbox/mongo.js";
import { Projector } from "./outbox/projector.js";
import { getExportStatus } from "./outbox/status.js";
import { getPool } from "./pg/pool.js";

import { ShutdownCoordinator, shutdownExitCode } from "./shutdown.js";
import { clearTrackedIntervals } from "./trackedTimers.js";
import { ReadinessController } from "./runtime/readiness.js";

/* ========================================================================== */
/*  1. CONFIGURATION                                                          */
/* ========================================================================== */

let config: ReturnType<typeof loadAppConfig>;
try {
  config = loadAppConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error("[FATAL] GTS Algo Research refuses to start with invalid configuration.");
    for (const p of err.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  throw err;
}

const accessSession: AccessSessionConfig = {
  siteAccessSecret: process.env.SITE_ACCESS_SECRET,
  ttlHours: config.siteSessionTtlHours,
};

if (!accessSession.siteAccessSecret) {
  // Not fatal, deliberately: the gate FAILS CLOSED (every protected route 401s and
  // verify can never succeed), so an operator who forgot the secret gets a process
  // that is safe and diagnosable rather than one that will not boot at all.
  console.error(
    "[Access] SITE_ACCESS_SECRET is not set. The gate is FAIL CLOSED: every /api/box/*, " +
      "/api/broker/*, /api/runtime/status and /api/export/status request will return 401 " +
      "and no passcode will be accepted. An unset secret NEVER means 'no passcode required'.",
  );
}

/**
 * The two independent live-trading DEPLOYMENT gates, read once and reported once.
 *
 * Nothing in this file may arm live trading. Even with both gates true and the active
 * broker's own gate true, the process still starts runtime-DISARMED: the runtime live
 * controls default false on every process start and must be armed through the
 * protected API. Entering the site passcode arms nothing.
 */
const boxExecutionMode = (process.env.BOX_EXECUTION_MODE ?? "paper_latency").trim();
const boxLiveTradingEnabled = boolOr(process.env.BOX_LIVE_TRADING_ENABLED, false);
const zerodhaLiveTradingEnabled = boolOr(process.env.ZERODHA_LIVE_TRADING_ENABLED, false);
const dhanLiveTradingEnabled = boolOr(process.env.DHAN_LIVE_TRADING_ENABLED, false);

if (boxExecutionMode === "live" && !boxLiveTradingEnabled) {
  console.error(
    "[FATAL] BOX_EXECUTION_MODE=live requires BOX_LIVE_TRADING_ENABLED=true. " +
      "Live execution is double-gated at the deployment level and GTS Algo Research fails closed " +
      "rather than degrading silently to paper.",
  );
  process.exit(1);
}

/* ========================================================================== */
/*  BROKER RUNTIME (constructed now, started only after a validated token)     */
/* ========================================================================== */

const kite = new KiteClient({ apiKey: process.env.KITE_API_KEY_EXPECTED ?? "" });

/**
 * Set once the Box module exists. Lets a feed death notify the engine without this
 * line having to know about the module — the engine then drops its cached books
 * instead of trading a frozen order book.
 */
let onFeedSessionLost: (() => void) | null = null;

/**
 * Set once the broker manager exists. Lets the TickerHub's auth-death callback clear the
 * Zerodha session metadata without this line having to be declared after the manager (the
 * hub is a constructor argument to it, so the dependency runs the other way).
 */
let forgetZerodhaSessionOnFeedDeath: (() => void) | null = null;

const tickerHub = new TickerHub(
  () => ({ apiKey: kite.getApiKey(), accessToken: kite.getAccessToken() }),
  () => {
    // Zerodha rejected the token. Clear memory AND the encrypted stored copy so a
    // restart does not restore a dead token, then let the engine invalidate books.
    kite.clearSession();
    // Also forget the session METADATA. Without this the manager keeps projecting an
    // account label and a login day for a session the broker has just rejected, and
    // `inAppTokenState` reports `waiting` ("sign in") instead of `invalid` ("sign in
    // AGAIN") — collapsing the one distinction that vocabulary exists to preserve.
    // Declared after the hub, so it is reached lazily inside this callback.
    forgetZerodhaSessionOnFeedDeath?.();
    void brokerSessionInternals
      .invalidateSession("zerodha", "feed_auth_failure")
      .catch(() => undefined);
    onFeedSessionLost?.();
  },
);

const brokerManager = new ActiveBrokerManager({
  kite,
  tickerHub,
  boxConfig: () => boxModule.engine.getConfigRaw(),
  istDayKey,
  // Read fresh on every connect: a lane reconnecting after a token refresh must use
  // the CURRENT access token, not the one captured when the feed was constructed.
  zerodhaCredentials: () => ({ apiKey: kite.getApiKey(), accessToken: kite.getAccessToken() }),
  // BOX-LANE ticks go straight to the Box quote store, NOT through the hub: the hub
  // owns broadcast caches, and thousands of option strikes do not belong on a
  // browser fan-out path. This backend has no browser market-data SSE at all, but the
  // separation is kept because it is what bounds the Box lane's own token budget.
  onBoxLaneTicks: (ticks) => {
    brokerManager.noteTick();
    boxModule.engine.ingestBoxLaneTicks(ticks);
  },
  onBoxLaneConnection: (connected) => boxModule.engine.onBoxLaneConnection(connected),
  // A market-data session/token rejection on the box lane drives the health machine to
  // AUTH_EXPIRED (no fast-forever reconnect on a known-invalid token), distinct from a drop.
  onBoxLaneSessionLost: (reason) => boxModule.engine.onMarketDataSessionLost(reason),
  // TRANSPORT HEARTBEAT (keep-alive / non-tick frame). Deliberately NOT routed through
  // `noteTick()` or the quote store: it proves a live route to the broker and nothing about any
  // instrument's book, so it must not be able to warm an instrument or refresh a depth timestamp.
  onBoxLaneHeartbeat: () => boxModule.engine.onBoxLaneHeartbeat(),
  // A RECONNECTABLE fault (network blip / TLS / DNS). Recorded for diagnosis and explicitly NOT
  // escalated to a session loss: the feed already scheduled a reconnect, and treating a blip as
  // token death is what used to strand the lane in a terminal AUTH_EXPIRED state.
  onBoxLaneTransportFault: (reason) => boxModule.engine.onBoxLaneTransportFault(reason),
  // Kite order postbacks ride the box lane's quote socket as TEXT frames (no dedicated Zerodha
  // order socket exists). Forward them to the engine's order-stream consumer.
  onBoxLaneOrderText: (raw) => boxModule.engine.ingestBoxLaneOrderText(raw),
  onDhanTicks: (ticks) => {
    brokerManager.noteTick();
    tickerHub.ingestExternalTicks(ticks);
  },
  onDhanConnection: (connected) => tickerHub.setExternalConnected(connected),
  onSessionLost: (broker, reason) => {
    console.warn(`[Broker] ${broker} session lost: ${reason}`);
    onFeedSessionLost?.();
  },
});

/* ========================================================================== */
/*  HTTP APP                                                                  */
/* ========================================================================== */

const app = express();
app.disable("x-powered-by");
/*
 * ONE TRUSTED HOP, and the code no longer depends on this setting anyway.
 *
 * This used to be `true` — "trust every proxy in the chain" — with a comment claiming it made the
 * rate limiter and the session breadcrumb see the real client. It did neither: neither path read
 * `req.ip`, so the setting was inert, and `true` would have made `req.ip` resolve to the LEFTMOST
 * `X-Forwarded-For` entry, which is the value the caller supplies.
 *
 * Client attribution now goes through `trustedClientIp()` (see `src/clientIp.ts`), which consults
 * forwarding headers only when the connection itself arrives from a trusted proxy and then reads the
 * hop nginx appended. This setting is left at a single hop so anything in Express that does use
 * `req.ip` (logging, future middleware) agrees with that model instead of trusting the whole chain.
 */
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));

// EXACT-ORIGIN CORS WITH CREDENTIALS. Never a wildcard — a wildcard with credentials
// is rejected by browsers anyway, and answering `*` while asking for cookies is the
// classic way to end up with an origin check that does nothing.
app.use(corsMiddleware(config));

const requireOperator = createRequireOperator({ config });

/**
 * THE SINGLE READINESS GATE.
 *
 * One process-wide state machine (`src/runtime/readiness.ts`) decides both what
 * `/api/health` reports and whether a mutating request may proceed. It starts in
 * `starting`, becomes `ready` only when `boot()` has fully completed (PostgreSQL up,
 * migrations verified/applied, authoritative broker restored, Box durable state
 * adopted and unresolved order reconciliation finished), and moves to `failed` or
 * `shutting_down` otherwise.
 */
const readiness = new ReadinessController();

/**
 * Refuse EVERY mutating request (POST/PUT/PATCH/DELETE) until the process is fully
 * `ready`, and keep refusing once shutdown has begun.
 *
 * This is the SINGLE consolidated gate that replaces the old `shuttingDown`-only
 * middleware. It is mounted BEFORE the access routes and the Box module (below) so
 * no mutating route — /api/access/verify, /api/access/logout, the scanner controls,
 * broker switching or session arming — can slip past it. A POST arriving while boot
 * is still adopting positions must not be able to start a Box, arm a session or
 * place an order; and a POST arriving during teardown must not either.
 *
 * Reads (GET/HEAD) remain answerable throughout so nginx health checks and status
 * polls keep working while the process starts and drains.
 */
app.use((req: Request, res: Response, next) => {
  const mutating =
    req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
  if (mutating && !readiness.mutationsAllowed()) {
    const state = readiness.getState();
    const message =
      state === "shutting_down"
        ? "GTS Algo Research is shutting down; mutating requests are refused."
        : "GTS Algo Research is not ready; mutating requests are refused until startup completes.";
    res.status(503).json({ error: message });
    return;
  }
  next();
});

/**
 * The ONLY unauthenticated informational endpoint, and deliberately CONTENTLESS
 * beyond liveness/readiness.
 *
 * It answers HTTP 503 with `ready:false` while `starting`, `failed` or
 * `shutting_down`, and HTTP 200 with `ready:true` ONLY when `ready`. This is what
 * makes the readiness signal HONEST: a load balancer or nginx health check now sees
 * "not ready" during the exact window in which migrations, broker restoration, Box
 * durable-state adoption and order reconciliation are still incomplete.
 *
 * A health check that reported broker, token, position, exposure or migration state
 * would be a public readout of the trading system, so the body carries a coarse
 * `state` string and the `service` name and NOTHING else. `shutting_down` is kept as
 * a convenience boolean; it adds no operational detail beyond the `state` already
 * present.
 */
app.get("/api/health", (_req: Request, res: Response) => {
  const state = readiness.getState();
  const ready = readiness.isReady();
  res.status(ready ? 200 : 503).json({
    service: "gts-algo-research",
    state,
    ready,
    shutting_down: state === "shutting_down",
  });
});

registerAccessRoutes(app, {
  config,
  session: accessSession,
  verifyRateLimit: createVerifyRateLimit(),
});

/* ========================================================================== */
/*  BOX MODULE                                                                */
/* ========================================================================== */

const boxModule: BoxModule = registerBoxModule(app, {
  kite,
  tickerHub,
  getAllInstruments: () => brokerManager.instruments(),
  getBoard: async () => deriveFnoBoard(await brokerManager.instruments()),
  priceChargeGroups: makePriceChargeGroups(kite),
  istDayKey,
  makeIdResolver,
  isMarketOpen: () => isMarketOpen(),
  getBasketMargin: (orders) => kite.getBasketMargin(orders),
  requireOperator,
  getOperatorRole,
  // ---- broker-neutral wiring: every one of these routes to the ACTIVE broker ----
  activeBroker: () => brokerManager.activeBroker,
  // Stamped onto every durable instrument reservation and re-checked before
  // execution, so a lease taken under a superseded broker cannot authorise a trade.
  brokerGeneration: () => brokerManager.generation,
  /**
   * SECTION 7 — the NON-SECRET account reference behind the MASKED identity in the readiness
   * decision (and the existing `account_ref` on economic evidence).
   *
   * Without this the decision's `identity.account_masked` published null forever: the masking path
   * existed and was tested, but nothing fed it — which is precisely the "built, tested and never
   * called" failure this section is about. An operator could not tell WHICH account a live verdict
   * was computed for.
   *
   * `sessionFor().client_id` is an account IDENTIFIER, never a token, and it is masked again in
   * `buildOperationalReadiness` before it reaches the wire. Read fresh on every call so a broker
   * switch or re-login is reflected.
   *
   * FOR ZERODHA this resolves to the Kite login's `user_id`, recorded in `zerodhaSessionMeta` (see
   * `ActiveBrokerManager.sessionFor`). An earlier version of this comment claimed Zerodha "does not
   * track a client id here, so it is honestly null" — that is no longer true, and the value is now
   * load-bearing: it is the account stamped on every durable order intent, the account the
   * order-update projection rejects foreign fills against, and a precondition for live entry.
   *
   * It IS still null when a session was adopted by a path that leaves `zerodhaSessionMeta` unset. That
   * is deliberately fail-closed — live entry is then refused with an account-identity reason rather
   * than proceeding unattributed — but it surfaces as "the broker account could not be identified",
   * NOT as a token problem, so do not diagnose it as an authentication fault.
   */
  brokerAccountRef: () => brokerManager.sessionFor(brokerManager.activeBroker).client_id ?? null,
  marketData: brokerManager.marketData(),
  margins: brokerManager.margins(),
  feed: {
    addTickListener: (fn) =>
      tickerHub.addTickListener((ticks) => {
        brokerManager.noteTick();
        fn(ticks);
      }),
    addConnectionListener: (fn) => tickerHub.addConnectionListener(fn),
    retain: () => tickerHub.retain(),
    subscribeTokens: (tokens) => brokerManager.subscribeTokens(tokens),
    unsubscribeTokens: (tokens) => brokerManager.unsubscribeTokens(tokens),
    setStrategyTokens: (tokens) => brokerManager.setStrategyTokens(tokens),
    // The DEDICATED Box lane — ONE socket on the ACTIVE broker, with its own refcount
    // table and token budget. Never two brokers at once.
    setBoxTokens: (tokens) => brokerManager.setBoxTokens(tokens),
    subscribedCount: () => brokerManager.subscribedCount(),
    isConnected: () => brokerManager.feedConnected(),
  },
  // The ACTIVE broker's fee schedule. A Dhan trade costed with Zerodha brokerage
  // would make the expected-net entry gate spend money it does not have.
  charges:
    brokerManager.activeBroker === "dhan"
      ? brokerManager.dhanChargeCalculator()
      : new LocalChargeCalculator(),
  // The engine never builds broker transports itself. The registry assembles the
  // ACTIVE broker's adapter and REFUSES to build one for any other broker.
  createLiveAdapter: (ctx) => brokerManager.createLiveAdapter(ctx),
  // The Dhan DEDICATED order-update socket, constructed by the registry against the CURRENT
  // session token. Returns null unless Dhan is active, so an order feed can never observe a broker
  // the system is not trading. The engine's order-stream consumer supplies the handlers.
  createDhanOrderFeed: (handlers) => brokerManager.createDhanOrderFeed(handlers),
});

onFeedSessionLost = () => boxModule.engine.onSessionLost();
forgetZerodhaSessionOnFeedDeath = () =>
  brokerManager.forgetZerodhaSession("Zerodha rejected the session — sign in to Zerodha again");

/**
 * Give the broker manager its view of live exposure and the teardown hooks a switch
 * needs. Done here rather than in the constructor because the engine must exist
 * first — the manager inspects it, and the engine consumes the manager's providers.
 */
brokerManager.attach(
  {
    scannerRunning: () => boxModule.engine.exposureSummary().scannerRunning,
    openPositionCount: () => boxModule.engine.exposureSummary().openPositions,
    brokersWithOpenPositions: () => boxModule.engine.exposureSummary().brokersWithOpenPositions,
    workingOrderCount: () => boxModule.engine.exposureSummary().workingOrders,
    executionInFlight: () => boxModule.engine.exposureSummary().executionInFlight,
    reconciliationComplete: () => boxModule.engine.exposureSummary().reconciliationComplete,
    residualLegCount: () => boxModule.engine.exposureSummary().residualLegs,
    unknownOrderCount: () => boxModule.engine.exposureSummary().unknownOrders,
    unresolvedIntentsFor: (broker) => countUnresolvedBoxOrderIntentsForBroker(broker),
  },
  {
    stopScanner: () => boxModule.engine.stop(),
    invalidateBooks: () => boxModule.engine.invalidateBooks(),
    clearInstrumentReservations: () => boxModule.engine.clearInstrumentReservations(),
    reloadUniverse: () => boxModule.engine.reloadUniverse(),
    publish: () => boxModule.engine.publishNow(),
    // A REPLACEMENT credential was installed (re-login / token refresh / broker switch). This is
    // the ONLY thing allowed to clear the terminal AUTH_EXPIRED market-data verdict — a tick
    // cannot, because a tick on a socket the broker already rejected proves nothing about the
    // credential. Without it, one expiry stranded the health machine as "session expired" for the
    // life of the process even after a successful sign-in.
    marketDataSessionRestored: (reason) => boxModule.engine.onMarketDataSessionRestored(reason),
  },
);

/* ========================================================================== */
/*  MONGO PROJECTOR (independent of everything else)                          */
/* ========================================================================== */

const mongoExportConfig = exportConfigFromEnv();
const mongoExport = new MongoExportClient(mongoExportConfig);

/**
 * Constructed in `boot()`, not here, because it needs the live `pg.Pool` and the pool
 * does not exist until step 2. Held in a nullable so the shutdown steps can reference
 * it unconditionally — a shutdown that arrives before boot finished must still be able
 * to run every later step rather than throwing on a missing projector.
 */
let projector: Projector | null = null;

/* ========================================================================== */
/*  DAILY DUAL-BROKER TOKEN ACQUISITION                                       */
/* ========================================================================== */

/**
 * WHERE ACCESS TOKENS COME FROM: `in_app` (default) or `provider`.
 *
 * `in_app`   — the operator signs in to each broker FROM THIS DEPLOYMENT
 *              (POST /api/broker/:broker/login/start → broker consent → callback), the
 *              token is minted here, sealed into PostgreSQL and installed. The external
 *              provider poller is NOT started, because there is nothing for it to do and
 *              a poller racing an interactive login is a way to overwrite a session the
 *              operator just established.
 * `provider` — the historical behaviour: poll the external CalSpread token routes from
 *              09:00 IST. Retained so an existing deployment can upgrade without changing
 *              how it gets tokens, and so the two paths never have to run at once.
 *
 * Read ONCE here so a mid-session env edit cannot change token provenance without a
 * restart. An unrecognised value falls back to `in_app` with a warning rather than
 * failing boot: the in-app path needs no external secret, so it is the safe default.
 */
type BrokerLoginMode = "in_app" | "provider";

function brokerLoginModeFromEnv(env: NodeJS.ProcessEnv = process.env): BrokerLoginMode {
  const raw = (env.BROKER_LOGIN_MODE ?? "in_app").trim().toLowerCase();
  if (raw === "in_app" || raw === "") return "in_app";
  if (raw === "provider") return "provider";
  console.warn(
    `[Token] BROKER_LOGIN_MODE="${raw}" is not recognised (expected in_app | provider) — using in_app.`,
  );
  return "in_app";
}

const brokerLoginMode: BrokerLoginMode = brokerLoginModeFromEnv();

/**
 * Single-use, TTL-bounded record of an in-flight browser login, one slot per broker.
 *
 * This is what authenticates the OAuth callback, which cannot present the session cookie
 * (it is SameSite=Strict and the redirect is cross-site). See
 * src/brokerAuth/pendingLogins.ts for the full reasoning.
 */
const pendingBrokerLogins = new PendingLoginStore();

/**
 * Which broker the token service is allowed to bring up.
 *
 * This is the enforcement point for the single-active-broker invariant on the token
 * path: a successful acquisition for the STANDBY broker stores an encrypted token and
 * nothing else — no instruments, no socket, no subscriptions, no scanner.
 */
/**
 * The two token-provider configurations.
 *
 * Built explicitly, side by side, precisely because they must NOT be derived from one
 * another: the operator may legitimately set the same value for both passcodes (the
 * the external CalSpread deployment protects both routes with one `TOKEN_ROUTE_SECRET`), but the
 * application must never assume they are identical nor copy one into the other. A
 * future rotation of one secret then works without silently breaking the other.
 *
 * `requireHttps` is true outside tests, so a plaintext token URL is refused.
 */
const tokenProviderConfigs: BrokerProviderConfigs = {
  zerodha: {
    url: (process.env.KITE_TOKEN_BROKER_URL ?? "https://calspread.online/api/kite/token").trim(),
    passcode: process.env.KITE_TOKEN_BROKER_PASSCODE ?? "",
    ...(process.env.KITE_API_KEY_EXPECTED?.trim()
      ? { expectedIdentity: process.env.KITE_API_KEY_EXPECTED.trim() }
      : {}),
    requestTimeoutMs: Number(process.env.BROKER_TOKEN_REQUEST_TIMEOUT_MS ?? 10_000),
    requireHttps: config.nodeEnv !== "test",
  },
  dhan: {
    url: (process.env.DHAN_TOKEN_URL ?? "https://calspread.online/api/dhan/token").trim(),
    passcode: process.env.DHAN_TOKEN_BROKER_PASSCODE ?? "",
    ...(process.env.DHAN_CLIENT_ID_EXPECTED?.trim()
      ? { expectedIdentity: process.env.DHAN_CLIENT_ID_EXPECTED.trim() }
      : {}),
    requestTimeoutMs: Number(process.env.BROKER_TOKEN_REQUEST_TIMEOUT_MS ?? 10_000),
    requireHttps: config.nodeEnv !== "test",
  },
};

const tokenService = new BrokerTokenAcquisitionService({
  clock: systemClock,
  configs: tokenProviderConfigs,
  pollStart: (process.env.BROKER_TOKEN_POLL_START ?? "09:00").trim(),
  pollIntervalMs: Number(process.env.BROKER_TOKEN_POLL_INTERVAL_MS ?? 60_000),
  persist: {
    saveZerodha: async ({ apiKey, accessToken, loginDate }) => {
      await saveKiteSession({
        access_token: accessToken,
        user_id: "",
        user_name: "",
        login_date: loginDate,
        api_key: apiKey,
        source_url: process.env.KITE_TOKEN_BROKER_URL ?? "",
      });
    },
    saveDhan: async ({ clientId, accessToken, loginDate, expiresAtMs }) => {
      await saveDhanSession({
        access_token: accessToken,
        dhan_client_id: clientId,
        dhan_client_name: "",
        dhan_client_ucc: "",
        given_power_of_attorney: false,
        expiry_time: expiresAtMs,
        login_date: loginDate,
        source_url: process.env.DHAN_TOKEN_URL ?? "",
      });
    },
    /**
     * Is there ALREADY a usable stored token for this IST day?
     *
     * NEITHER READ IS `.catch`-ed. Both used to be `.catch(() => null)`, which reported
     * a PostgreSQL outage or a token-decryption misconfiguration as "no valid token" —
     * so the service would go and fetch a REPLACEMENT credential from the token
     * provider for a broker whose stored credential was in fact fine. The rejection now
     * propagates to the acquisition service, which records the bounded reason in its
     * per-broker status and retries on its existing schedule instead of acquiring.
     *
     * A confirmed-absent row still resolves `false` — that is the normal
     * "no token yet today" answer and it must keep working.
     */
    hasValidToken: async (broker, istDay) => {
      if (broker === "zerodha") {
        const s = await loadKiteSession();
        // Zerodha tokens are day-scoped: yesterday's token is dead by definition.
        return s !== null && s.login_date === istDay;
      }
      const s = await loadDhanSession();
      if (!s) return false;
      // Dhan honours an EXPLICIT expiry. A null expiry is UNKNOWN, not "valid
      // forever": it is accepted here and retired operationally by a 401.
      if (s.expiry_time !== null) return s.expiry_time > Date.now();
      return true;
    },
    invalidate: async (broker, reason) => {
      if (broker === "dhan") await clearDhanSession(reason);
      else await brokerSessionInternals.invalidateSession("zerodha", reason);
    },
  },
  feedProbe: {
    // Scoped to the ACTIVE broker on purpose: the standby broker may hold a valid
    // stored token, and reporting a feed for it would contradict the single-active-
    // broker invariant the status endpoint exists to make visible.
    feedConnected: (broker) => brokerManager.activeBroker === broker && brokerManager.feedConnected(),
    wantedTokenCount: (broker) =>
      brokerManager.activeBroker === broker ? brokerManager.laneStats("box").wantedTokens : 0,
    subscribedTokenCount: (broker) =>
      brokerManager.activeBroker === broker ? brokerManager.laneStats("box").subscribedTokens : 0,
    lastAuthoritativeDepthAgeMs: (broker) =>
      brokerManager.activeBroker === broker ? brokerManager.laneStats("box").lastTickAgeMs : null,
    reconnectCount: (broker) =>
      brokerManager.activeBroker === broker ? brokerManager.laneStats("box").reconnects : 0,
  },
  callbacks: {
    installZerodhaToken: async () => {
      /**
       * ROUTED THROUGH THE MANAGER, NOT STRAIGHT INTO THE KITE CLIENT.
       *
       * This used to be `kite.installProvidedToken(apiKey, accessToken)`. That installed the
       * token but left `ActiveBrokerManager.zerodhaSessionMeta` untouched — and that metadata
       * is now load-bearing, because `sessionFor("zerodha")` derives liveness from the IST
       * login day recorded in it.
       *
       * The failure that caused: a process that boots on day D adopts the stored session and
       * records `loginDay: D`. It stays up overnight. At 09:00 on D+1 the poller fetches a
       * perfectly good token and installs it here — but the metadata still says D, so the
       * day comparison judges the FRESH token stale, `authenticated` goes false, and
       * `startActiveRuntime()` returns at its `!session.authenticated` guard. No universe
       * load, no feed, for the rest of the trading day.
       *
       * `adoptStoredKiteSession()` re-reads the row `persist.saveZerodha` has just written
       * and derives the token AND the metadata from it together, so there is exactly one
       * source of truth. This is precisely what `installDhanToken` below already does, and
       * why it never had this bug.
       */
      const adopted = await brokerManager.adoptStoredKiteSession();
      console.log(
        adopted
          ? "[Token] zerodha session installed into the running broker manager."
          : "[Token] zerodha session persisted but not adoptable (absent, stale or foreign) — Zerodha stays unauthenticated.",
      );
    },
    installDhanToken: async () => {
      /**
       * The durable write in `persist.saveDhan` has already happened; this makes the
       * RUNNING manager see it.
       *
       * This was previously a no-op on the reasoning that "the client reads its session
       * from the store on demand". It does not: `ActiveBrokerManager` only read
       * `broker_sessions` inside `restore()`, which runs once at boot. On a normal
       * morning — process up before 09:00 IST, Dhan token acquired at 09:00 — the token
       * was durable while the manager still held no token, so Dhan reported itself
       * unauthenticated for the rest of the day and could not be selected without a
       * restart.
       *
       * No token is passed in: the manager re-reads and decrypts from PostgreSQL, which
       * keeps the authority in one place and keeps plaintext out of this interface.
       */
      const adopted = await brokerManager.adoptStoredDhanSession();
      console.log(
        adopted
          ? "[Token] dhan session installed into the running broker manager."
          : "[Token] dhan session persisted but not adoptable (absent or expired) — Dhan stays unauthenticated.",
      );
    },
    isActiveBroker: (broker) => brokerManager.activeBroker === broker,
    onActiveBrokerReady: async (broker) => {
      console.log(`[Token] ${broker} token installed — bringing the active broker runtime up.`);
      // Instruments FIRST, then the socket: a status read during startup should say
      // "connecting" rather than "live with an empty board". `startActiveRuntime`
      // performs exactly that sequence and then resubscribes the Box token set.
      await brokerManager.startActiveRuntime();
      // Any book cached before the token existed is not authoritative depth.
      boxModule.engine.invalidateBooks();
      boxModule.engine.publishNow();
    },
    onBrokerAuthFailure: async (broker, reason) => {
      console.warn(`[Token] ${broker} authentication failure (${reason}) — blocking new entry.`);
      if (brokerManager.activeBroker === broker) {
        // Close the socket and drop executable books. Open-position and recovery
        // state is PRESERVED: nothing here liquidates or forgets exposure.
        brokerManager.stopFeeds();
        boxModule.engine.invalidateBooks();
        boxModule.engine.stop();
        boxModule.engine.publishNow();
      }
    },
  },
});

/* ========================================================================== */
/*  PROTECTED STATUS AND BROKER ROUTES                                        */
/* ========================================================================== */

let migrationState = { applied: 0, pending: 0 };

/**
 * SECTION 7 — FEED THE ENGINE THE READINESS EVIDENCE ONLY THIS MODULE CAN SEE.
 *
 * Env gates, PostgreSQL availability, migration state and per-broker token readiness are owned here,
 * not by the engine. Registering them as a blocker SOURCE (rather than computing a second verdict
 * from them, as `getRuntimeStatus` used to) is what collapses three disagreeing readiness answers
 * into one: the engine's decision now scores the transports AND these facts together, and both the
 * dashboard payload and `GET /api/runtime/status` are projections of that single decision.
 *
 * EVERY blocker here is `scope: "entry"`. That is deliberate and load-bearing: none of these facts
 * is a reason to refuse a REDUCTION of exposure already owned. A stopped scanner, an unarmed live
 * gate or an unready token must never strand a live position — reduction has its own requirements,
 * checked separately, and an expired session is the only thing that genuinely refuses it.
 *
 * NO SECRETS: only states, booleans and counts. Never a token, never a passcode.
 */
boxModule.engine.setExternalReadinessBlockers(() => {
  const blockers: ReadinessBlocker[] = [];
  const tokenStatus = tokenService.status();
  const active = brokerManager.activeBroker;

  if (boxExecutionMode !== "live") {
    blockers.push({
      code: `execution_mode_${boxExecutionMode}`,
      scope: "entry",
      detail: `The deployment is running in ${boxExecutionMode} mode, so no live entry is possible.`,
    });
  }
  if (!boxLiveTradingEnabled) {
    blockers.push({
      code: "box_live_trading_disabled",
      scope: "entry",
      detail: "BOX_LIVE_TRADING_ENABLED is not armed for this deployment.",
    });
  }
  if (active === "zerodha" && !zerodhaLiveTradingEnabled) {
    blockers.push({
      code: "zerodha_live_trading_disabled",
      scope: "entry",
      detail: "ZERODHA_LIVE_TRADING_ENABLED is not armed, so Zerodha will take no new entry.",
    });
  }
  if (active === "dhan" && !dhanLiveTradingEnabled) {
    blockers.push({
      code: "dhan_live_trading_disabled",
      scope: "entry",
      detail: "DHAN_LIVE_TRADING_ENABLED is not armed, so Dhan will take no new entry.",
    });
  }
  if (!isPgReady()) {
    blockers.push({
      code: "postgres_unavailable",
      scope: "entry",
      detail:
        "PostgreSQL — the authoritative store — is unavailable, so durable intent cannot be persisted " +
        "before a POST. No entry is attempted without it.",
    });
  }
  if (migrationState.pending > 0) {
    blockers.push({
      code: "migrations_pending",
      scope: "entry",
      detail: `${migrationState.pending} database migration(s) are still pending.`,
    });
  }
  /**
   * IS THE ACTIVE BROKER'S TOKEN READY?
   *
   * The answer MUST come from whichever mechanism actually owns the token, or this blocker
   * becomes permanent. In `in_app` mode the acquisition state machine is never started, so
   * reading its state here would report `waiting` forever and refuse EVERY live entry no
   * matter how recently the operator signed in — a gate that can never be satisfied is not
   * a safety gate, it is an outage. So the session is consulted in that mode, exactly as
   * `GET /api/runtime/status` does, keeping the readiness verdict and the status readout
   * two projections of the same fact rather than two disagreeing answers.
   */
  const activeTokenState =
    brokerLoginMode === "in_app"
      ? inAppTokenState(active)
      : [tokenStatus.zerodha, tokenStatus.dhan].find((t) => t.broker === active)?.state;
  if (activeTokenState !== "ready") {
    blockers.push({
      code: "active_broker_token_not_ready",
      scope: "entry",
      detail:
        `The ${active} session token is ${activeTokenState ?? "unavailable"}. Without a ready token ` +
        `the broker refuses orders, so entry is refused locally rather than optimistically attempted.`,
    });
  }
  return blockers;
});

/**
 * Project one broker's IN-APP session into the same `token_state` vocabulary the external
 * poller uses, so `GET /api/runtime/status` has ONE shape regardless of token provenance
 * and the frontend needs no second code path.
 *
 * The five states keep their established meanings:
 *   configuration_error — the app credentials are missing; polling/clicking cannot fix it.
 *   polling             — a browser login is in flight (the operator is at the broker).
 *   ready               — a usable session exists RIGHT NOW.
 *   invalid             — a session exists but its token is past its expiry / trading day.
 *   waiting             — configured, nothing in flight, nobody signed in yet.
 *
 * Order matters: a configuration error outranks everything (no click will clear it), and
 * an expired session is reported as `invalid` rather than collapsed into `waiting`,
 * because "sign in again" and "sign in" are different instructions.
 */
function inAppTokenState(
  broker: BrokerId,
): "waiting" | "polling" | "ready" | "invalid" | "configuration_error" {
  const creds =
    broker === "zerodha" ? brokerManager.zerodhaCredentials() : brokerManager.dhanCredentials();
  if (!creds.ok) return "configuration_error";

  const session = brokerManager.sessionFor(broker);
  if (session.authenticated && !session.token_expired) return "ready";
  if (session.token_expired) return "invalid";
  if (pendingBrokerLogins.isPending(broker)) return "polling";
  return "waiting";
}

registerRuntimeStatusRoutes(app, {
  requireOperator,
  runtime: {
    getRuntimeStatus: async (): Promise<RuntimeStatusSnapshot> => {
      const exposure = boxModule.engine.exposureSummary();
      const tokenStatus = tokenService.status();
      const tokens = [tokenStatus.zerodha, tokenStatus.dhan];
      /**
       * SECTION 7 — `live_entry` IS NOW A PROJECTION OF THE ONE READINESS DECISION.
       *
       * It used to be computed HERE from env gates, PostgreSQL, token state and reconciliation —
       * facts that did not include EITHER transport lifecycle. So this endpoint could report entry
       * unblocked while the engine refused every entry because the market-data feed was DEGRADED or
       * the order stream had not reconciled. Two answers to one question.
       *
       * The env/DB/token facts this module owns are now injected INTO the engine's decision (see
       * `setExternalReadinessBlockers` below), and the verdict is read back out of it. One decision,
       * two projections, no possible disagreement.
       */
      const readiness = boxModule.engine.operationalReadiness();
      return {
        brokers: tokens.map((t) => ({
          broker: t.broker,
          /**
           * IN `in_app` MODE THE POLLER IS NOT RUNNING, SO ITS STATE WOULD BE A LIE.
           *
           * `tokenService.status()` reports the ACQUISITION state machine. With
           * BROKER_LOGIN_MODE=in_app that machine never starts, so every broker would sit
           * at `waiting` forever and the workspace would show "waiting for today's token"
           * next to a perfectly good session the operator signed into minutes ago —
           * telling them to wait for something that is never coming.
           *
           * So in that mode the token state is derived from the SESSION itself, which is
           * the actual source of truth for "can this broker be used right now". In
           * `provider` mode the poller IS the truth and is reported unchanged.
           */
          token_state: brokerLoginMode === "in_app" ? inAppTokenState(t.broker) : t.state,
          ist_day: brokerLoginMode === "in_app" ? istDayKey() : t.istDay,
          last_attempt_at: t.lastAttemptAt === null ? null : new Date(t.lastAttemptAt).toISOString(),
          last_success_at: t.lastSuccessAt === null ? null : new Date(t.lastSuccessAt).toISOString(),
          // In in_app mode the actionable error is the LOGIN failure, not a fetch failure.
          last_error: brokerLoginMode === "in_app" ? brokerManager.loginError(t.broker) : t.lastError,
          feed_connected: t.feedConnected,
          wanted_token_count: t.wantedTokenCount,
          subscribed_token_count: t.subscribedTokenCount,
          last_depth_age_ms: t.lastAuthoritativeDepthAgeMs,
          reconnect_count: t.reconnectCount,
        })),
        active_broker: brokerManager.activeBroker,
        pg_ready: isPgReady(),
        migration_state: migrationState,
        recovery_ready: exposure.reconciliationComplete,
        // The SAME verdict the dashboard renders. `reasons` keeps its established shape (a list of
        // stable snake_case codes) so no existing consumer breaks; the human sentences live in the
        // decision's own `entry.reasons`.
        live_entry: {
          blocked: !readiness.entry.permitted,
          reasons: readiness.entry.reasons.map((r) => r.code),
        },
        recovery_pending: exposure.unknownOrders > 0,
        residual_exposure: exposure.residualLegs > 0,
      };
    },
  },
  exportStatus: {
    /**
     * Re-projected from the outbox snapshot rather than passed through, because the
     * two modules deliberately do not share a type: `src/outbox/status.ts` names its
     * fields in the projector's terms, and the HTTP contract names them in the
     * operator's. The mapping lives in `src/runtime/projections.ts` (projectExportStatus)
     * so the contract test can exercise the SAME projection this endpoint uses,
     * keeping a rename on either side from silently changing the public shape.
     */
    getExportStatus: async () => {
      const s = await getExportStatus(getPool(), mongoExportConfig.enabled);
      return projectExportStatus(s);
    },
  },
});

registerBrokerRoutes(app, {
  requireOperator,
  manager: {
    activeBroker: () => brokerManager.activeBroker,
    generation: () => brokerManager.generation,
    sessionFor: (broker) => projectBrokerSession(broker, brokerManager.sessionFor(broker), brokerManager.activeBroker),
    healthFor: (broker) => projectBrokerHealth(broker, brokerManager.healthFor(broker)),
    switchBlockers: async (broker) => (await brokerManager.switchBlockers(broker)).map((b) => b.reason),
    selectBroker: async (broker, selectedBy): Promise<SwitchResult> => {
      const out = await brokerManager.switchBroker(broker, selectedBy);
      return out.ok
        ? { ok: true, broker, blockers: [] }
        : { ok: false, broker, blockers: out.blockers.map((b) => b.reason) };
    },
  },
  // Every open tab must see a broker change immediately, not on the next poll.
  onBrokerChanged: () => boxModule.engine.publishNow(),
});

/* ========================================================================== */
/*  IN-APP BROKER LOGIN                                                       */
/* ========================================================================== */

/**
 * The login routes are mounted for BOTH brokers unconditionally, and each one only ever
 * touches the broker named in its path. That is what makes "signed in to both, trading on
 * one" real: `completeZerodhaLogin`/`completeDhanLogin` establish and persist a session
 * regardless of which broker is active, and only bring a FEED up when the broker they
 * belong to is the active one.
 */
registerBrokerAuthRoutes(app, {
  requireOperator,
  pending: pendingBrokerLogins,
  frontendUrl: config.frontendUrl,
  // The callback is a GET and therefore bypasses the readiness mutation gate, so it
  // checks readiness itself: a login completing mid-boot could otherwise be discarded by
  // `restore()` adopting the stored session moments later.
  mutationsAllowed: () => readiness.mutationsAllowed(),
  login: {
    beginZerodhaLogin: (state) => brokerManager.beginZerodhaLogin(state),
    completeZerodhaLogin: (requestToken) => brokerManager.completeZerodhaLogin(requestToken),
    beginDhanLogin: () => brokerManager.beginDhanLogin(),
    completeDhanLogin: (tokenId) => brokerManager.completeDhanLogin(tokenId),
    logoutZerodha: () => brokerManager.logoutZerodha(),
    logoutDhan: () => brokerManager.logoutDhan(),
    // Re-projected to a bare ok/reason so no credential value can cross this seam.
    credentialsFor: (broker) => {
      const creds =
        broker === "zerodha" ? brokerManager.zerodhaCredentials() : brokerManager.dhanCredentials();
      return creds.ok ? { ok: true } : { ok: false, reason: creds.reason };
    },
    // Mapped to bare reason codes, exactly as `switchBlockers` is for POST /api/broker/select,
    // so the two refusal surfaces speak the same vocabulary.
    logoutBlockers: async (broker) => (await brokerManager.logoutBlockers(broker)).map((b) => b.reason),
  },
  // A session change alters what the workspace may do, so push a snapshot rather than
  // waiting for the next 5s poll.
  onSessionChanged: () => boxModule.engine.publishNow(),
});

/* ========================================================================== */
/*  TOKEN EXPOSURE FOR SIBLING SERVICES                                       */
/* ========================================================================== */

const tokenExposureConfig = tokenExposureConfigFromEnv();

/**
 * Serve the CURRENTLY USABLE token for one broker, read from the durable store.
 *
 * PostgreSQL is the authority, so this reads (and decrypts) the stored row rather than
 * reporting the manager's in-memory copy — one decryption path, and the answer cannot
 * drift from what a restart would adopt.
 *
 * FRESHNESS IS ENFORCED HERE, not by the route: the route must not own broker policy.
 *   • Zerodha is DAY-SCOPED — a session whose `login_date` is not the current IST day is
 *     dead, and is reported as such rather than handed out.
 *   • Dhan honours an EXPLICIT expiry; a null expiry is UNKNOWN, which is accepted (and
 *     retired operationally by a 401), never treated as expired.
 */
async function currentExposedToken(broker: BrokerId): Promise<TokenLookup> {
  if (broker === "zerodha") {
    const session = await loadKiteSession();
    if (!session) return { ok: false, reason: "no_session" };
    if (session.login_date !== istDayKey()) return { ok: false, reason: "session_stale_day" };
    /**
     * THE IDENTITY MUST BE PRESENT, OR THE TOKEN IS USELESS.
     *
     * Zerodha authenticates with the PAIR `api_key:access_token`, so a caller that receives
     * an empty identity builds `Authorization: token :<token>` and gets a 403. Returning 200
     * with a blank identity would hand out a dead credential while this surface documents
     * that it never does — the worst kind of failure, because the caller has no reason to
     * doubt it.
     *
     * The stored column can be empty (a legacy or imported row, or a persist that ran
     * without one), which is exactly why `adoptStoredKiteSession` carries the same fallback.
     * Fall back to the configured api key; if there is still nothing to pair the token with,
     * report it unavailable rather than serve it.
     */
    const configured = readZerodhaCredentials();
    const identity = session.api_key || (configured.ok ? configured.creds.apiKey : "");
    if (!identity) return { ok: false, reason: "no_identity" };
    return {
      ok: true,
      token: {
        accessToken: session.access_token,
        // The api key is what the token must be paired with in the Authorization header.
        identity,
        loginDate: session.login_date,
        expiresAtMs: null,
      },
    };
  }
  const session = await loadDhanSession();
  if (!session) return { ok: false, reason: "no_session" };
  if (isDhanTokenExpired(session.expiry_time)) return { ok: false, reason: "session_expired" };
  return {
    ok: true,
    token: {
      accessToken: session.access_token,
      identity: session.dhan_client_id,
      loginDate: session.login_date,
      expiresAtMs: session.expiry_time,
    },
  };
}

registerTokenExposureRoutes(app, {
  config: tokenExposureConfig,
  tokens: {
    currentToken: currentExposedToken,
    activeBroker: () => brokerManager.activeBroker,
  },
});

app.use(errorHandler());

/* ========================================================================== */
/*  BOOT                                                                      */
/* ========================================================================== */

/**
 * LISTEN-WITH-503 (spec option 3b), chosen deliberately over "do not listen until
 * boot completes".
 *
 * The socket is bound FIRST so nginx and any load-balancer health check have a
 * reachable endpoint immediately — but `/api/health` answers 503 `ready:false` and
 * every mutating route is refused until `boot()` has fully completed. A closed
 * socket would make the health check fail with a connection error that is
 * indistinguishable from "process crashed", whereas an honest 503 says precisely
 * "up but not ready yet". Readiness only flips to `ready` at the end of `boot()`.
 */
const httpServer = app.listen(config.port, () => {
  console.log(`GTS Algo Research backend listening on http://localhost:${config.port} (readiness: starting)`);
  console.log(
    `[Gates] BOX_EXECUTION_MODE=${boxExecutionMode} BOX_LIVE_TRADING_ENABLED=${boxLiveTradingEnabled} ` +
      `ZERODHA_LIVE_TRADING_ENABLED=${zerodhaLiveTradingEnabled} DHAN_LIVE_TRADING_ENABLED=${dhanLiveTradingEnabled} ` +
      `— runtime live controls always start DISARMED.`,
  );
  void boot()
    .then(() => {
      // Readiness flips to `ready` EXACTLY ONCE, only after every boot step —
      // including order reconciliation to the engine's defined safe boundary —
      // has completed. `markReady()` refuses a second transition, so a stray double
      // call cannot mask a re-boot.
      if (readiness.markReady()) {
        console.log("[Readiness] state -> ready. /api/health now answers 200 and mutations are allowed.");
      } else {
        console.warn(
          `[Readiness] refused ready transition from state '${readiness.getState()}' — staying not-ready.`,
        );
      }
    })
    .catch((err) => {
      // Boot failures are LOUD and FATAL. A process that listens on the port and
      // answers /api/health while having adopted no positions is worse than one that
      // exited, because a supervisor will restart the latter into the recovery path.
      //
      // Mark FAILED first (so readiness can NEVER become ready and mutations stay
      // refused), then run the ordinary shutdown steps to stop/close the partially
      // initialised resources — WITHOUT flattening or inventing any fill — and exit
      // non-zero so PM2 restarts us into a clean attempt.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[FATAL] GTS Algo Research boot failed:", message);
      readiness.markFailed(err);
      void failBootAndExit();
    });
});

/**
 * Tear down after a boot failure using the SAME ShutdownCoordinator steps that a
 * normal shutdown uses, then exit non-zero.
 *
 * Reusing the coordinator is the cleanest route: it already stops the session
 * sweeper, the token service and the feeds, disposes the engine if it booted,
 * closes the HTTP listener, closes Mongo and closes PG — in the safe order and
 * WITHOUT flattening positions or inventing fills. Any step that throws because the
 * resource never initialised is isolated by the coordinator and does not block the
 * later, data-protecting closes.
 */
async function failBootAndExit(): Promise<never> {
  // Move readiness to shutting_down so nothing can observe a ready process during
  // the teardown of a failed boot. From `failed` this is a legal transition.
  readiness.markShuttingDown();
  try {
    await shutdownCoordinator.run("BOOT_FAILURE");
  } catch (teardownErr) {
    console.error(
      "[FATAL] error while tearing down after a failed boot:",
      teardownErr instanceof Error ? teardownErr.message : teardownErr,
    );
  }
  // Always non-zero: the supervisor must restart us into a fresh recovery attempt.
  process.exit(1);
}

async function boot(): Promise<void> {
  /* 2. PostgreSQL, then migrations. Nothing else may run before this. */
  await initPg(pgConfigFromEnv());
  if (config.migrateOnBoot) {
    const result = await runMigrations();
    migrationState = { applied: result.applied.length + result.skipped.length, pending: 0 };
    console.log(
      `[PG] migrations: ${result.applied.length} applied, ${result.skipped.length} already present.`,
    );
  } else {
    await assertMigrated();
    migrationState = { applied: (await listMigrationFiles()).length, pending: 0 };
    console.log("[PG] schema verified (PG_MIGRATE_ON_BOOT=false; no migration applied).");
  }

  /* 3. Access-session infrastructure. */
  const sweeper = startSessionSweeper();
  sessionSweeperStop = sweeper.stop;

  /* Restore the durable active-broker selection BEFORE anything can price a trade.
     Without this a restart would silently revert to Zerodha and stamp new trades
     broker:"zerodha" while the operator believed Dhan was active.

     DELIBERATELY UNGUARDED. This used to be `.catch(err => console.warn(...))`, which
     turned the one authoritative read that decides WHICH VENUE TRADES on into a log
     line: a PostgreSQL outage, a corrupt row or an undecryptable Dhan session all left
     the process running on the DEFAULT broker at generation 1. Letting the rejection
     escape `boot()` is the fix — the caller marks startup FAILED, closes the partially
     initialised resources and exits non-zero so the supervisor restarts us into a
     clean attempt. A confirmed-absent row (fresh deployment) resolves normally, so
     first boots are unaffected. */
  await brokerManager.restore();

  /* 4 + 5 + 10 + 11. Box settings, session state, open positions, unresolved intents,
     execution attempts and residual exposure are all reconstructed by engine.boot(),
     which also reconciles unresolved live broker state and starts the ALWAYS-ON
     position monitor. Discovery of NEW boxes stays off (step 12). */
  await boxModule.boot();

  /* READINESS PRECONDITION: unresolved order reconciliation must have completed to
     the engine's defined safe boundary before the process may report ready. We use
     the engine's EXISTING signal — `exposureSummary().reconciliationComplete`, the
     same field the runtime-status route and the broker manager already consume — and
     do NOT invent a new notion of "reconciled". `engine.boot()` performs the
     reconciliation of unresolved live broker state as part of step 4/5/10 above, so
     by this point the signal must be true; if it is not, boot has not reached its
     safe boundary and marking the process ready would be dishonest. Fail the boot so
     the caller tears down and the supervisor restarts us into a clean attempt. */
  if (!boxModule.engine.exposureSummary().reconciliationComplete) {
    throw new Error(
      "boot incomplete: order reconciliation did not reach the engine's safe boundary " +
        "(exposureSummary().reconciliationComplete is false) — refusing to report ready.",
    );
  }

  /* 6. The projector is started INDEPENDENTLY and is never a boot dependency: a
     MongoDB Atlas outage must not delay position adoption or reconciliation. */
  if (mongoExportConfig.enabled) {
    projector = new Projector(getPool(), mongoExport, {
      batchSize: mongoExportConfig.batchSize,
      intervalMs: mongoExportConfig.intervalMs,
      maxBackoffMs: mongoExportConfig.maxBackoffMs,
      maxAttempts: mongoExportConfig.maxAttempts,
    });
    projector.start();
    console.log(
      `[Mongo] outbox projector started (batch ${mongoExportConfig.batchSize}, every ${mongoExportConfig.intervalMs}ms).`,
    );
  } else {
    console.log("[Mongo] export disabled (MONGO_EXPORT_ENABLED=false or MONGODB_URI unset) — PostgreSQL remains authoritative.");
  }

  /* 7 + 8 + 9. Bring the ACTIVE broker's runtime up.

     TWO MUTUALLY EXCLUSIVE PATHS, AND THEY MUST NOT BOTH RUN.

     `provider` — the external token poller is the ONLY thing that installs a token, loads
     instruments and opens the dedicated Box market-data socket, and it does so only for
     the ACTIVE broker (via its onActiveBrokerReady callback).

     `in_app` — the token comes from an operator sign-in instead, so there is no poller and
     therefore nothing to invoke that callback. `restore()` (step 3) has already rehydrated
     BOTH brokers' stored sessions, so the runtime must be started HERE. Without this the
     process would boot with a perfectly valid stored session and no feed — the exact class
     of bug the Dhan adoption comment above documents, one layer up.

     `startActiveRuntime()` is a no-op when the active broker has no session, so a first
     boot before anyone has signed in stays idle and honest rather than erroring. */
  if (brokerLoginMode === "provider") {
    await tokenService.start();
    console.log("[Token] dual-broker acquisition scheduled (Asia/Kolkata).");
  } else {
    await brokerManager.startActiveRuntime();
    console.log(
      "[Token] BROKER_LOGIN_MODE=in_app — the external token poller is NOT running. " +
        "Sign in to each broker from the workspace (POST /api/broker/:broker/login/start).",
    );
  }

  if (tokenExposureEnabled(tokenExposureConfig)) {
    console.log(
      "[Token] exposure ENABLED: GET /api/tokens/zerodha and /api/tokens/dhan serve the " +
        "current access token to callers presenting x-token-access-key. Ensure TLS and " +
        "network restrictions are in place.",
    );
  } else {
    console.log(
      "[Token] exposure disabled (TOKEN_EXPOSURE_KEY unset or too short) — /api/tokens/* answers 503.",
    );
  }

  /* 12 + 13. Deliberately absent: no engine.start(), no live arming. */
  console.log(
    "[Boot] complete. Scanner discovery is STOPPED and live entry is DISARMED — both require an explicit operator action.",
  );
}

let sessionSweeperStop: (() => void) | null = null;

/* ========================================================================== */
/*  SHUTDOWN                                                                  */
/* ========================================================================== */

const shutdownCoordinator = new ShutdownCoordinator({
  timeoutMs: config.shutdownTimeoutMs,
  steps: [
    {
      // 1 + 2. Block new entry and stop discovery FIRST, before HTTP stops accepting:
      // an in-flight request must not be able to start a new Box on the way out.
      name: "block new Box entry and stop scanner discovery",
      run: () => boxModule.engine.stop(),
    },
    {
      // 3. Reads still answer while the process drains; mutations are refused.
      // Readiness has ALREADY flipped to `shutting_down` (in the signal handler /
      // boot-failure path) BEFORE any resource close, so this is the belt-and-braces
      // confirmation of that state at the point the shutdown order names it. The
      // single readiness gate refuses mutations whenever the state is not `ready`.
      name: "stop accepting mutating HTTP requests",
      run: () => {
        readiness.markShuttingDown();
      },
    },
    {
      // 4.
      name: "stop broker token polling",
      run: () => tokenService.stop(),
    },
    {
      // 5.
      name: "stop market-data subscriptions and sockets",
      run: () => brokerManager.stopFeeds(),
    },
    {
      // 6. Disables entry again (belt and braces), stops the scanner, position
      // monitor, metrics sampler and P&L archiver, and clears every engine timer.
      // Queued order actions that never reached the broker are rejected and their
      // reservations released. NO POSITION IS FLATTENED AND NO FILL IS INVENTED.
      name: "stop monitoring and timers (positions preserved)",
      run: () => {
        boxModule.engine.dispose();
        sessionSweeperStop?.();
        const cleared = clearTrackedIntervals();
        if (cleared.length > 0) console.log(`[shutdown] cleared timers: ${cleared.join(", ")}`);
      },
    },
    {
      // 7. BOUNDED flush. One final drain pass, not "until empty": an unbounded
      // flush against a slow Atlas cluster would hold the deadline open, and the
      // backlog is durable in PostgreSQL either way.
      name: "flush bounded Mongo outbox work",
      run: async () => {
        const p = projector;
        if (!mongoExportConfig.enabled || !p) return;
        p.stop();
        const result = await p.runOnce();
        console.log(
          `[shutdown] outbox flush: claimed ${result.claimed}, published ${result.published}, ` +
            `failed ${result.failed} (remaining work is durable in PostgreSQL).`,
        );
      },
    },
    {
      /**
       * 8. Stop listening, release idle keep-alives, give real in-flight requests a
       * short grace, then destroy the stragglers.
       *
       * `server.close()` does not resolve until every connection ends, and SSE
       * connections never end on their own. Awaiting it naively would make EVERY
       * shutdown hang to the deadline — the false alarm that teaches operators to
       * ignore exit codes. Dropping an SSE socket is correct: the client reconnects
       * to the replacement process, which is what a redeploy looks like.
       */
      name: "close HTTP and SSE",
      run: () =>
        new Promise<void>((resolve) => {
          const HTTP_DRAIN_GRACE_MS = 3_000;
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(graceTimer);
            resolve();
          };
          httpServer.close(done);
          httpServer.closeIdleConnections?.();
          const graceTimer = setTimeout(() => {
            httpServer.closeAllConnections?.();
            done();
          }, HTTP_DRAIN_GRACE_MS);
        }),
    },
    {
      // 9.
      name: "close MongoDB",
      run: () => mongoExport.close(),
    },
    {
      // 10. LAST: every step above may still have written on its way out.
      name: "close PostgreSQL",
      run: () => closePg(),
    },
  ],
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // REQUIREMENT: readiness must flip to non-ready BEFORE any resource is closed.
    // We do it here, before the coordinator's first step runs, so /api/health starts
    // answering 503 and mutations are refused the instant a shutdown signal arrives —
    // not part-way through teardown. From `ready` (or `failed`) this is legal; a
    // second signal is a harmless no-op.
    readiness.markShuttingDown();
    void shutdownCoordinator.run(signal).then((result) => {
      // The coordinator never calls process.exit itself, so it stays unit-testable.
      process.exit(shutdownExitCode(result));
    });
  });
}

/* ========================================================================== */
/*  LAST-RESORT PROCESS SAFETY NET                                            */
/* ========================================================================== */

/**
 * Node terminates on an unhandled rejection since v15. In a trading backend that
 * turns any stray un-awaited promise into a total outage that drops every SSE client
 * and stops the Box position monitor. The individual offenders have their own
 * `.catch()`; this is the net under them, and it logs LOUDLY so a new offender is
 * obvious rather than invisible.
 *
 * `uncaughtException` is deliberately FATAL: an unknown synchronous throw leaves the
 * process in an undefined state, and pricing or executing trades from there is far
 * more dangerous than exiting into the durable recovery path.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    "[FATAL-GUARD] Unhandled promise rejection — the process survived, but this is a bug and " +
      "the promise's work did NOT complete:",
    reason,
  );
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception — exiting so the supervisor can restart:", err);
  // No trading state is altered or invented here; open positions are adopted on restart.
  process.exit(1);
});

/** Exported for the shutdown ordering tests, which drive the coordinator directly. */
export { shutdownCoordinator, boot };
