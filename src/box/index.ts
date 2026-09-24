/**
 * Box arbitrage module — the single entry point index.ts talks to.
 *
 * The whole module is wired by dependency injection so it can reuse the
 * application's broker session, shared WebSocket, instrument cache and charge
 * estimator WITHOUT index.ts having to export its internals or the box code
 * having to import from it (which would be a circular import).
 *
 * BROKER NEUTRALITY
 * This file is the seam. `registerBoxModule` still accepts the concrete
 * `KiteClient` that index.ts owns, but it ADAPTS it into the broker-neutral
 * `BoxMarketDataProvider` / `BoxMarginProvider` / `BoxLiveAdapterFactory` that
 * BoxEngine consumes (see brokerContext.ts). The engine therefore cannot name a
 * venue, and a second broker is wired by supplying different implementations of
 * those three interfaces rather than by touching the strategy.
 *
 * Paper execution remains the default. Live broker access is constructed only
 * behind the independent execution-mode and live-trading gates; all broker
 * mutations then pass through the durable central order manager.
 */

import type { Express, RequestHandler } from "express";
import type { Instrument, KiteClient } from "../kite.js";
import type { TickerHub } from "../hub.js";
import type { BrokerId } from "../brokers/types.js";
import { BoxEngine } from "./engine.js";
import type { BoxEngineDeps } from "./engine.js";
import type { PriceChargeGroupsFn } from "./charges.js";
import type {
  BoxChargeCalculatorLike,
  BoxFeedProvider,
  BoxLiveAdapterFactory,
  BoxMarginProvider,
  BoxMarketDataProvider,
} from "./brokerContext.js";
import { validateSession } from "../access/sessionStore.js";
import { LocalChargeCalculator } from "./localCharges.js";
import type { BoxBoardItem } from "./instruments.js";
import { registerBoxRoutes } from "./routes.js";

export interface BoxModuleDeps {
  /**
   * The Zerodha client. Still concrete here because index.ts owns it; it is
   * adapted to the neutral provider interfaces below before the engine sees it.
   */
  kite: KiteClient;
  tickerHub: TickerHub;
  /** The shared, cached instrument dump. */
  getAllInstruments: () => Promise<Instrument[]>;
  /** The F&O board (underlying → spot token), reused for the box universe. */
  getBoard: () => Promise<BoxBoardItem[]>;
  /** The EXISTING calendar charge estimator, injected unchanged. */
  priceChargeGroups: PriceChargeGroupsFn;
  istDayKey: (at?: number) => string;
  makeIdResolver: (all: Instrument[]) => (token: number) => string | null;
  /** NSE equity-derivatives hours, reused from the calendar engine. */
  isMarketOpen: () => boolean;
  /** Basket-margin API, reused unchanged from the calendar engine. */
  getBasketMargin: (
    orders: {
      exchange: string;
      tradingsymbol: string;
      transaction_type: "BUY" | "SELL";
      variety: string;
      product: string;
      order_type: string;
      quantity: number;
      price: number;
    }[],
  ) => Promise<{
    initial: number;
    final: number;
    total: number;
    /**
     * PRESENCE flags, when the caller's client tracks them (`src/kite.ts` does).
     *
     * Optional so an older injector still compiles, but when supplied they are AUTHORITATIVE:
     * Zerodha returns `0` for a block it did not send, and treating that 0 as an established
     * requirement is defect B's Zerodha-shaped twin. Absent flags are treated conservatively as
     * "value present" only because this legacy path is Zerodha-only and its caller does supply
     * them; see the mapping in `mountBox`.
     */
    initial_available?: boolean;
    final_available?: boolean;
    total_basis?: "final" | "initial" | "unavailable";
  }>;
  /**
   * The site-passcode gate. In the predecessor codebase this was `requireAdmin`, a header/query
   * admin-token middleware; in this backend it is `requireOperator`, which validates
   * an HttpOnly session cookie against PostgreSQL. The `RequestHandler` shape is
   * identical, which is why the Box routes needed only an import change.
   */
  requireOperator: RequestHandler;
  /**
   * Resolves the operator role from the request that `requireOperator` already
   * validated. Reads the REQUEST, not a query-string token — which is precisely
   * what stops the SSE stream being authenticated by a token in the URL.
   */
  getOperatorRole: (req: Parameters<RequestHandler>[0]) => "full" | "trade" | null;
  /**
   * Is a session token still live? Optional; when omitted, `validateSession` is used.
   *
   * Only the SSE stream needs it, and it needs it because a stream authenticates ONCE and then lives
   * for hours — see the header of `streamSession.ts`. It must REJECT (not resolve false) when the
   * session store is unreachable, so "revoked" and "could not ask" stay distinguishable.
   */
  isSessionLive?: (sessionToken: string) => Promise<boolean>;

  /* ------------------------- broker-neutral overrides ------------------------ */

  /**
   * Which broker currently owns the feed, the scanner and execution.
   *
   * Defaults to a constant "zerodha" so existing wiring (and every existing test)
   * behaves exactly as before. The ActiveBrokerManager supplies the real reader.
   */
  activeBroker?: () => BrokerId;
  /**
   * The broker GENERATION, bumped on every switch and persisted so it never repeats.
   *
   * Stamped onto every durable instrument reservation. Defaults to 0 when absent, which
   * keeps existing wiring and every existing test behaving exactly as before.
   */
  brokerGeneration?: () => number;
  /**
   * A NON-SECRET reference to the broker account currently authenticated — a masked user id or a
   * hash, never a token. Used to bind funds/margin evidence to the account it was read for, so a
   * token rotation onto a DIFFERENT account mid-read invalidates the evidence instead of admitting
   * an entry against the wrong account. Absent ⇒ null ⇒ the account half of the check is skipped
   * (unknown is never treated as a mismatch), preserving existing wiring exactly.
   */
  brokerAccountRef?: () => string | null;
  /**
   * Overrides the market-data provider. When absent, one is adapted from `kite`,
   * preserving current Zerodha behaviour bit for bit.
   */
  marketData?: BoxMarketDataProvider;
  /** Overrides the margin provider. When absent, adapted from `getBasketMargin`. */
  margins?: BoxMarginProvider;
  /**
   * Overrides the live feed. When absent the Kite ticker hub is used directly,
   * preserving current behaviour for a Zerodha-only deployment.
   */
  feed?: BoxFeedProvider;
  /**
   * Overrides the charge calculator. When absent the Zerodha local calculator is
   * used — the existing behaviour, bit for bit.
   */
  charges?: BoxChargeCalculatorLike;
  /**
   * Builds the live order adapter for the active broker.
   *
   * Required for `BOX_EXECUTION_MODE=live`: the engine no longer knows how to
   * construct one, and refuses to start live without it.
   */
  createLiveAdapter?: BoxLiveAdapterFactory;
  /** Builds the Dhan dedicated order-update feed for the active broker (registry-owned socket). */
  createDhanOrderFeed?: BoxEngineDeps["createDhanOrderFeed"];
}

export interface BoxModule {
  /** Adopt open positions and start the (always-on) position monitor. */
  boot: () => Promise<void>;
  engine: BoxEngine;
}

/**
 * Adapt the Zerodha client to the neutral market-data interface.
 *
 * Deliberately thin: `getQuoteFull` already returns the exact fields the engine
 * reads, and `getAccessToken() !== null` is exactly the authentication predicate
 * it used before. Nothing about Zerodha's behaviour changes.
 */
function kiteMarketData(kite: KiteClient): BoxMarketDataProvider {
  return {
    isAuthenticated: () => kite.getAccessToken() !== null,
    getQuoteFull: (identifiers) => kite.getQuoteFull(identifiers),
  };
}

/**
 * Register the box module: routes now, background work on boot().
 *
 * Returns a handle whose `boot()` should be called once the database connection
 * is up, so any box left open by a previous process is adopted and monitored
 * again immediately.
 */
export function registerBoxModule(app: Express, deps: BoxModuleDeps): BoxModule {
  const engine = new BoxEngine({
    marketData: deps.marketData ?? kiteMarketData(deps.kite),
    activeBroker: deps.activeBroker ?? (() => "zerodha" as const),
    ...(deps.brokerGeneration === undefined ? {} : { brokerGeneration: deps.brokerGeneration }),
    ...(deps.brokerAccountRef === undefined ? {} : { brokerAccountRef: deps.brokerAccountRef }),
    // The hub already satisfies BoxFeedProvider structurally, so a Zerodha-only
    // deployment needs no adapter at all.
    feed: deps.feed ?? deps.tickerHub,
    charges: deps.charges ?? new LocalChargeCalculator(),
    getAllInstruments: deps.getAllInstruments,
    getBoard: deps.getBoard,
    priceChargeGroups: deps.priceChargeGroups,
    istDayKey: deps.istDayKey,
    makeIdResolver: deps.makeIdResolver,
    isMarketOpen: deps.isMarketOpen,
    margins: deps.margins ?? {
      broker: "zerodha" as const,
      // The legacy Zerodha-only margin provider, used when no broker-aware provider is injected.
      // Mapped field-by-field onto the nullable/completeness contract rather than spread, so a
      // block Zerodha did not send stays UNKNOWN instead of arriving as a numeric ₹0.
      basketMargin: async (orders) => {
        const res = await deps.getBasketMargin(orders);
        const initialUsable = res.initial_available ?? true;
        const finalUsable = res.final_available ?? true;
        const totalUsable = (res.total_basis ?? "final") !== "unavailable";
        return {
          initial: initialUsable ? res.initial : null,
          final: finalUsable ? res.final : null,
          total: totalUsable ? res.total : null,
          source: "kite_basket" as const,
          complete: totalUsable,
          legs_requested: orders.length,
          legs_priced: totalUsable ? orders.length : 0,
          incomplete_reason: totalUsable
            ? null
            : "Zerodha's basket-margin response contained neither an `initial` nor a `final` total",
        };
      },
    },
    ...(deps.createLiveAdapter ? { createLiveAdapter: deps.createLiveAdapter } : {}),
    ...(deps.createDhanOrderFeed ? { createDhanOrderFeed: deps.createDhanOrderFeed } : {}),
  });

  registerBoxRoutes(app, {
    engine,
    requireOperator: deps.requireOperator,
    getOperatorRole: deps.getOperatorRole,
    // The default is the same authority every other route uses. `validateSession` returns null for a
    // revoked, expired or unknown session and THROWS when PostgreSQL cannot answer, and that difference
    // is preserved here deliberately: the stream sentry treats the two differently.
    isSessionLive: deps.isSessionLive ?? (async (token: string) => (await validateSession(token)) !== null),
  });

  return {
    boot: () => engine.boot(),
    engine,
  };
}

export { BoxEngine };
export type { BoxBoardItem };
