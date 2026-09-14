/**
 * INTEGRATION HARNESS for the live entry path.
 *
 * Deliberately NOT a mock of the gateway or the manager. It wires the REAL
 *
 *     CentralBoxExecutionGateway → BoxOrderManager → broker adapter → durable persistence
 *
 * so that a test which observes "zero POSTs" is observing the real five-checkpoint guard, the real
 * priority queue, the real durable CREATED/SUBMITTING transitions and the real
 * `local_pre_submit_refusal` terminalization — not a stub that agreed with the assertion.
 *
 * The only fakes are the two genuine process boundaries: the HTTP broker (an adapter that records
 * every POST instead of sending one) and Mongo (an in-memory store that models the guarded write,
 * including the expected-state CAS the safety argument depends on).
 */

import { CentralBoxExecutionGateway, checkedFeedBlockReason } from "../../dist/box/executionGateway.js";
import { BoxOrderManager } from "../../dist/box/orderManager.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { entrySideFor } from "../../dist/box/math.js";
import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { candidatesFor, cfg, chain, exitQuotes, seedStore } from "./helpers.mjs";

export const NOW = 10_000;
const clone = (value) => structuredClone(value);

const IMMUTABLE = [
  "broker_mode", "trade_id", "attempt_id", "role", "purpose", "phase",
  "exchange", "tradingsymbol", "token", "side", "quantity",
  "reference_price", "tick_size", "max_chase_ticks", "limit_price",
];

/** In-memory stand-in for the Mongo intent collection, including the expected-state CAS. */
export class MemoryPersistence {
  constructor() {
    this.rows = new Map();
    this.events = [];
  }
  async create(intent) {
    this.events.push(["create", intent.client_order_id, intent.state]);
    const current = this.rows.get(intent.client_order_id);
    if (current) {
      for (const key of IMMUTABLE) {
        if (current[key] !== intent[key]) throw new Error(`immutable mismatch: ${key}`);
      }
      return clone(current);
    }
    this.rows.set(intent.client_order_id, clone(intent));
    return clone(intent);
  }
  async update(clientOrderId, patch, audit, expectedStates) {
    const current = this.rows.get(clientOrderId);
    this.events.push(["update", clientOrderId, patch.state ?? current?.state]);
    if (!current) {
      return { intent: null, applied: false, previous_filled_quantity: null, current_filled_quantity: null };
    }
    // THE CAS. A refused transition must report `applied: false` so the manager falls through to
    // `resolveConcurrentSubmissionOwner` rather than overwriting another actor's broker result.
    if (expectedStates && !expectedStates.includes(current.state)) {
      return {
        intent: clone(current),
        applied: false,
        previous_filled_quantity: current.filled_quantity,
        current_filled_quantity: current.filled_quantity,
      };
    }
    if (patch.filled_quantity !== undefined && patch.filled_quantity < current.filled_quantity) {
      return {
        intent: clone(current),
        applied: false,
        previous_filled_quantity: current.filled_quantity,
        current_filled_quantity: current.filled_quantity,
      };
    }
    const next = { ...current, ...clone(patch), previous_filled_quantity: current.filled_quantity };
    if (!next.audit.some((item) => item.audit_id === audit.audit_id)) next.audit = [...next.audit, clone(audit)];
    this.rows.set(clientOrderId, next);
    return {
      intent: clone(next),
      applied: true,
      previous_filled_quantity: current.filled_quantity,
      current_filled_quantity: next.filled_quantity,
    };
  }
  async loadNonterminal() {
    return [...this.rows.values()]
      .filter((intent) => !["COMPLETE", "CANCELLED", "REJECTED"].includes(intent.state))
      .map(clone);
  }
  async loadOwned() { return [...this.rows.values()].map(clone); }
  async findByClientId(id) { return this.rows.has(id) ? clone(this.rows.get(id)) : null; }
  async findByBrokerId(id) {
    const found = [...this.rows.values()].find((intent) => intent.broker_order_id === id);
    return found ? clone(found) : null;
  }
}

export function brokerOrderFor(req, filled = req.quantity, state) {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: `B-${req.client_order_id}`,
    tag: req.tag ?? null,
    role: req.role,
    trade_id: req.trade_id,
    attempt_id: req.attempt_id,
    purpose: req.purpose,
    phase: req.phase,
    exchange: req.exchange,
    tradingsymbol: req.tradingsymbol,
    token: req.token,
    side: req.side,
    quantity: req.quantity,
    pricing: { ...req.pricing },
    limit_price: req.pricing.limit_price,
    state: state ?? (filled >= req.quantity ? "COMPLETE" : "PARTIALLY_FILLED"),
    filled_quantity: filled,
    pending_quantity: Math.max(0, req.quantity - filled),
    average_price: filled > 0 ? req.pricing.reference_price : null,
    fills: filled > 0
      ? [{ fill_id: `f-${req.client_order_id}-${filled}`, quantity: filled, price: req.pricing.reference_price, at: NOW + 50 }]
      : [],
    reject_family: null,
    reject_reason: null,
    created_at: NOW,
    updated_at: NOW + 50,
  };
}

/**
 * A broker adapter that RECORDS instead of transmitting.
 *
 * `posts` is appended inside `submitOrder` only AFTER `beforePost()` has returned without
 * throwing, which is exactly the real HTTP boundary. A refusal at the final checkpoint therefore
 * leaves `posts` untouched — that is what makes "zero POSTs" a meaningful assertion.
 */
export function recordingAdapter(options = {}) {
  const posts = [];
  const cancels = [];
  const orders = new Map();
  const adapter = {
    mode: "live",
    posts,
    cancels,
    orders,
    prepareOrder: (req) => ({ ...req, pricing: { ...req.pricing }, tag: req.tag ?? `TAG${req.role}` }),
    submitOrder: async (req, beforePost) => {
      // Models adapter-side pacing: the window in which ownership can be lost, entry disarmed or
      // the breaker tripped while this leg waits its turn to be transmitted.
      await options.duringPacing?.(req, adapter);
      beforePost?.();
      posts.push({ role: req.role, side: req.side, client_order_id: req.client_order_id, purpose: req.purpose, quantity: req.quantity });
      const result = options.submit ? await options.submit(req, adapter) : brokerOrderFor(req);
      if (result) orders.set(req.client_order_id, clone(result));
      return clone(result);
    },
    cancelOrder: async (id) => { cancels.push(id); return orders.get(id); },
    getOrder: async (id) => (orders.has(id) ? clone(orders.get(id)) : undefined),
    listOrders: async () => [...orders.values()].map(clone),
    listPositions: async () => clone(options.positions ?? []),
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: NOW }),
    adoptOrder: async (intent, snapshot) => ({ ...clone(snapshot), client_order_id: intent.client_order_id }),
  };
  return adapter;
}

const limits = (overrides = {}) => ({
  maxOpenBoxes: 10,
  maxConcurrentExecutions: 1,
  maxResidualLegs: 10,
  dailyLossLimit: 1_000_000,
  rejectLimit: 100,
  consecutiveFailureLimit: 100,
  maxOpenLegQuantity: 1_000,
  maxGrossOpenLegQuantity: 10_000,
  reconcileIntervalMs: 60_000,
  feedReconnectWarmupMs: 0,
  maxBoxCapitalRupees: 0,
  ...overrides,
});

/** The qualifying candidate for a chosen direction, from the standard 7-strike window. */
export function candidateFor(direction) {
  const c = chain();
  const window = [19700, 19800, 19900, 20000, 20100, 20200, 20300];
  const all = candidatesFor(window, c, { directions: [direction] });
  const found = all.find(
    (x) => x.lower_strike === 19900 && x.upper_strike === 20100 && (x.direction ?? "LONG_BOX") === direction,
  );
  if (!found) throw new Error(`fixture: no ${direction} candidate`);
  return found;
}

/** Detection legs priced from the seeded book, on the ENTRY side of each role. */
export function detectionFor(candidate, quotes) {
  return {
    candidate,
    at: NOW,
    legs: BOX_LEG_ROLES.map((role) => {
      const leg = candidate.legs[role];
      const q = quotes.get(leg.token);
      const side = entrySideFor(role, candidate.direction ?? "LONG_BOX");
      const price = side === "BUY" ? q.asks[0].price : q.bids[0].price;
      return {
        role, side, token: leg.token,
        tradingsymbol: leg.tradingsymbol,
        strike: leg.strike,
        instrument_type: leg.instrument_type,
        price,
        qty_at_touch: candidate.lot_size,
        bid: q.bids[0].price, bid_qty: q.bids[0].quantity,
        ask: q.asks[0].price, ask_qty: q.asks[0].quantity,
        quote_at: q.at, exchange_at: null, quote_version: q.version, depth: null,
        age_ms: 0, fresh: true, executable: true,
      };
    }),
    entry_net_debit_per_unit: 20,
    entry_box_cost_per_unit: 20,
    gross_edge_per_unit: 80,
    gross_edge: 4_000,
    tradable: true,
    depth_ok: true,
    worst_age_ms: 0,
    quote_version: 1,
    reject: null,
  };
}

/**
 * Build the full live stack for one direction.
 *
 * @param direction        "LONG_BOX" | "SHORT_BOX"
 * @param adapterOptions   hooks for the recording adapter (`duringPacing`, `submit`)
 * @param limitOverrides   order-manager limits (e.g. entrySubmitConcurrency)
 * @param config           BoxConfig overrides
 */
export async function liveStack({
  direction = "LONG_BOX",
  adapterOptions = {},
  limitOverrides = {},
  config = {},
  /**
   * The gateway's clock. Defaults to the fixed `NOW` used by most tests; a test that needs time to
   * MOVE (for example to let cross-leg dispersion deteriorate while a leg sits in adapter pacing)
   * passes a mutable one.
   */
  clock: gatewayClock = { now: () => NOW },
  /**
   * Feed warmth per token. Defaults to "every token is warm", which is what an entry test wants.
   *
   * A test that must reproduce a PARTIALLY AVAILABLE book passes a mutable predicate (or flips a
   * shared flag after the entry) so exactly one leg looks unusable to `precheck`. This is the first
   * of `precheck`'s four refusal conditions and the cheapest one to steer, so it stands in for
   * "this leg has no current executable depth" without disturbing the other three legs' books.
   */
  isTokenWarm = () => true,
  /**
   * Wire the manager's CHECKPOINT 3 / CHECKPOINT 5 current-feed re-validation, exactly as
   * src/box/engine.ts does.
   *
   * OPT-IN, and default OFF, deliberately. `checkedFeedBlockReason` fails CLOSED on a missing
   * stamp, and several existing tests call `manager.submit(request)` directly with no stamp as a
   * shortcut to exercise the manager's own gating (priority, ownership, breaker). Production never
   * does that — every live submit path stamps its request via `precheck` first — so switching this
   * on by default would make those tests fail for a reason they are not about. A test that wants to
   * assert send-boundary behaviour turns it on.
   */
  feedRevalidation = false,
  /**
   * Durable persistence. Defaults to the in-memory CAS model for fast unit coverage; the MongoDB
   * integration suite injects the PRODUCTION `boxOrderIntentPersistence` here, so the very same
   * gateway/manager wiring runs against the real Mongoose model and the real update pipeline.
   */
  persistence: injectedPersistence,
} = {}) {
  const candidate = candidateFor(direction);
  const quotes = new BoxQuoteStore();
  // Deep two-sided books so the depth precheck admits all four bounded LIMIT legs.
  seedStore(quotes, exitQuotes(candidate, 198, { at: NOW, qty: 100_000 }), NOW);

  const persistence = injectedPersistence ?? new MemoryPersistence();
  const adapter = recordingAdapter(adapterOptions);
  const violations = [];
  let clock = NOW;
  const FEED_GENERATION = 7;
  // The resolved config, hoisted so the manager's send-boundary validator and the gateway share
  // exactly one set of feed thresholds — as they do in production.
  const boxCfg = cfg({
    executionMode: "live",
    liveTradingEnabled: true,
    queueModel: "none",
    liveMaxChaseTicks: 2,
    legMaxChaseTicks: 2,
    unwindMaxChaseTicks: 5,
    ...config,
  });
  const manager = new BoxOrderManager({
    adapter,
    persistence,
    limits: limits(limitOverrides),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => clock++ },
    istDayKey: () => "2026-09-02",
    // CHECKPOINT 3 (at dequeue) and CHECKPOINT 5 (immediately pre-POST), wired EXACTLY as
    // src/box/engine.ts wires them. Without this the manager's `checkedFeedBlockReason` returns
    // null and the harness silently omits the final send-boundary authority — so a test asserting
    // "the feed died while this leg was queued and it was refused" would be measuring nothing.
    ...(feedRevalidation
      ? {
        revalidateQueuedRequest: (request, stamp) => checkedFeedBlockReason({
          request,
          stamp,
          currentGeneration: FEED_GENERATION,
          tokenCurrent: isTokenWarm(request.token),
          quote: quotes.get(request.token),
          now: gatewayClock.now(),
          quoteMaxAgeMs: boxCfg.quoteMaxAgeMs,
          queueModel: boxCfg.queueModel,
          queueLiquidityHaircutPct: boxCfg.queueLiquidityHaircutPct,
        }),
      }
      : {}),
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);
  await manager.reconcile();

  const originalViolation = manager.invariantViolation.bind(manager);
  manager.invariantViolation = (reason) => { violations.push(reason); return originalViolation(reason); };

  const gateway = new CentralBoxExecutionGateway({
    cfg: boxCfg,
    simulator: {
      hasCapacity: () => false,
      estimateExecutableExit: () => [],
      simulateLeggingEntry: async () => { throw new Error("live must not reach the paper simulator"); },
    },
    quotes,
    manager,
    broker: () => "zerodha",
    allocateTradeId: () => "trade-live-1",
    isTokenWarm: (token) => isTokenWarm(token),
    feedGeneration: () => FEED_GENERATION,
    now: () => gatewayClock.now(),
    chargeTotal: () => 0,
  });

  return { candidate, quotes, gateway, manager, adapter, persistence, violations, clock: gatewayClock };
}

/** Run one live entry attempt through the real gateway. */
export function runEntry(stack, { stillWanted, qualify } = {}) {
  return stack.gateway.simulateLeggingEntry({
    candidate: stack.candidate,
    detection: detectionFor(stack.candidate, stack.quotes),
    ...(stillWanted ? { stillWanted } : {}),
    qualify: qualify ?? (() => ({ qualifies: true, expected_net_profit: 5_000, min_expected_net_profit: 1_200 })),
  });
}

/** Every ENTRY POST that actually reached the (recording) broker, in transmission order. */
export function entryPosts(adapter) {
  return adapter.posts.filter((post) => post.purpose === "ENTRY");
}
