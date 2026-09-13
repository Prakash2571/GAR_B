/**
 * ActiveBrokerManager — the single authority on which broker owns the system.
 *
 * THE INVARIANT IT EXISTS TO ENFORCE
 * Exactly ONE broker at a time owns the market-data feed, the scanner, Box
 * execution, positions, reconciliation, margins and charges. Historical trades from
 * both brokers coexist in the database forever; only one broker ever creates or
 * monitors new ones.
 *
 * That is not achievable by convention. Two feeds can physically both be connected,
 * two adapters can both hold a session, and stale depth from a previous broker looks
 * exactly like current depth to the scanner. So the rule is enforced structurally:
 *
 *   - Everything broker-specific is reachable only through `runtime()`, which
 *     returns ONE runtime. There is no way to ask for "the Dhan feed" while Zerodha
 *     is active.
 *   - A switch is a guarded, ordered transition (`switchBroker`) that refuses while
 *     exposure exists and, when it proceeds, TEARS DOWN the old broker before the
 *     new one is reachable.
 *   - Books never survive a switch. `stop()` on each feed discards its quote state,
 *     and the Box quote store is cleared, so Zerodha depth can never price a Dhan
 *     decision.
 *
 * WHY SWITCHING IS REFUSED RATHER THAN QUEUED
 * A switch while a box is open would leave a real position monitored by the wrong
 * feed and reconciled against the wrong order-id space. There is no safe automatic
 * resolution, so the operator is told what to close first (HTTP 409) instead of the
 * system guessing.
 */

import type { Instrument, KiteClient } from "../kite.js";
import type { TickerHub } from "../hub.js";
import type { BrokerAdapter } from "../box/brokerAdapter.js";
import type {
  BoxBasketMargin,
  BoxMarginOrder,
  BoxMarginProvider,
  BoxMarginSource,
  BoxMarketDataProvider,
  BoxRestQuote,
} from "../box/brokerContext.js";
import { BROKER_IDS, type BrokerHealthState, type BrokerId, type BrokerSessionState } from "./types.js";
import { createZerodhaLiveAdapter } from "./zerodha/liveAdapter.js";
import { brokerRateLimits, RateBudgetLedger } from "../box/brokerPacing.js";
import {
  DhanClient,
  describeDhanMarginPayload,
  extractIpv4Addresses,
  normalizeDhanMultiMargin,
} from "./dhan/client.js";
import { SubscriptionCoordinator } from "./subscriptions.js";
import { InstrumentProvider } from "./instrumentProvider.js";
import { QuoteProvider } from "./quoteProvider.js";
import { computeFeedHealth, type FeedHealth } from "./feedHealth.js";
import { DhanHttp, dhanHttpConfigFromEnv } from "./dhan/http.js";
import { DhanFeed } from "./dhan/feed.js";
import { DhanOrderFeed, type DhanOrderFeedOptions } from "./dhan/orderFeed.js";
import { ZerodhaFeed } from "./zerodha/feed.js";
import { type LaneFeedStats, type MarketDataLane } from "./marketDataLane.js";
import { DhanInstrumentStore, dhanInternalToken, getDhanParseReport, type DhanInstrument } from "./dhan/instruments.js";
import { DhanChargeCalculator } from "./dhan/charges.js";
import { DhanBrokerAdapter, dhanAdapterConfigFromBoxConfig } from "../box/dhanBrokerAdapter.js";
import {
  consumeDhanConsent,
  generateDhanConsent,
  isDhanTokenExpired,
  readDhanCredentials,
  type DhanAppCredentials,
} from "./dhan/auth.js";
import { dhanSegmentFor, type DhanExchangeSegment } from "./dhan/segments.js";
import {
  clearDhanSession,
  loadActiveBroker,
  loadDhanSession,
  saveActiveBroker,
  saveDhanSession,
} from "../brokerState/brokerSessions.js";
import type { BoxConfig } from "../box/config.js";
import type { ExecutionTimingRecorder } from "../box/executionTiming.js";
import { DhanError } from "./dhan/errors.js";

/** Why a broker switch was refused. Each maps to something the operator can fix. */
export type SwitchBlockReason =
  | "scanner_running"
  | "open_box_positions"
  | "working_orders"
  | "execution_in_flight"
  | "unresolved_reconciliation"
  | "residual_exposure"
  | "unknown_order_state"
  | "foreign_unresolved_intents"
  | "broker_not_configured";

export interface SwitchBlocker {
  reason: SwitchBlockReason;
  detail: string;
}

/**
 * What the manager needs to inspect before allowing a switch.
 *
 * Injected as a callback bundle rather than importing the engine, which would be a
 * circular dependency (the engine consumes the manager's providers).
 */
export interface ExposureProbe {
  scannerRunning: () => boolean;
  openPositionCount: () => number;
  /** Distinct brokers currently holding open positions. */
  brokersWithOpenPositions: () => BrokerId[];
  workingOrderCount: () => number;
  executionInFlight: () => boolean;
  reconciliationComplete: () => boolean;
  residualLegCount: () => number;
  unknownOrderCount: () => number;
  /**
   * Unresolved durable order intents belonging to a broker.
   *
   * Broker-scoped because an intent may only ever be reconciled through the broker
   * that created it — Dhan and Zerodha order ids are unrelated identifier spaces, so
   * a cross-broker lookup either 404s (misread as "never existed") or, far worse,
   * collides with an unrelated real order.
   */
  unresolvedIntentsFor: (broker: BrokerId) => Promise<number>;
}

/** Teardown/startup hooks the manager drives during a switch. */
export interface SwitchHooks {
  /** Stop discovery. Must not throw. */
  stopScanner: () => void;
  /** Drop every cached quote/depth book and bump the feed generation. */
  invalidateBooks: () => void;
  /** Reload the instrument universe for the newly active broker. */
  reloadUniverse: () => Promise<void>;
  /** Re-publish state to every SSE client. */
  publish: () => void;
  /**
   * Drop this process's contract reservations.
   *
   * Reservation keys are broker-namespaced (`ZERODHA:NFO:...` vs `DHAN:...`), so a
   * surviving reservation from the outgoing broker is meaningless under the new one and
   * would only block a legitimate execution until its TTL expired. Awaited, because the
   * durable tier is a database write, and it must complete before the new broker's feed
   * starts producing candidates.
   *
   * It clears only what THIS process owns. A sibling worker's live reservations are
   * authoritative and must survive.
   */
  clearInstrumentReservations?: () => Promise<void>;
  /**
   * Invalidate every stored browser market-data subscription session.
   *
   * A session holds a token list in the PREVIOUS broker's namespace. Left in place, a
   * reconnecting `EventSource` would resubscribe those integers against the new broker
   * — the cross-broker leak the switch exists to prevent.
   */
  dropMarketDataSessions?: () => number;
}

export interface ActiveBrokerManagerDeps {
  kite: KiteClient;
  tickerHub: TickerHub;
  boxConfig: () => BoxConfig;
  istDayKey: (at?: number) => string;
  /** Applied to Dhan ticks so they reach the Box quote store and SSE consumers. */
  onDhanTicks: (ticks: Parameters<TickerHub["seed"]>[0]) => void;
  onDhanConnection?: (connected: boolean) => void;
  onSessionLost?: (broker: BrokerId, reason: string) => void;
  /** Zerodha credentials, read fresh so a lane reconnect uses the CURRENT token. */
  zerodhaCredentials: () => { apiKey: string; accessToken: string | null };
  /**
   * Ticks from the BOX lane.
   *
   * Delivered straight to the Box quote store and deliberately NOT through the hub:
   * the hub owns the board's caches and its SSE fan-out, and pushing thousands of
   * option strikes through it would both pollute those caches and put option volume on
   * the browser broadcast path. Separate lane, separate destination.
   */
  onBoxLaneTicks?: (ticks: Parameters<TickerHub["seed"]>[0]) => void;
  onBoxLaneConnection?: (connected: boolean) => void;
  /**
   * The BOX lane's market-data socket reported a session/token rejection (a dead or expired
   * token), as opposed to a transient disconnect. Forwarded to the engine so the driven
   * MarketDataStateMachine reaches AUTH_EXPIRED and does not reconnect fast-forever on a
   * known-invalid token. Distinct from a plain `onBoxLaneConnection(false)`.
   */
  onBoxLaneSessionLost?: (reason: string) => void;
  /**
   * Kite order-update TEXT frames from the BOX lane's Zerodha socket.
   *
   * Zerodha multiplexes order postbacks onto the SAME quote socket as the binary ticks (text =
   * postbacks, binary = ticks), and a single API key may hold at most 3 connections — so there is
   * no dedicated Zerodha order socket to open. When supplied, the box lane forwards every text
   * frame here for the order-stream consumer to parse. Absent ⇒ text frames are ignored.
   */
  onBoxLaneOrderText?: (raw: string) => void;
}

/** A lane with no socket yet: honest zeros rather than a pretence of health. */
function emptyLaneStats(lane: MarketDataLane, wanted: number, generation: number): LaneFeedStats {
  return {
    lane,
    connected: false,
    subscribedTokens: 0,
    wantedTokens: wanted,
    ticksPerSecond: 0,
    lastTickAgeMs: null,
    reconnects: 0,
    generation,
  };
}

/**
 * The per-unit price to quote a leg at in Dhan's margin calculator.
 *
 * Dhan's calculator has no `order_type`, so it cannot resolve a MARKET order's price
 * from the LTP the way Kite's basket endpoint does — whatever is in this field IS the
 * price it margins against. The engine therefore passes the real per-leg price as
 * `reference_price` while leaving `price` at 0 for Kite's benefit.
 *
 * The final 0.05 is a liveness guard, not an estimate: Dhan rejects a zero-priced leg,
 * and a rejected basket call degrades to the per-leg sum, so a nominal price yields a
 * hedge-aware figure that is merely missing its premium component rather than an
 * over-statement several times too large.
 */
function pickLegPrice(order: BoxMarginOrder): number {
  for (const candidate of [order.reference_price, order.price]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return 0.05;
}

/**
 * The broker a FRESH deployment starts on, from `DEFAULT_ACTIVE_BROKER`.
 *
 * This variable was specified and documented but never read — the initial broker was
 * hardcoded to Zerodha, so an operator who set `DEFAULT_ACTIVE_BROKER=dhan` got Zerodha
 * and no warning. It is honoured ONLY when there is no durable `active_broker` row:
 * `restore()` always overrides it from PostgreSQL, because the operator's last real
 * selection outranks a config default and a restart must never silently revert a broker
 * switch. So this decides the FIRST boot of a new deployment and nothing else.
 *
 * An unrecognised value falls back to Zerodha with a warning rather than failing startup:
 * a typo here must not take down a process whose durable record is about to override it.
 * This fallback affects ONLY a fresh deployment: on any process that has ever persisted a
 * broker selection, restore() reads the durable record and fails closed on any problem, so
 * the persisted broker — never this env default — decides ownership.
 */
function defaultActiveBrokerFromEnv(env: NodeJS.ProcessEnv = process.env): BrokerId {
  const raw = (env.DEFAULT_ACTIVE_BROKER ?? "").trim().toLowerCase();
  if (!raw) return "zerodha";
  if ((BROKER_IDS as readonly string[]).includes(raw)) return raw as BrokerId;
  console.warn(
    `[Broker] DEFAULT_ACTIVE_BROKER="${raw}" is not a known broker (${BROKER_IDS.join(", ")}) — defaulting to zerodha.`,
  );
  return "zerodha";
}

/**
 * Whether losing Zerodha may move SPECULATIVE ENTRY to Dhan by itself.
 *
 * Defaults FALSE and is expected to stay false. With it false, an unavailable Zerodha
 * means "report Zerodha unavailable and Dhan ready in standby" — it does NOT start
 * scanning or entering on Dhan, because an automatic venue change is a trading decision
 * and belongs to an operator. This never affects REDUCTION: whichever broker owns exposure
 * keeps its adapter for exits, protective cancellation and reconciliation regardless.
 */
function autoFallbackToDhanFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AUTO_FALLBACK_TO_DHAN ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

export class ActiveBrokerManager {
  private active: BrokerId = defaultActiveBrokerFromEnv();
  /**
   * Read once at construction so a mid-session env mutation cannot change trading
   * behaviour without a restart.
   */
  private readonly autoFallbackToDhan: boolean = autoFallbackToDhanFromEnv();
  private probe: ExposureProbe | null = null;
  private hooks: SwitchHooks | null = null;

  /* ---- Dhan runtime pieces, constructed once and reused ---- */
  private dhanHttp: DhanHttp;
  private dhanClient: DhanClient;
  private dhanInstruments = new DhanInstrumentStore();
  private dhanCharges = new DhanChargeCalculator();
  private dhanFeed: DhanFeed | null = null;
  private dhanAccessToken: string | null = null;
  /**
   * ONE application-owned order-rate budget per broker ACCOUNT (Task 8).
   *
   * The broker meters the ACCOUNT, not the adapter instance, so this ledger is shared across
   * every adapter/consumer built for the same broker here — never one ledger per adapter. It is
   * created lazily on first adapter build and reused, so a rebuilt adapter (e.g. after a token
   * refresh) inherits the same accumulated window state rather than resetting the budget to zero.
   */
  private readonly rateBudgets = new Map<BrokerId, RateBudgetLedger>();
  private dhanTokenExpiry: number | null = null;
  private dhanSessionMeta: {
    clientId: string;
    clientName: string;
    clientUcc: string;
    powerOfAttorney: boolean;
    loginDay: string;
    loginAt: number;
  } | null = null;
  private dhanProblems: string[] = [];
  /** Provenance of the most recent margin figure, for the status endpoints. */
  private lastMarginSource: BoxMarginSource | null = null;
  /**
   * Static-IP verification verdict: true (matched), false (mismatch/unreachable),
   * null (never checked, or no IP configured to check).
   *
   * `null` is NOT treated as ready when an IP is configured — see dhanStaticIpReady.
   */
  private dhanIpVerified: boolean | null = null;
  private dhanIpPrimary: string | null = null;
  private dhanIpSecondary: string | null = null;
  private dhanIpCheckedAt: number | null = null;
  private dhanIpError: string | null = null;

  /**
   * Broker/feed GENERATION. Bumped on every switch.
   *
   * Kite tokens and Dhan tokens are different namespaces, so anything cached under a
   * previous generation is not merely stale — it is meaningless. The number lets every
   * cache and book be attributed, and lets an old-generation book be rejected rather
   * than mistaken for a current one.
   */
  private gen = 1;
  /** Newest tick timestamp seen from the ACTIVE broker's feed. */
  private lastTickAt: number | null = null;
  /** Set while a switch is mid-flight, so nothing reports READY during a transition. */
  private transitioning = false;

  /**
   * The FUTURES lane: calendar-spread board, spot, futures analytics, browser SSE.
   *
   * Named `subscriptions` rather than `futuresSubscriptions` so every existing caller
   * (browser leases, feed health, the status endpoints) keeps working unchanged. The
   * accessor `futuresSubscriptions` below is the explicit name for new code.
   */
  readonly subscriptions: SubscriptionCoordinator;
  /** The BOX lane: option strikes for the Box scanner, on its own socket and budget. */
  readonly boxSubscriptions: SubscriptionCoordinator;
  readonly instrumentProvider: InstrumentProvider;
  readonly quoteProvider: QuoteProvider;

  /** Box-lane sockets, created lazily — only when the Box scanner actually wants data. */
  private boxZerodhaFeed: ZerodhaFeed | null = null;
  private boxDhanFeed: DhanFeed | null = null;

  constructor(private deps: ActiveBrokerManagerDeps) {
    this.dhanHttp = new DhanHttp(
      dhanHttpConfigFromEnv({
        accessToken: () => this.usableDhanToken(),
        clientId: () => this.dhanSessionMeta?.clientId ?? process.env.DHAN_CLIENT_ID?.trim() ?? "",
      }),
    );
    this.dhanClient = new DhanClient(this.dhanHttp, () =>
      this.dhanSessionMeta?.clientId ?? process.env.DHAN_CLIENT_ID?.trim() ?? "",
    );

    // EVERY market-data subscription goes through the coordinator, which diffs
    // refcounts and only then touches the ACTIVE broker's socket. This is what stops a
    // browser SSE client from opening a Zerodha WebSocket while Dhan is active.
    this.subscriptions = new SubscriptionCoordinator(
      {
        subscribeTokens: (tokens) => this.subscribeUpstream("futures", tokens),
        unsubscribeTokens: (tokens) => this.unsubscribeUpstream("futures", tokens),
      },
      "futures",
    );
    // A SECOND, fully independent coordinator for the Box lane. It holds no reference
    // to the futures transport, so a Box strike-window diff is structurally incapable
    // of emitting a subscribe or unsubscribe on the board's socket — and vice versa.
    this.boxSubscriptions = new SubscriptionCoordinator(
      {
        subscribeTokens: (tokens) => this.subscribeUpstream("box", tokens),
        unsubscribeTokens: (tokens) => this.unsubscribeUpstream("box", tokens),
      },
      "box",
    );

    this.instrumentProvider = new InstrumentProvider({
      activeBroker: () => this.active,
      kite: deps.kite,
      dhanInstruments: this.dhanInstruments,
      generation: () => this.gen,
    });

    this.quoteProvider = new QuoteProvider({
      activeBroker: () => this.active,
      kite: deps.kite,
      dhan: this.dhanClient,
      dhanInstruments: this.dhanInstruments,
      instruments: () => this.instrumentProvider.load(),
    });
  }

  /** The current broker/feed generation. */
  get generation(): number {
    return this.gen;
  }

  /** Record that a tick arrived, for the feed-health model. */
  noteTick(at: number = Date.now()): void {
    this.lastTickAt = at;
  }

  /**
   * Reject a token that does not belong to the ACTIVE broker.
   *
   * Loud rather than silent: a cross-namespace token means some caller is holding a
   * board from the previous broker, and guessing which instrument was meant would
   * attribute a price to the wrong contract. Returns true when the token is usable.
   */
  assertActiveBrokerToken(token: number, context: string): boolean {
    const owned = this.instrumentProvider.ownsToken(token);
    // null = the universe has not loaded, so we genuinely cannot tell. Refusing then
    // would break startup rather than prevent a bug.
    if (owned === null) return true;
    if (!owned) {
      console.error(
        `[Broker] REJECTED token ${token} in ${context}: it does not belong to the active ` +
          `broker (${this.active}, generation ${this.gen}). This is a cross-broker token leak.`,
      );
      return false;
    }
    return true;
  }

  /**
   * Subscribe on the ACTIVE broker's socket FOR THIS LANE only.
   *
   * The lane selects which of the two sockets is touched; the broker selects which
   * implementation. Both dimensions are explicit, so no call site can accidentally
   * cross either boundary.
   */
  private subscribeUpstream(lane: MarketDataLane, tokens: number[]): void {
    if (tokens.length === 0) return;
    if (lane === "box") {
      if (this.active === "zerodha") this.ensureBoxZerodhaFeed().subscribeTokens(tokens);
      else this.ensureBoxDhanFeed().subscribeTokens(tokens);
      return;
    }
    if (this.active === "zerodha") {
      this.deps.tickerHub.subscribeTokens(tokens);
      return;
    }
    this.ensureDhanFeed().subscribeTokens(tokens);
  }

  private unsubscribeUpstream(lane: MarketDataLane, tokens: number[]): void {
    if (tokens.length === 0) return;
    if (lane === "box") {
      if (this.active === "zerodha") this.boxZerodhaFeed?.unsubscribeTokens(tokens);
      else this.boxDhanFeed?.unsubscribeTokens(tokens);
      return;
    }
    if (this.active === "zerodha") {
      this.deps.tickerHub.unsubscribeTokens(tokens);
      return;
    }
    this.dhanFeed?.unsubscribeTokens(tokens);
  }

  /**
   * The Box lane's Zerodha socket.
   *
   * This is the SECOND of the three connections Zerodha permits per API key; the first
   * is the futures lane's, and the third is deliberately left free. Created lazily, so
   * a deployment that never runs the Box scanner opens exactly one socket.
   */
  private ensureBoxZerodhaFeed(): ZerodhaFeed {
    if (!this.boxZerodhaFeed) {
      this.boxZerodhaFeed = new ZerodhaFeed({
        lane: "box",
        credentials: () => this.deps.zerodhaCredentials(),
        generation: () => this.gen,
        onTicks: (ticks) => {
          this.noteTick();
          this.deps.onBoxLaneTicks?.(ticks);
        },
        onConnectionChange: (connected) => this.deps.onBoxLaneConnection?.(connected),
        onDead: (message) => {
          console.warn(`[Broker] box lane (zerodha) feed died: ${message}`);
          // A Kite feed death is a credential/token rejection (not a reconnectable network blip):
          // surface it as a market-data session loss so the health machine goes AUTH_EXPIRED.
          this.deps.onBoxLaneSessionLost?.(message);
        },
        // Order postbacks ride this SAME socket as text frames — no extra Zerodha socket exists.
        ...(this.deps.onBoxLaneOrderText
          ? { onTextFrame: (raw: string) => this.deps.onBoxLaneOrderText?.(raw) }
          : {}),
      });
    }
    return this.boxZerodhaFeed;
  }

  /** The Box lane's Dhan socket. Dhan permits 5 per user, so two lanes fit easily. */
  private ensureBoxDhanFeed(): DhanFeed {
    if (!this.boxDhanFeed) {
      this.boxDhanFeed = new DhanFeed({
        accessToken: () => this.usableDhanToken(),
        clientId: () => this.dhanSessionMeta?.clientId ?? process.env.DHAN_CLIENT_ID?.trim() ?? "",
        onTicks: (ticks) => {
          this.noteTick();
          this.deps.onBoxLaneTicks?.(ticks);
        },
        onConnection: (connected) => this.deps.onBoxLaneConnection?.(connected),
        onSessionLost: (reason) => {
          // Distinguish an auth/session rejection (dhan/feed classifies close codes 1008/4401 etc)
          // from a transient drop: this path only fires for the former, so it is a market-data
          // session loss too — the box lane's health machine must reach AUTH_EXPIRED, not merely
          // DISCONNECTED, and must not reconnect fast-forever on a dead token.
          this.deps.onBoxLaneSessionLost?.(reason);
          void this.onDhanSessionLost(reason);
        },
        resolve: (token) => this.dhanInstruments.identify(token),
        depthLevel: 5,
      });
    }
    return this.boxDhanFeed;
  }

  /** Replace the BOX lane's entire token set in one diff. */
  setBoxTokens(tokens: number[]): void {
    this.boxSubscriptions.setOwnerTokens("strategy", tokens);
  }

  /**
   * Construct the Dhan DEDICATED order-update feed, bound to the CURRENT session.
   *
   * This is a SEPARATE socket from the Dhan market feed (wss://api-order-update.dhan.co vs
   * wss://api-feed.dhan.co). It reads the token and client id fresh on every connect via the
   * registry's session, so a reconnect after a token refresh authorises with the current JWT.
   * The order-stream consumer supplies the observation/lifecycle handlers; the registry supplies
   * only the credentials and the socket, so credential ownership never leaves this class.
   *
   * Returns null unless Dhan is the active broker — an order feed for the inactive broker would
   * observe an account the system is not trading, exactly the cross-broker leak the manager forbids.
   */
  createDhanOrderFeed(
    handlers: Pick<
      DhanOrderFeedOptions,
      "onObservation" | "onConnecting" | "onConnected" | "onDisconnected" | "onSessionLost" | "nowMono" | "nowWall"
    >,
  ): DhanOrderFeed | null {
    if (this.active !== "dhan") return null;
    return new DhanOrderFeed({
      accessToken: () => this.usableDhanToken(),
      clientId: () => this.dhanSessionMeta?.clientId ?? process.env.DHAN_CLIENT_ID?.trim() ?? "",
      ...handlers,
    });
  }

  /** Per-lane feed statistics for diagnostics. */
  laneStats(lane: MarketDataLane): LaneFeedStats {
    const wanted = lane === "box" ? this.boxSubscriptions.size : this.subscriptions.size;
    if (lane === "box") {
      if (this.active === "zerodha") {
        const feed = this.boxZerodhaFeed;
        if (feed) return feed.stats();
        return emptyLaneStats("box", wanted, this.gen);
      }
      const feed = this.boxDhanFeed;
      return feed
        ? {
            lane: "box",
            connected: feed.isConnected(),
            subscribedTokens: feed.subscribedCount(),
            wantedTokens: feed.wantedCount(),
            ticksPerSecond: 0,
            lastTickAgeMs: feed.feedAgeMs(),
            reconnects: 0,
            generation: this.gen,
          }
        : emptyLaneStats("box", wanted, this.gen);
    }
    if (this.active === "dhan") {
      const feed = this.dhanFeed;
      return feed
        ? {
            lane: "futures",
            connected: feed.isConnected(),
            subscribedTokens: feed.subscribedCount(),
            wantedTokens: feed.wantedCount(),
            ticksPerSecond: 0,
            lastTickAgeMs: feed.feedAgeMs(),
            reconnects: 0,
            generation: this.gen,
          }
        : emptyLaneStats("futures", wanted, this.gen);
    }
    return {
      lane: "futures",
      connected: this.deps.tickerHub.isConnected(),
      subscribedTokens: this.deps.tickerHub.subscribedCount(),
      wantedTokens: wanted,
      ticksPerSecond: 0,
      lastTickAgeMs: this.lastTickAt === null ? null : Math.max(0, Date.now() - this.lastTickAt),
      reconnects: 0,
      generation: this.gen,
    };
  }

  /** Stop BOTH lanes of BOTH brokers, and forget their subscriptions. */
  private stopAllLanes(): void {
    const attempt = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (err) {
        console.warn(`[Broker] ${what} failed:`, err);
      }
    };
    attempt("tickerHub.stop()", () => this.deps.tickerHub.stop());
    attempt("dhanFeed.stop()", () => this.dhanFeed?.stop());
    attempt("boxZerodhaFeed.stop()", () => this.boxZerodhaFeed?.stop());
    attempt("boxDhanFeed.stop()", () => this.boxDhanFeed?.stop());
    // A stopped ZerodhaFeed is permanently disposed, so the next lane use must build a
    // fresh one under the NEW generation rather than resurrect the old socket object.
    this.boxZerodhaFeed = null;
    this.boxDhanFeed = null;
  }

  /** Wire the exposure probe and switch hooks (done once, after the engine exists). */
  attach(probe: ExposureProbe, hooks: SwitchHooks): void {
    this.probe = probe;
    this.hooks = hooks;
  }

  /* ------------------------------ identity ------------------------------- */

  get activeBroker(): BrokerId {
    return this.active;
  }

  /**
   * May speculative ENTRY move to Dhan on its own because Zerodha is unavailable?
   *
   * Answers the `AUTO_FALLBACK_TO_DHAN` policy question in one place so the boot wiring and
   * the runtime status agree. `false` (the default and the expectation) means an
   * unavailable Zerodha leaves Dhan in standby: reported as ready, not scanned, not entered.
   *
   * Deliberately says nothing about reduction. Exits, protective cancellation, emergency
   * residual flattening and reconciliation always run through whichever broker owns the
   * exposure, and no policy flag may gate them.
   */
  mayAutoFallbackToDhan(): boolean {
    return this.autoFallbackToDhan;
  }

  /**
   * The broker the process would start on before any durable record is consulted.
   * Exposed for diagnostics and tests, so `DEFAULT_ACTIVE_BROKER` is observable rather
   * than an invisible constructor detail.
   */
  configuredDefaultBroker(): BrokerId {
    return defaultActiveBrokerFromEnv();
  }

  /**
   * Restore the persisted broker selection at boot. MANDATORY — never best-effort.
   *
   * Without this a restart would silently revert to Zerodha and begin pricing trades
   * from the wrong venue — the trades would even be stamped `broker: "zerodha"`,
   * making the mistake invisible afterwards.
   *
   * FAIL CLOSED. Every failure mode here REJECTS, and the caller (boot) must let the
   * rejection kill the process:
   *   - the `active_broker` query failed          → reject (PostgreSQL is the authority)
   *   - the stored broker is unknown/absent       → reject (DurableStateError)
   *   - the stored generation is unusable         → reject (DurableStateError)
   *   - the stored Dhan session cannot be read
   *     or decrypted                              → reject
   *
   * Only a CONFIRMED "no active_broker row" (a fresh deployment) resolves, and only
   * that case uses `DEFAULT_ACTIVE_BROKER`. This is the difference between "PostgreSQL
   * told us there is nothing yet" and "we could not ask PostgreSQL": the first is a
   * first boot, the second is an outage, and adopting a default broker + generation 1
   * during an outage is exactly how a stale predecessor's durable instrument
   * reservation starts looking current.
   */
  async restore(): Promise<void> {
    // NOT `.catch(() => null)`. A rejection here is a boot failure by design.
    const saved = await loadActiveBroker();
    if (saved === null) {
      // Confirmed absence → fresh deployment. Keep the configured default and the
      // starting generation. This is the ONLY path that trusts the env variable.
      console.log(
        `[Broker] no durable active_broker row — fresh deployment starting on ` +
          `${this.active} (DEFAULT_ACTIVE_BROKER) at generation ${this.gen}.`,
      );
    } else {
      // `loadActiveBroker` has already validated the broker against BROKER_IDS and
      // the generation as a positive safe integer, so both are adopted unconditionally.
      // The generation is adopted even if it is LOWER than the in-memory starting
      // value: PostgreSQL is the authority on the count, not this process.
      this.active = saved.broker as BrokerId;
      this.gen = saved.generation;
      console.log(
        `[Broker] restored durable selection ${this.active} at generation ${this.gen}.`,
      );
    }
    // Rehydrate a still-valid Dhan session so a restart does not force a re-login.
    // A read/decrypt FAILURE rejects (see adoptStoredDhanSession); only a confirmed
    // absent/expired session resolves false.
    await this.adoptStoredDhanSession();
    if (this.active === "dhan") this.dhanProblems = this.computeDhanProblems();
  }

  /**
   * Read the encrypted Dhan session out of PostgreSQL and install it in memory.
   *
   * WHY THIS IS PUBLIC AND NOT JUST PART OF `restore()`
   * It used to be inlined in `restore()`, which runs ONCE at boot — and that was a
   * real bug in the GTS Algo Research token flow. The daily acquisition service persists a
   * freshly fetched Dhan token to `broker_sessions` and then calls back to say it is
   * installed; with rehydration reachable only from boot, that callback had nothing to
   * call. The token was durable but the RUNNING manager still held
   * `dhanAccessToken = null`, so on any normal morning (process up before 09:00 IST,
   * token acquired at 09:00) Dhan reported itself unauthenticated for the whole
   * session and could not be selected as the active broker without a process restart.
   *
   * Now the acquisition service calls this after every successful Dhan persist, so the
   * durable write and the in-memory install are the same event from the caller's point
   * of view. It re-reads from the store rather than accepting a token argument
   * deliberately: PostgreSQL is the authority, decryption stays inside the session
   * provider, and no plaintext token has to be threaded through another interface.
   *
   * Idempotent, and safe to call when no session is stored (it then changes nothing).
   * An EXPIRED stored session is cleared rather than adopted — a dead token installed
   * in memory would make `authenticated` true for one expiry check and then fail at the
   * broker, which is strictly worse than reporting the truth.
   *
   * ABSENCE AND FAILURE ARE DIFFERENT ANSWERS
   *   - PostgreSQL confirmed there is no active Dhan row → `false` ("not connected")
   *   - the stored session is present but expired         → `false`, and it is invalidated
   *   - the query failed, or the row cannot be decrypted  → REJECTS
   *
   * The third case used to be `.catch(() => null)`, i.e. reported as "Dhan is not
   * connected". That is a lie with consequences in both directions: at boot it let the
   * process come up believing a connected broker was unauthenticated, and on the daily
   * token path it made a decryption misconfiguration look like a missing token, so the
   * service would discard a perfectly good stored credential and re-acquire. The
   * rejection now propagates: boot fails closed, and the token acquisition service
   * records the bounded reason in its status and retries on its existing schedule.
   *
   * No plaintext token appears in any error or log on any of these paths.
   */
  async adoptStoredDhanSession(): Promise<boolean> {
    // NOT `.catch(() => null)`. A query/decrypt failure must not masquerade as absence.
    const session = await loadDhanSession();
    if (!session) return false;
    if (isDhanTokenExpired(session.expiry_time)) {
      await clearDhanSession().catch(() => undefined);
      this.dhanProblems = ["Dhan session expired — reconnect Dhan"];
      return false;
    }
    this.dhanAccessToken = session.access_token;
    this.dhanTokenExpiry = session.expiry_time;
    this.dhanSessionMeta = {
      clientId: session.dhan_client_id,
      clientName: session.dhan_client_name,
      clientUcc: session.dhan_client_ucc,
      powerOfAttorney: session.given_power_of_attorney,
      loginDay: session.login_date,
      loginAt: session.login_at ? new Date(session.login_at).getTime() : Date.now(),
    };
    this.dhanProblems = this.computeDhanProblems();
    return true;
  }

  /**
   * Bring the ACTIVE broker's runtime up at boot, in dependency order.
   *
   * Prerequisites are established BEFORE the runtime is reported ready: verifying the
   * session and loading the universe first means a status read during startup says
   * "connecting", never "live with an empty board".
   */
  async startActiveRuntime(): Promise<void> {
    const session = this.sessionFor(this.active);
    if (!session.authenticated) {
      console.log(`[Broker] active=${this.active} generation=${this.gen} — no session, runtime idle`);
      return;
    }
    console.log(`[Broker] active=${this.active} generation=${this.gen}`);
    if (this.active === "dhan") {
      await this.verifyDhanStaticIp().catch(() => undefined);
    }
    await this.instrumentProvider.load(true).catch((err) =>
      console.warn(`[Broker] ${this.active} universe load failed at boot:`, err),
    );
    this.startActiveFeed();
    this.dhanProblems = this.computeDhanProblems();
  }

  /* -------------------------- Dhan session state ------------------------- */

  /** The token, or null when absent/expired. Expiry is enforced on every read. */
  private usableDhanToken(): string | null {
    if (!this.dhanAccessToken) return null;
    if (isDhanTokenExpired(this.dhanTokenExpiry)) return null;
    return this.dhanAccessToken;
  }

  dhanCredentials(): { ok: true; creds: DhanAppCredentials } | { ok: false; reason: string } {
    return readDhanCredentials();
  }

  /** STEP 1 of the Dhan login: a consent + the browser URL. */
  async beginDhanLogin(): Promise<{ consentAppId: string; loginUrl: string }> {
    const creds = readDhanCredentials();
    if (!creds.ok) throw new DhanError(creds.reason, 400, "CONFIG");
    return generateDhanConsent(creds.creds);
  }

  /** STEP 3: exchange the redirect's tokenId for a session and persist it. */
  async completeDhanLogin(tokenId: string): Promise<BrokerSessionState> {
    const creds = readDhanCredentials();
    if (!creds.ok) throw new DhanError(creds.reason, 400, "CONFIG");
    const session = await consumeDhanConsent(creds.creds, tokenId);

    this.dhanAccessToken = session.accessToken;
    this.dhanTokenExpiry = session.expiryTime;
    this.dhanSessionMeta = {
      clientId: session.dhanClientId,
      clientName: session.dhanClientName,
      clientUcc: session.dhanClientUcc,
      powerOfAttorney: session.givenPowerOfAttorney,
      loginDay: this.deps.istDayKey(),
      loginAt: Date.now(),
    };
    await saveDhanSession({
      access_token: session.accessToken,
      dhan_client_id: session.dhanClientId,
      dhan_client_name: session.dhanClientName,
      dhan_client_ucc: session.dhanClientUcc,
      given_power_of_attorney: session.givenPowerOfAttorney,
      expiry_time: session.expiryTime,
      login_date: this.deps.istDayKey(),
    }).catch((err) => console.warn("[Dhan] failed to persist the session:", err));

    this.dhanProblems = this.computeDhanProblems();
    // Warm the universe now so the first scan is not waiting on a multi-MB CSV.
    void this.dhanInstruments.load().catch((err) =>
      console.warn("[Dhan] instrument master load failed after login:", err),
    );
    // A RECONNECT replaces the access token, so the socket opened with the PREVIOUS
    // token must not survive: it authenticates with a credential we have just
    // superseded, and Dhan may drop it at any moment while the runtime still believes
    // the feed is live. Recycle it explicitly.
    if (this.dhanFeed) {
      console.log("[Broker] recycling the Dhan feed onto the new access token");
      this.dhanFeed.stop();
      // Drop the feed object entirely: its token reader is a closure over session
      // state, and a fresh instance is cheaper to reason about than a mutated one.
      this.dhanFeed = null;
      this.lastTickAt = null;
    }

    // Verify the static IP NOW. Establishing a session is the first moment the check
    // is even possible (it needs the token), and without this nothing in the normal
    // connect flow ever triggers it — leaving trading blocked as "not yet verified"
    // with no way for the operator to discover why.
    await this.verifyDhanStaticIp().catch(() => undefined);

    // Bring the runtime back up on the new session, but only when Dhan is the broker
    // that actually owns the runtime. Connecting a Dhan session while Zerodha is
    // active must NOT start a Dhan feed.
    if (this.active === "dhan") {
      await this.instrumentProvider.load(true).catch((err) =>
        console.warn("[Dhan] universe load after login failed:", err),
      );
      this.startActiveFeed();
      // Re-subscribe whatever consumers still want. Tokens are unchanged (same broker,
      // same namespace), so the coordinator's table is still valid — only the socket
      // was replaced.
      // Replay EACH LANE's own table onto its own socket. Replaying the union would
      // put option strikes on the board's connection and futures on the Box lane's.
      const wanted = this.subscriptions.activeTokens();
      const wantedBox = this.boxSubscriptions.activeTokens();
      if (wanted.length > 0 || wantedBox.length > 0) {
        console.log(
          `[Broker] restoring ${wanted.length} futures + ${wantedBox.length} box ` +
            `Dhan subscription(s) after reconnect`,
        );
        this.subscribeUpstream("futures", wanted);
        this.subscribeUpstream("box", wantedBox);
      }
      this.hooks?.publish();
    }
    this.dhanProblems = this.computeDhanProblems();
    return this.sessionFor("dhan");
  }

  /**
   * Drop the Dhan session and everything derived from it.
   *
   * Stops the feed and clears instruments as well as the token: a logged-out broker
   * must not keep publishing books that would look current to the scanner.
   */
  async logoutDhan(): Promise<void> {
    this.dhanAccessToken = null;
    this.dhanTokenExpiry = null;
    this.dhanSessionMeta = null;
    this.dhanFeed?.stop();
    this.dhanInstruments.clear();
    this.dhanProblems = ["Dhan is not connected"];
    await clearDhanSession().catch(() => undefined);
    if (this.active === "dhan") {
      this.hooks?.invalidateBooks();
      this.hooks?.publish();
    }
  }

  /**
   * Handle a Dhan session that has died mid-flight.
   *
   * FAIL CLOSED: the feed stops, books are invalidated (so nothing stale is treated
   * as executable) and live execution is blocked because `trading_ready` goes false.
   */
  async onDhanSessionLost(reason: string): Promise<void> {
    console.warn(`[Dhan] session lost: ${reason}`);
    this.dhanAccessToken = null;
    this.dhanTokenExpiry = null;
    this.dhanFeed?.stop();
    this.dhanProblems = ["Dhan session expired — reconnect Dhan"];
    await clearDhanSession().catch(() => undefined);
    if (this.active === "dhan") {
      this.hooks?.invalidateBooks();
      this.deps.onSessionLost?.("dhan", reason);
      this.hooks?.publish();
    }
  }

  /* ----------------------------- readiness ------------------------------- */

  /** The operator's manual declaration. Retained as an additional gate. */
  private dhanStaticIpDeclared(): boolean {
    const raw = process.env.DHAN_STATIC_IP_EXPECTED?.trim().toLowerCase() ?? "";
    return raw === "1" || raw === "true" || raw === "yes";
  }

  /** The server's public IP as the operator configured it, or "" when unset. */
  private dhanConfiguredIp(): string {
    return process.env.DHAN_STATIC_PUBLIC_IP?.trim() ?? "";
  }

  /**
   * Whether Dhan's static-IP requirement is satisfied.
   *
   * TWO SOURCES OF EVIDENCE, API-VERIFIED PREFERRED.
   *
   * Dhan refuses order placement from a non-whitelisted address, and it DOES expose
   * the whitelist (`GET /ip/getIP` → primaryIP / secondaryIP). So when the operator
   * configures `DHAN_STATIC_PUBLIC_IP`, readiness is decided by whether that address
   * actually appears in Dhan's own record — a checked precondition rather than a
   * hopeful boolean. `DHAN_STATIC_IP_EXPECTED` then acts only as an additional kill
   * switch: setting it false still blocks trading.
   *
   * Without a configured IP it falls back to the manual declaration alone, and the
   * health report says so, because a declaration is materially weaker evidence.
   *
   * FAIL CLOSED throughout: an unverified, mismatched or not-yet-checked state is not
   * ready. Synchronous by necessity (the order adapter calls it per submission), so it
   * reads a cached verification that `verifyDhanStaticIp()` refreshes.
   */
  dhanStaticIpReady(): boolean {
    const declared = this.dhanStaticIpDeclared();
    const configuredIp = this.dhanConfiguredIp();
    if (configuredIp === "") {
      // No IP to verify: the declaration is all the evidence there is.
      return declared;
    }
    // An explicit `false` remains an operator override that stops trading.
    if (process.env.DHAN_STATIC_IP_EXPECTED !== undefined && !declared) return false;
    // Otherwise require positive API confirmation. `null` (never checked) is NOT ready.
    return this.dhanIpVerified === true;
  }

  /**
   * Confirm the configured server IP against Dhan's whitelist.
   *
   * Called before live Dhan startup and on a switch to Dhan. Best-effort in the sense
   * that it never throws — but a failure sets the verdict to `false`, not to unknown,
   * so an unreachable check blocks trading instead of quietly permitting it.
   */
  async verifyDhanStaticIp(): Promise<{
    verified: boolean;
    configured_ip: string;
    primary_ip: string | null;
    secondary_ip: string | null;
    checked_at: number;
    error: string | null;
  }> {
    const configuredIp = this.dhanConfiguredIp();
    const checkedAt = Date.now();
    this.dhanIpCheckedAt = checkedAt;

    if (configuredIp === "") {
      // Nothing to compare. Leave the verdict UNKNOWN rather than false: readiness
      // then falls back to the manual declaration, which is the documented behaviour.
      this.dhanIpVerified = null;
      this.dhanIpPrimary = null;
      this.dhanIpSecondary = null;
      this.dhanIpError = null;
      return {
        verified: false,
        configured_ip: "",
        primary_ip: null,
        secondary_ip: null,
        checked_at: checkedAt,
        error: null,
      };
    }
    if (this.usableDhanToken() === null) {
      this.dhanIpVerified = false;
      this.dhanIpError = "Cannot verify the static IP without a Dhan session.";
      return {
        verified: false,
        configured_ip: configuredIp,
        primary_ip: null,
        secondary_ip: null,
        checked_at: checkedAt,
        error: this.dhanIpError,
      };
    }

    try {
      const res = await this.dhanClient.getStaticIp();
      // Scan the payload for IPv4 values rather than trusting one field spelling: the
      // previous named-field read missed Dhan's actual keys and reported the whitelist
      // as empty while the dashboard plainly showed an address.
      const addresses = extractIpv4Addresses(res);
      this.dhanIpPrimary = addresses[0] ?? null;
      this.dhanIpSecondary = addresses[1] ?? null;
      const matched = addresses.includes(configuredIp);
      this.dhanIpVerified = matched;
      if (matched) {
        this.dhanIpError = null;
      } else if (addresses.length === 0) {
        // Distinguish "Dhan reports no whitelist" from "it does not match", because the
        // operator actions are different — and name the keys we actually received so a
        // future shape change is diagnosable instead of mysterious.
        this.dhanIpError =
          `Dhan returned no IP address in its whitelist response, so ` +
          `DHAN_STATIC_PUBLIC_IP (${configuredIp}) could not be verified. ` +
          `Response fields: [${Object.keys((res ?? {}) as object).join(", ") || "none"}]. ` +
          `Add a Static IP under My Profile → Access DhanHQ APIs → Static IP Setting.`;
      } else {
        this.dhanIpError =
          `DHAN_STATIC_PUBLIC_IP (${configuredIp}) does not match Dhan's whitelist ` +
          `(${addresses.join(", ")}).`;
      }
      if (!matched) console.warn(`[Dhan] ${this.dhanIpError}`);
      this.dhanProblems = this.computeDhanProblems();
      return {
        verified: matched,
        configured_ip: configuredIp,
        primary_ip: this.dhanIpPrimary,
        secondary_ip: this.dhanIpSecondary,
        checked_at: checkedAt,
        error: this.dhanIpError,
      };
    } catch (err) {
      // FAIL CLOSED: an unreachable check is not permission to trade.
      this.dhanIpVerified = false;
      this.dhanIpError = `Static-IP verification failed: ${err instanceof Error ? err.message : String(err)}`;
      this.dhanProblems = this.computeDhanProblems();
      return {
        verified: false,
        configured_ip: configuredIp,
        primary_ip: null,
        secondary_ip: null,
        checked_at: checkedAt,
        error: this.dhanIpError,
      };
    }
  }

  /**
   * Verify the static IP only if it has not been established yet.
   *
   * Exists because the check is cached and, in the ordinary connect flow, nothing else
   * triggers it: a broker switch short-circuits when the target is already active, and
   * boot only verifies when Dhan was already the active broker WITH a live session. So
   * the status endpoint calls this, which makes simply opening (or refreshing) the
   * broker panel resolve a pending verification.
   *
   * A no-op when there is nothing to check, when a verdict already exists, or when
   * there is no session to check with.
   */
  async ensureDhanStaticIpVerified(): Promise<void> {
    if (this.dhanConfiguredIp() === "") return;
    if (this.dhanIpVerified !== null) return;
    if (this.usableDhanToken() === null) return;
    await this.verifyDhanStaticIp().catch(() => undefined);
  }

  /** The static-IP readiness detail, for the status endpoints. */
  dhanStaticIpState(): {
    ready: boolean;
    declared: boolean;
    configured_ip: string | null;
    api_verified: boolean | null;
    primary_ip: string | null;
    secondary_ip: string | null;
    checked_at: number | null;
    error: string | null;
  } {
    const configuredIp = this.dhanConfiguredIp();
    return {
      ready: this.dhanStaticIpReady(),
      declared: this.dhanStaticIpDeclared(),
      configured_ip: configuredIp === "" ? null : configuredIp,
      api_verified: this.dhanIpVerified,
      primary_ip: this.dhanIpPrimary,
      secondary_ip: this.dhanIpSecondary,
      checked_at: this.dhanIpCheckedAt,
      error: this.dhanIpError,
    };
  }

  private dhanDataEnabled(): boolean {
    const raw = process.env.DHAN_DATA_ENABLED?.trim().toLowerCase() ?? "";
    return raw === "" || raw === "1" || raw === "true" || raw === "yes";
  }

  private dhanLiveTradingEnabled(): boolean {
    const raw = process.env.DHAN_LIVE_TRADING_ENABLED?.trim().toLowerCase() ?? "";
    return raw === "1" || raw === "true" || raw === "yes";
  }

  private computeDhanProblems(): string[] {
    const problems: string[] = [];
    const creds = readDhanCredentials();
    if (!creds.ok) problems.push(creds.reason);
    if (!this.dhanAccessToken) problems.push("Dhan is not connected");
    else if (isDhanTokenExpired(this.dhanTokenExpiry)) problems.push("Dhan session expired — reconnect Dhan");
    if (!this.dhanDataEnabled()) problems.push("Dhan data API is disabled (DHAN_DATA_ENABLED=false)");
    if (!this.dhanStaticIpReady()) {
      // Say WHICH check failed: "not configured" and "configured but does not match
      // Dhan's whitelist" need completely different operator actions.
      if (this.dhanIpError) problems.push(this.dhanIpError);
      else if (this.dhanConfiguredIp() === "") {
        problems.push(
          "Static IP not configured — set DHAN_STATIC_PUBLIC_IP (preferred, API-verified) " +
            "or DHAN_STATIC_IP_EXPECTED=true. Dhan live order placement is blocked.",
        );
      } else {
        problems.push("Static IP not yet verified against Dhan — live order placement is blocked.");
      }
    } else if (!this.dhanLiveTradingEnabled()) {
      problems.push("Dhan live trading is disabled (DHAN_LIVE_TRADING_ENABLED=false)");
    } else if (this.dhanConfiguredIp() === "") {
      // Ready, but on the weaker evidence. Worth saying so.
      problems.push(
        "Static IP is accepted on the manual DHAN_STATIC_IP_EXPECTED flag only — " +
          "set DHAN_STATIC_PUBLIC_IP to have it verified against Dhan.",
      );
    }
    if (this.dhanFeed && !this.dhanFeed.isConnected() && this.dhanAccessToken) {
      problems.push("Feed reconnecting");
    }
    // A universe that parsed but yielded almost no tradable futures is a layout problem,
    // not a quiet market — surfaced here so it is visible in the UI rather than only in
    // the server log.
    const parse = getDhanParseReport();
    if (parse) {
      if (parse.missingColumns.length > 0) {
        problems.push(
          `Dhan instrument master is missing columns (${parse.missingColumns.join(", ")}) — ` +
            `see /api/dhan/instruments/diagnostics`,
        );
      }
      if (parse.fnoFutures < 50) {
        problems.push(
          `Only ${parse.fnoFutures} Dhan F&O futures were recognised (expected ~600). ` +
            `The board and scanner will be incomplete — see /api/dhan/instruments/diagnostics`,
        );
      }
    }
    return problems;
  }

  /** Session state for a broker — never derived from admin authentication. */
  sessionFor(broker: BrokerId): BrokerSessionState {
    if (broker === "zerodha") {
      const token = this.deps.kite.getAccessToken();
      return {
        broker: "zerodha",
        authenticated: token !== null,
        client_id: null,
        client_name: null,
        // Kite tokens die at the IST day boundary; there is no stated instant.
        token_expires_at: null,
        token_expired: false,
        login_day: null,
        login_at: null,
      };
    }
    const expired = isDhanTokenExpired(this.dhanTokenExpiry);
    return {
      broker: "dhan",
      authenticated: this.dhanAccessToken !== null && !expired,
      client_id: this.dhanSessionMeta?.clientId ?? null,
      client_name: this.dhanSessionMeta?.clientName ?? null,
      token_expires_at: this.dhanTokenExpiry,
      token_expired: expired,
      login_day: this.dhanSessionMeta?.loginDay ?? null,
      login_at: this.dhanSessionMeta?.loginAt ?? null,
    };
  }

  /** Capability readiness, split so data and trading fail independently. */
  healthFor(broker: BrokerId): BrokerHealthState {
    const session = this.sessionFor(broker);
    if (broker === "zerodha") {
      const connected = this.deps.tickerHub.isConnected();
      return {
        broker: "zerodha",
        authenticated: session.authenticated,
        token_expires_at: null,
        token_expired: false,
        data_ready: session.authenticated,
        // Zerodha has no static-IP requirement; live gating is the Box config's job.
        trading_ready: session.authenticated,
        static_ip_configured: null,
        feed_connected: connected,
        feed_age_ms: null,
        problems: session.authenticated ? [] : ["Zerodha is not connected"],
      };
    }
    const problems = this.computeDhanProblems();
    const dataReady = session.authenticated && this.dhanDataEnabled();
    return {
      broker: "dhan",
      authenticated: session.authenticated,
      token_expires_at: this.dhanTokenExpiry,
      token_expired: session.token_expired,
      data_ready: dataReady,
      // Three independent conditions. All must hold; any one failing blocks orders.
      trading_ready: dataReady && this.dhanStaticIpReady() && this.dhanLiveTradingEnabled(),
      static_ip_configured: this.dhanStaticIpReady(),
      feed_connected: this.dhanFeed?.isConnected() ?? false,
      feed_age_ms: this.dhanFeed?.feedAgeMs() ?? null,
      problems,
    };
  }

  /** The active broker's session + health, for the status endpoints. */
  activeSession(): BrokerSessionState {
    return this.sessionFor(this.active);
  }

  activeHealth(): BrokerHealthState {
    return this.healthFor(this.active);
  }

  /* ----------------------- broker-neutral providers ---------------------- */

  /**
   * Market data for the ACTIVE broker.
   *
   * Reads `this.active` on every call rather than capturing it, so a switch takes
   * effect immediately and a stale closure cannot keep serving the old broker.
   */
  marketData(): BoxMarketDataProvider {
    return {
      isAuthenticated: () =>
        this.active === "zerodha"
          ? this.deps.kite.getAccessToken() !== null
          : this.usableDhanToken() !== null && this.dhanDataEnabled(),
      getQuoteFull: (identifiers) =>
        this.active === "zerodha"
          ? this.deps.kite.getQuoteFull(identifiers)
          : this.dhanQuoteFull(identifiers),
    };
  }

  /**
   * REST snapshot quotes from Dhan, shaped like Kite's.
   *
   * Identifiers arrive as `EXCHANGE:TRADINGSYMBOL` (the app's internal form), so they
   * are resolved through the instrument store to Dhan's (segment, securityId).
   * Unresolvable identifiers are skipped rather than guessed.
   */
  private async dhanQuoteFull(identifiers: string[]): Promise<BoxRestQuote[]> {
    await this.dhanInstruments.load().catch(() => undefined);
    const bySymbol = new Map<string, DhanInstrument>();
    for (const inst of this.dhanInstruments.instruments) {
      bySymbol.set(`${inst.exchange}:${inst.tradingsymbol}`, inst);
    }

    const bySegment = new Map<DhanExchangeSegment, number[]>();
    const back = new Map<string, DhanInstrument>();
    for (const id of identifiers) {
      const inst = bySymbol.get(id);
      if (!inst) continue;
      const list = bySegment.get(inst.dhan_segment) ?? [];
      list.push(inst.dhan_security_id);
      bySegment.set(inst.dhan_segment, list);
      back.set(`${inst.dhan_segment}:${inst.dhan_security_id}`, inst);
    }
    if (bySegment.size === 0) return [];

    const out: BoxRestQuote[] = [];
    // Dhan caps a market-feed request at 1000 instruments per segment.
    for (const [segment, ids] of bySegment) {
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        try {
          const res = await this.dhanClient.marketFeedQuote({ [segment]: chunk });
          const entries = res.data?.[segment] ?? {};
          for (const [securityId, entry] of Object.entries(entries)) {
            const inst = back.get(`${segment}:${Number(securityId)}`);
            if (!inst) continue;
            out.push({
              instrument_token: inst.instrument_token,
              last_price: Number(entry.last_price) || 0,
              // The last-close view derives the trading SESSION from this date, so an
              // absent value must stay "" (treated as not comparable) rather than
              // becoming today and making a stale strike look current.
              last_trade_time: typeof entry.last_trade_time === "string" ? entry.last_trade_time : "",
            });
          }
        } catch (err) {
          console.warn(`[Dhan] market feed quote failed for ${segment}:`, err);
        }
      }
    }
    return out;
  }

  /** The ACTIVE broker's basket-margin provider. */
  margins(): BoxMarginProvider {
    return {
      broker: this.active,
      basketMargin: async (orders) => {
        if (this.active === "zerodha") {
          // Mapped field-by-field rather than passed through. `BoxMarginOrder` carries
          // a Dhan-only pricing hint (`reference_price`), and Kite's basket endpoint is
          // the one margin path that currently works — forwarding an unknown field to it
          // is a risk with no upside.
          const res = await this.deps.kite.getBasketMargin(
            orders.map((o) => ({
              exchange: o.exchange,
              tradingsymbol: o.tradingsymbol,
              transaction_type: o.transaction_type,
              variety: o.variety,
              product: o.product,
              order_type: o.order_type,
              quantity: o.quantity,
              price: o.price,
            })),
          );
          this.lastMarginSource = "kite_basket";
          return { ...res, source: "kite_basket" as const };
        }
        return this.dhanBasketMargin(orders);
      },
    };
  }

  /**
   * Dhan basket margin for the four box legs.
   *
   * PREFERS the MULTI-ORDER calculator (`POST /margincalculator/multi`). A box is
   * margined as a BASKET: the offsetting legs earn a hedge benefit that is most of the
   * point of the structure, and summing four standalone margins ignores it entirely —
   * which can over-state the requirement several-fold and make the dashboard's margin
   * figures useless for comparison.
   *
   * All four orders go in one request carrying their REAL BUY/SELL direction and the
   * `MARGIN` (carry-forward) product; sending them one-directionally would defeat the
   * hedge recognition this call exists for.
   *
   * FALLBACK, clearly labelled: if the multi endpoint genuinely fails, the per-leg sum
   * is used and tagged `dhan_per_leg_fallback`. That is a conservative UPPER bound, so
   * a failed multi call can never produce an UNDERSTATED figure — the direction of the
   * error matters, and understating margin is the one outcome worth avoiding.
   */
  private async dhanBasketMargin(orders: BoxMarginOrder[]): Promise<BoxBasketMargin> {
    await this.dhanInstruments.load().catch(() => undefined);
    const bySymbol = new Map<string, DhanInstrument>();
    for (const inst of this.dhanInstruments.instruments) {
      bySymbol.set(`${inst.exchange}:${inst.tradingsymbol}`, inst);
    }

    // Resolve every leg first. A partially resolved basket must NOT be sent: the
    // hedge benefit of three legs is not the hedge benefit of four, and quietly
    // margining a subset would understate the requirement.
    const legs: {
      exchangeSegment: DhanExchangeSegment;
      transactionType: "BUY" | "SELL";
      quantity: number;
      productType: "MARGIN";
      securityId: string;
      price: number;
    }[] = [];
    for (const order of orders) {
      const inst = bySymbol.get(`${order.exchange}:${order.tradingsymbol}`);
      const segment = inst?.dhan_segment ?? dhanSegmentFor(order.exchange);
      if (!inst || !segment) continue;
      legs.push({
        exchangeSegment: segment,
        transactionType: order.transaction_type,
        quantity: order.quantity,
        // Carry-forward, matching what the Box actually trades. INTRADAY would be
        // margined differently AND auto-squared-off.
        productType: "MARGIN",
        securityId: String(inst.dhan_security_id),
        // Dhan prices each leg from THIS field; unlike Kite's basket endpoint there is
        // no `order_type`, so a MARKET order's price is not resolved server-side from
        // the LTP. Prefer the real per-leg price the caller supplies, fall back to the
        // order price, and only then to a nominal non-zero value — Dhan rejects a zero
        // price outright, so the last resort exists to keep the basket call alive rather
        // than to be accurate.
        price: pickLegPrice(order),
      });
    }
    if (legs.length === 0) {
      return { initial: 0, final: 0, total: 0, source: "unavailable" };
    }

    const allResolved = legs.length === orders.length;

    // ---- preferred path: one hedge-aware multi-order request ----
    if (allResolved) {
      try {
        const raw = await this.dhanClient.calculateMultiMargin(legs, {
          // The figure must describe THIS basket. Netting against held positions would
          // make the entry-time figure differ from the backfill figure for the same box,
          // and for an already-open box the incremental requirement can collapse toward
          // zero — which `normalizeDhanMultiMargin` rejects, pushing us straight back
          // into the inflated per-leg sum.
          includePosition: false,
          includeOrder: false,
        });
        const normalized = normalizeDhanMultiMargin(raw);
        if (normalized) {
          this.lastMarginSource = "dhan_multi";
          return {
            initial: Math.round(normalized.span ?? 0),
            final: Math.round(normalized.total),
            total: Math.round(normalized.total),
            source: "dhan_multi",
            hedge_benefit: normalized.hedgeBenefit,
            span: normalized.span,
            exposure: normalized.exposure,
          };
        }
        // Name the fields Dhan actually returned. The previous log said only that the
        // fallback had fired, which made a renamed field indistinguishable from an
        // outage — and the resulting over-statement looks plausible, so nothing else
        // draws attention to it.
        console.warn(
          "[Dhan] multi-order margin returned no readable total — falling back to the " +
            `per-leg sum, which OVER-STATES a hedged box. Response fields: ${describeDhanMarginPayload(raw)}`,
        );
      } catch (err) {
        console.warn(
          "[Dhan] multi-order margin failed — falling back to the per-leg sum, which " +
            "OVER-STATES a hedged box:",
          err,
        );
      }
    } else {
      console.warn(
        `[Dhan] only ${legs.length}/${orders.length} basket legs resolved to a security id — ` +
          "using the conservative per-leg sum rather than margining a partial basket.",
      );
    }

    // ---- fallback: sum standalone legs. Conservative by construction. ----
    let total = 0;
    let span = 0;
    let priced = 0;
    for (const leg of legs) {
      try {
        const res = await this.dhanClient.calculateMargin(leg);
        total += Number(res.totalMargin) || 0;
        span += Number(res.spanMargin) || 0;
        priced++;
      } catch (err) {
        console.warn(`[Dhan] per-leg margin failed for securityId ${leg.securityId}:`, err);
      }
    }
    if (priced === 0) {
      // Nothing priced at all. Report UNAVAILABLE rather than ₹0, so the dashboard
      // counts it as unknown instead of treating the box as margin-free.
      this.lastMarginSource = "unavailable";
      return { initial: 0, final: 0, total: 0, source: "unavailable" };
    }
    this.lastMarginSource = "dhan_per_leg_fallback";
    return {
      initial: Math.round(span),
      final: Math.round(total),
      total: Math.round(total),
      source: "dhan_per_leg_fallback",
      // No hedge benefit is recognised in this path — that is precisely why it is a
      // fallback, and stating null is more honest than implying zero benefit exists.
      hedge_benefit: null,
      span,
      exposure: null,
    };
  }

  /**
   * Build the LIVE execution adapter for the active broker.
   *
   * REFUSES to build an adapter for a broker that is not active — that is the
   * structural half of the single-broker rule. It would otherwise be possible to
   * hold a Dhan adapter during a Zerodha session and place orders at the wrong venue.
   */
  createLiveAdapter(ctx: { broker: BrokerId; cfg: BoxConfig; timing?: ExecutionTimingRecorder }): BrokerAdapter {
    if (ctx.broker !== this.active) {
      throw new Error(
        `[Box] refusing to build a ${ctx.broker} execution adapter while ${this.active} is the active broker.`,
      );
    }
    if (ctx.broker === "zerodha") {
      return createZerodhaLiveAdapter(this.deps.kite, ctx.cfg, ctx.timing, this.rateBudgetFor("zerodha"));
    }
    if (!this.dhanLiveTradingEnabled()) {
      throw new Error(
        "[Box] Dhan live execution blocked: set DHAN_LIVE_TRADING_ENABLED=true to permit real Dhan orders.",
      );
    }
    return new DhanBrokerAdapter(
      this.dhanClient,
      dhanAdapterConfigFromBoxConfig(ctx.cfg, {
        staticIpReady: () => this.dhanStaticIpReady(),
        dhanClientId: () => this.dhanSessionMeta?.clientId ?? process.env.DHAN_CLIENT_ID?.trim() ?? "",
        identify: (token) => this.dhanInstruments.identify(token),
        ...(ctx.timing ? { timing: ctx.timing } : {}),
        rateBudget: this.rateBudgetFor("dhan"),
      }),
    );
  }

  /**
   * The ONE shared order-rate budget for `broker`'s account, created on first use and reused.
   *
   * Shared across every adapter/consumer this manager builds for the broker so the budget tracks
   * the ACCOUNT, not an adapter instance. Uses the published, frozen {@link brokerRateLimits} and
   * the default budget policy (one worker, 20% recovery reserve); a multi-worker deployment must
   * set the policy from config here (see docs/BROKER_LIMITS.md).
   */
  rateBudgetFor(broker: BrokerId): RateBudgetLedger {
    let ledger = this.rateBudgets.get(broker);
    if (!ledger) {
      ledger = new RateBudgetLedger(brokerRateLimits(broker));
      this.rateBudgets.set(broker, ledger);
    }
    return ledger;
  }

  /** The active broker's charge calculator (Dhan's own rate card when Dhan is active). */
  dhanChargeCalculator(): DhanChargeCalculator {
    return this.dhanCharges;
  }

  /** Instruments for the active broker, in the internal shape. */
  async instruments(): Promise<Instrument[]> {
    if (this.active === "zerodha") return [];
    const rows = await this.dhanInstruments.load();
    return rows;
  }

  get dhanInstrumentStore(): DhanInstrumentStore {
    return this.dhanInstruments;
  }

  get dhan(): DhanClient {
    return this.dhanClient;
  }

  /* ------------------------------- the feed ------------------------------ */

  /** The Dhan feed, constructed lazily so a Zerodha-only deployment never makes one. */
  private ensureDhanFeed(): DhanFeed {
    if (!this.dhanFeed) {
      this.dhanFeed = new DhanFeed({
        accessToken: () => this.usableDhanToken(),
        clientId: () => this.dhanSessionMeta?.clientId ?? process.env.DHAN_CLIENT_ID?.trim() ?? "",
        onTicks: (ticks) => this.deps.onDhanTicks(ticks),
        onConnection: (connected) => {
          this.dhanProblems = this.computeDhanProblems();
          this.deps.onDhanConnection?.(connected);
          this.hooks?.publish();
        },
        onSessionLost: (reason) => void this.onDhanSessionLost(reason),
        resolve: (token) => this.dhanInstruments.identify(token),
        depthLevel: 5,
      });
    }
    return this.dhanFeed;
  }

  /**
   * The STRATEGY's token set, declared as a whole.
   *
   * Routed through the coordinator so the Box engine's window can move without
   * unsubscribing a token a browser or another consumer still needs.
   */
  subscribeTokens(tokens: number[]): void {
    if (tokens.length === 0) return;
    this.subscriptions.acquire("strategy", tokens);
  }

  unsubscribeTokens(tokens: number[]): void {
    // The strategy releases by re-declaring its set; see setStrategyTokens. Kept for
    // the existing BoxFeedProvider contract.
    if (tokens.length === 0) return;
    this.unsubscribeUpstream(
      "futures",
      tokens.filter((t) => {
        const counts = this.subscriptions.countsFor(t);
        // Only reach upstream for tokens nothing else wants.
        return counts === null || counts.total === 0;
      }),
    );
  }

  /** Replace the strategy's entire token set in one diff. */
  setStrategyTokens(tokens: number[]): void {
    this.subscriptions.setOwnerTokens("strategy", tokens);
  }

  /** Acquire a BROWSER lease (one per SSE client). Returns a release function. */
  acquireBrowserTokens(tokens: number[]): () => void {
    return this.subscriptions.acquire("browser", tokens).release;
  }

  feedConnected(): boolean {
    return this.active === "zerodha"
      ? this.deps.tickerHub.isConnected()
      : (this.dhanFeed?.isConnected() ?? false);
  }

  /** Tokens the coordinator wants upstream — the honest subscription count. */
  subscribedCount(): number {
    return this.subscriptions.size;
  }

  /**
   * What the ACTIVE broker's socket has been asked for vs what it has confirmed.
   *
   * `wanted` and `subscribed` are reported separately because the gap between them is
   * a distinct, diagnosable fault: demand reached the feed but the subscribe frame did
   * not go out (or was rejected). Collapsing them into one number makes that
   * indistinguishable from "nobody asked for anything", which is the ambiguity that
   * made the blank board so hard to localise.
   */
  upstreamFeedStats(): {
    broker: BrokerId;
    wanted: number | null;
    subscribed: number | null;
    socket_connected: boolean;
    last_tick_at: number | null;
  } {
    if (this.active === "dhan") {
      const feed = this.dhanFeed;
      return {
        broker: "dhan",
        // null, not 0: "no feed object yet" is not the same as "wants nothing".
        wanted: feed ? feed.wantedCount() : null,
        subscribed: feed ? feed.subscribedCount() : null,
        socket_connected: feed?.isConnected() ?? false,
        last_tick_at: feed ? feed.lastTickAtMs() : null,
      };
    }
    return {
      broker: "zerodha",
      wanted: this.deps.tickerHub.subscribedCount(),
      subscribed: this.deps.tickerHub.subscribedCount(),
      socket_connected: this.deps.tickerHub.isConnected(),
      last_tick_at: this.lastTickAt,
    };
  }

  /** Truthful feed health: connection AND subscriptions AND data arrival. */
  feedHealth(): FeedHealth {
    const session = this.sessionFor(this.active);
    const universe = this.instrumentProvider.size();
    return computeFeedHealth({
      connected: this.feedConnected(),
      connecting: this.transitioning,
      authenticated:
        session.authenticated && (this.active === "zerodha" || this.dhanDataEnabled()),
      subscribed: this.subscriptions.size,
      universe: universe > 0 ? universe : null,
      lastTickAt: this.lastTickAt,
    });
  }

  /** Start the ACTIVE broker's feed. Never starts the inactive one. */
  startActiveFeed(): void {
    if (this.active === "dhan") this.ensureDhanFeed().ensureSocket();
    // Zerodha's hub connects lazily on subscribe/retain, so there is nothing to do.
  }

  /**
   * Stop BOTH brokers' feeds, for process shutdown.
   *
   * Stops both rather than just the active one: a switch earlier in the process's life
   * can leave the previous broker's socket closed but its object present, and at exit
   * there is no reason to reason about which. Both `stop()` methods are idempotent.
   *
   * DOES NOT touch positions, place orders, or alter persisted state — it closes sockets
   * and drops in-memory books. Subscriptions are deliberately NOT reset here: the
   * coordinator's table is meaningless once the process ends, and clearing it would
   * issue pointless unsubscribes against sockets that are already gone.
   */
  stopFeeds(): void {
    // BOTH lanes of BOTH brokers. A switch earlier in the process's life can leave the
    // previous broker's objects present, and at exit there is no reason to reason about
    // which — every stop() is idempotent.
    this.stopAllLanes();
  }

  /* ------------------------------ switching ------------------------------ */

  /**
   * Everything that would make a switch unsafe.
   *
   * Deliberately reports ALL blockers, not the first: an operator who has to clear
   * three things should see three, not discover them one 409 at a time.
   */
  async switchBlockers(target: BrokerId): Promise<SwitchBlocker[]> {
    const blockers: SwitchBlocker[] = [];
    if (target === "dhan") {
      const creds = readDhanCredentials();
      if (!creds.ok) blockers.push({ reason: "broker_not_configured", detail: creds.reason });
    }
    const probe = this.probe;
    if (!probe) return blockers;

    if (probe.scannerRunning()) {
      blockers.push({
        reason: "scanner_running",
        detail: "The Box scanner is running. Press STOP before changing broker.",
      });
    }
    const openCount = probe.openPositionCount();
    if (openCount > 0) {
      const brokers = probe.brokersWithOpenPositions().join(", ");
      blockers.push({
        reason: "open_box_positions",
        detail: `${openCount} open Box position(s) (${brokers}). Close, flatten or delete them first.`,
      });
    }
    const working = probe.workingOrderCount();
    if (working > 0) {
      blockers.push({
        reason: "working_orders",
        detail: `${working} broker order(s) still working. Cancel them before changing broker.`,
      });
    }
    if (probe.executionInFlight()) {
      blockers.push({
        reason: "execution_in_flight",
        detail: "An entry or exit is in flight. Wait for it to finish.",
      });
    }
    if (!probe.reconciliationComplete()) {
      blockers.push({
        reason: "unresolved_reconciliation",
        detail: "Broker reconciliation is incomplete. Run reconcile and resolve it first.",
      });
    }
    const residual = probe.residualLegCount();
    if (residual > 0) {
      blockers.push({
        reason: "residual_exposure",
        detail: `${residual} residual leg(s) of exposure outstanding. Flatten them first.`,
      });
    }
    const unknown = probe.unknownOrderCount();
    if (unknown > 0) {
      blockers.push({
        reason: "unknown_order_state",
        detail: `${unknown} order(s) are in an unknown state. Reconcile before changing broker.`,
      });
    }
    // Unresolved intents on the broker we are LEAVING can only ever be reconciled
    // through that broker, and after the switch its adapter is gone.
    const leaving = this.active;
    if (leaving !== target) {
      const outstanding = await probe.unresolvedIntentsFor(leaving).catch(() => 0);
      if (outstanding > 0) {
        blockers.push({
          reason: "foreign_unresolved_intents",
          detail:
            `${outstanding} unresolved ${leaving} order intent(s) remain. They can only be reconciled ` +
            `through ${leaving}, so resolve them before switching to ${target}.`,
        });
      }
    }
    return blockers;
  }

  /**
   * Switch the active broker, or refuse.
   *
   * THE ORDER OF OPERATIONS IS THE SAFETY PROPERTY. The old broker is fully torn
   * down — scanner stopped, feed stopped, subscriptions dropped, books invalidated —
   * BEFORE `this.active` moves, and the new feed is only started afterwards. There is
   * therefore no instant at which two feeds could both drive a Box decision, and no
   * way for a book produced by one broker to price a decision for the other.
   */
  async switchBroker(
    target: BrokerId,
    actor: string,
  ): Promise<{ ok: true; broker: BrokerId } | { ok: false; blockers: SwitchBlocker[] }> {
    if (target === this.active) {
      // Idempotent: re-selecting the current broker is a no-op success, so a repeated
      // admin verify does not error.
      return { ok: true, broker: this.active };
    }
    const blockers = await this.switchBlockers(target);
    if (blockers.length > 0) return { ok: false, blockers };

    const previous = this.active;
    const hooks = this.hooks;
    this.transitioning = true;
    console.log(`[Broker] switch ${previous} -> ${target} requested by ${actor}`);

    try {
      // 1. stop discovery on the outgoing broker (also prevents new execution)
      hooks?.stopScanner();
      console.log("[Broker] scanner stopped");

      // 2 + 3. stop BOTH LANES of the outgoing broker and DROP their subscriptions and
      //    books. Both, unconditionally: leaving the Box lane's socket open would keep
      //    streaming old-namespace option strikes into a session that no longer owns
      //    them, which is precisely the leak this transition exists to prevent. The Kite
      //    hub clears `subscribed` and `latest` on stop, and each lane feed forgets its
      //    own token set.
      this.stopAllLanes();
      console.log(`[Broker] ${previous} feeds stopped (futures + box lanes)`);

      // 4. drop every token registration IN BOTH LANES. NOT translated: a Kite token has
      //    no Dhan counterpart even when the integers coincide, so carrying either table
      //    across would be the exact namespace leak this transition exists to prevent.
      const dropped = this.subscriptions.resetForBrokerSwitch();
      const droppedBox = this.boxSubscriptions.resetForBrokerSwitch();
      console.log(
        `[Broker] ${dropped.droppedTokens} futures + ${droppedBox.droppedTokens} box ` +
          `subscription(s) cleared (${dropped.droppedLeases + droppedBox.droppedLeases} lease(s))`,
      );
      // Browser stream sessions hold token lists in the OLD namespace, so they die here
      // too. Their owners get a 409 and refetch the board.
      const droppedSessions = hooks?.dropMarketDataSessions?.() ?? 0;
      if (droppedSessions > 0) {
        console.log(`[Broker] ${droppedSessions} browser stream session(s) invalidated`);
      }

      // 5. invalidate every market-data book/cache, and both instrument universes
      if (previous === "dhan") this.dhanInstruments.clear();
      this.instrumentProvider.invalidate();
      this.lastTickAt = null;
      hooks?.invalidateBooks();
      // Contract reservations are broker-namespaced, so they die here too — alongside
      // the books, and for the same reason. Awaited: the durable tier is a database
      // write and must land before the new broker's feed can produce a candidate.
      // A failure is logged and tolerated; the reservations then lapse by TTL instead.
      if (hooks?.clearInstrumentReservations) {
        try {
          await hooks.clearInstrumentReservations();
          console.log("[Broker] contract reservations cleared");
        } catch (err) {
          console.warn("[Broker] failed to clear contract reservations (they will expire by TTL):", err);
        }
      }
      console.log(`[Broker] quote generation ${this.gen} invalidated`);

      // 6. THE SWITCH. Nothing before this could touch the new broker, and nothing
      //    after it can touch the old one. The generation bump makes every surviving
      //    reference to an old book identifiable as stale.
      //
      //    Advance the DURABLE generation FIRST, then adopt broker and generation
      //    TOGETHER. Assigning `this.active` before awaiting the persist would leave a
      //    window in which a durable reservation could be stamped with the new broker and
      //    the OLD generation — a pair that never legitimately existed, and therefore one
      //    that no later verification could interpret correctly.
      const persisted = await saveActiveBroker(target, actor).catch((err) => {
        console.warn("[Broker] failed to persist the active broker:", err);
        return null;
      });
      // If persistence is unavailable the counter must still move, or a reservation taken
      // before the switch would verify as current.
      const nextGen = persisted !== null ? Math.max(this.gen + 1, persisted.generation) : this.gen + 1;
      this.active = target;
      this.gen = nextGen;
      console.log(`[Broker] active=${target} generation=${this.gen}`);

      // 7. load the NEW broker's universe BEFORE anything can ask for a token in it
      try {
        if (target === "dhan") {
          await this.dhanInstruments.load(true);
          // Verify the whitelist now, so trading_ready is truthful the moment the
          // switch completes rather than at the first order attempt.
          await this.verifyDhanStaticIp().catch(() => undefined);
        }
        await this.instrumentProvider.load(true);
      } catch (err) {
        console.warn(`[Broker] switched to ${target} but the universe load failed:`, err);
      }

      // 8. rebuild the strategy's instrument set against the NEW token namespace
      try {
        await hooks?.reloadUniverse();
      } catch (err) {
        console.warn(`[Broker] universe rebuild after switch to ${target} failed:`, err);
      }

      // 9. start ONLY the new broker's feed
      this.startActiveFeed();
      console.log(`[Broker] ${target} feed started`);
    } finally {
      this.transitioning = false;
    }

    this.dhanProblems = this.computeDhanProblems();
    // 10. publish fresh runtime state so every open tab refetches its board.
    hooks?.publish();

    console.log(`[Broker] active broker switched ${previous} → ${target} by ${actor}.`);
    return { ok: true, broker: target };
  }

  /** Diagnostics for the status endpoints. */
  snapshot(): {
    broker: BrokerId;
    session: BrokerSessionState;
    health: BrokerHealthState;
    dhan_configured: boolean;
    dhan_instruments: number;
    dhan_instruments_loaded_at: number | null;
    dhan_static_ip: ReturnType<ActiveBrokerManager["dhanStaticIpState"]>;
    last_margin_source: BoxMarginSource | null;
    generation: number;
    feed: FeedHealth;
    subscriptions: ReturnType<SubscriptionCoordinator["stats"]>;
    instruments: number;
    instruments_loaded_at: number | null;
  } {
    return {
      broker: this.active,
      session: this.activeSession(),
      health: this.activeHealth(),
      dhan_configured: readDhanCredentials().ok,
      dhan_instruments: this.dhanInstruments.size,
      dhan_instruments_loaded_at: this.dhanInstruments.lastLoadedAt,
      dhan_static_ip: this.dhanStaticIpState(),
      /** Which margin calculation produced the most recent figure. */
      last_margin_source: this.lastMarginSource,
      generation: this.gen,
      feed: this.feedHealth(),
      subscriptions: this.subscriptions.stats(),
      instruments: this.instrumentProvider.size(),
      instruments_loaded_at: this.instrumentProvider.loadedAt(),
    };
  }
}

export { dhanInternalToken };
