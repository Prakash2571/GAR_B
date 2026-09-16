import type { LegExecutor } from "./legExecutor.js";
import type { ExecutionEvidenceQuality } from "./brokerExecutionEvidence.js";
import type {
  BoxLegRole,
  BoxOptionInstrument,
  BoxOrderIntentState,
  BoxOrderPhase,
  BoxOrderPurpose,
  IBoxOrderIntent,
  OrderSide,
  PaperLegExecution,
  ResidualLegExposure,
} from "./types.js";

export type BrokerAdapterMode = "paper" | "live";
export type BrokerOrderState = BoxOrderIntentState;

export const BROKER_ORDER_STATES: readonly BrokerOrderState[] = [
  "CREATED",
  "SUBMITTING",
  "ACKNOWLEDGED",
  "OPEN",
  "PARTIALLY_FILLED",
  "COMPLETE",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "REJECTED",
  "UNKNOWN",
  "RECONCILIATION_REQUIRED",
] as const;

export type BrokerRejectFamily =
  | "margin"
  | "price_band"
  | "instrument_unavailable"
  | "market_closed"
  | "rate_limit"
  | "rms"
  | "quantity_freeze"
  | "auth"
  | "generic";

export interface BrokerFill {
  /** Stable broker trade id, or a deterministic synthetic identity for paper. */
  fill_id: string;
  quantity: number;
  /**
   * Executed price, or NULL when the broker confirmed the quantity but has not published a price.
   *
   * Nullable deliberately. The Dhan projection used to synthesize `price: 0` for a confirmed fill
   * whose `averageTradedPrice` was absent, which is fabricated P&L rather than absent data — a
   * listed option cannot trade at zero. Consumers must skip a null price rather than arithmetic it.
   * See brokerExecutionEvidence.ts.
   */
  price: number | null;
  at: number;
}

export interface BrokerLimitPricing {
  order_type: "LIMIT";
  reference_price: number;
  tick_size: number;
  max_chase_ticks: number;
  limit_price: number;
}

/** Broker-neutral, LIMIT-only order request. */
export interface BrokerOrderRequest {
  /** Stable across retries/restarts, e.g. BOX:<trade>:ENTRY:k1_ce:attempt-1. */
  client_order_id: string;
  role: BoxLegRole;
  trade_id: string | null;
  attempt_id: string;
  purpose: BoxOrderPurpose;
  phase: BoxOrderPhase;
  exchange: string;
  tradingsymbol: string;
  token: number;
  side: OrderSide;
  quantity: number;
  /** Explicit bounded marketable-LIMIT envelope; market orders are not representable. */
  pricing: BrokerLimitPricing;
  /** Optional broker tag. Live adapters should derive a bounded stable tag if absent. */
  tag?: string;
  /** Paper-only deterministic execution evidence. Ignored by live adapters. */
  paper?: {
    instrument: BoxOptionInstrument;
    detected_price: number | null;
    detected_qty: number;
    submit_at: number;
    latency_ms?: number;
  };
}

export interface BrokerOrder {
  client_order_id: string;
  broker_order_id: string | null;
  tag: string | null;
  role: BoxLegRole;
  trade_id: string | null;
  attempt_id: string;
  purpose: BoxOrderPurpose;
  phase: BoxOrderPhase;
  exchange: string;
  tradingsymbol: string;
  token: number;
  side: OrderSide;
  quantity: number;
  pricing: BrokerLimitPricing;
  limit_price: number;
  state: BrokerOrderState;
  filled_quantity: number;
  pending_quantity: number;
  average_price: number | null;
  fills: BrokerFill[];
  /**
   * WHICH execution fields the broker actually supplied for this snapshot.
   *
   * Optional because paper and locally-constructed orders have nothing to disclaim. When a live
   * adapter sets it, it is the nameable reason an order's accounting is or is not final; see
   * brokerExecutionEvidence.ts and `executionAccountingComplete`.
   */
  execution_evidence?: ExecutionEvidenceQuality;
  reject_family: BrokerRejectFamily | null;
  reject_reason: string | null;
  /**
   * OUR clock when this order was first observed. Local, monotonic-ish, comparable with our own times.
   */
  created_at: number;
  /**
   * OUR clock when this snapshot was accepted. Local — NEVER the broker's own stamp.
   *
   * THE MIXED-CLOCK DEFECT THIS FIXES. `updated_at` used to be set from the broker's
   * `exchange_update_timestamp` when one was present and from our clock when it was not, so a SINGLE
   * FIELD carried two different clocks depending on the payload. `executionGateway.liveRecord` then
   * subtracted a LOCAL `detectedAt` from it to produce `decision_to_first_fill_ms` and friends, which
   * made those figures wrong by the host-to-exchange offset — and made `first_to_last_fill_ms`
   * subtract two values from different clocks, so it could come out NEGATIVE. Those are precisely the
   * numbers an operator would use to judge legging exposure, so they have to be internally consistent.
   *
   * The broker's own claim is preserved separately in {@link exchange_updated_at}. Nothing is lost;
   * the two are simply no longer conflated.
   */
  updated_at: number;
  /**
   * The EXCHANGE's own stamp for this update, or null when the broker published none.
   *
   * Second-resolution IST wall clock (see `brokerTimestamps.ts`). Useful for reconciling against the
   * broker's records and for exchange-relative spans, and NOT comparable with our local clock: the
   * host-to-exchange offset is unknown and the resolution is whole seconds. Kept separate so that a
   * caller has to choose deliberately which clock it is reasoning in.
   */
  exchange_updated_at?: number | null;
}

export interface BrokerPosition {
  token: number;
  exchange: string;
  tradingsymbol: string;
  /** Positive = long, negative = short. */
  net_quantity: number;
  average_price: number;
}

export interface BrokerMargin {
  available: number | null;
  utilised: number | null;
}

export interface BrokerHealth {
  ok: boolean;
  transport: "up" | "down" | "disabled" | "unknown";
  authenticated: boolean;
  message: string | null;
  checked_at: number;
}

export interface BrokerModifyRequest {
  limit_price: number;
  quantity?: number;
}

/**
 * One-shot local guard invoked after adapter pacing and immediately before the
 * remote placement mutation. Throwing proves that no broker POST was attempted.
 */
export type BeforeBrokerPost = () => void;

/**
 * Where a local, proven no-POST refusal was taken.
 *
 * `post_persist` sits between the durable CREATED → SUBMITTING writes and the transport call: the
 * identity is durably spent but nothing has been transmitted. It is distinct from `pre_post`
 * (inside the adapter callback, after pacing) because the two answer different questions after the
 * fact — "did we stop before even queuing for transport" versus "did we stop after waiting in
 * pacing" — and an operator reading the intent audit needs to tell them apart.
 */
export type BrokerPreSubmitStage = "dequeue" | "post_persist" | "pre_post";

/**
 * A local authority check refused an order before any broker mutation.
 *
 * Sources: the current-feed/depth authority, and the composed live ENTRY ownership guard
 * (see liveEntryGuard.ts). Either way the contract is the same and is the whole point of the
 * type — NO BROKER POST WAS ATTEMPTED. It is therefore never a broker rejection and never
 * ambiguous. The durable identity is terminally spent once OrderManager surfaces this error.
 */
export class BrokerPreSubmitRefusedError extends Error {
  constructor(
    readonly clientOrderId: string,
    readonly stage: BrokerPreSubmitStage,
    readonly durableIdentitySpent: boolean,
    readonly reason: string,
  ) {
    super(`Local pre-submit refusal at ${stage}: ${reason}`);
    this.name = "BrokerPreSubmitRefusedError";
  }
}

/**
 * ONE authoritative order observation arriving from OUTSIDE the adapter's own REST calls.
 *
 * In practice: a broker order-update websocket event (Zerodha postback text frame on the quote
 * socket, Dhan `order_alert` on its dedicated order socket). The shape is deliberately the same
 * broker-neutral triple every observation path already produces — CUMULATIVE quantity, average
 * price, verbatim status — because a second SHAPE would become a second TRUTH.
 *
 * `clientOrderId` is resolved by the projection BEFORE this reaches an adapter, so an adapter never
 * has to decide ownership: by the time it is called, the event has already been attributed to a
 * registered box leg on the right account.
 */
export interface ExternalOrderUpdate {
  readonly clientOrderId: string;
  readonly brokerOrderId?: string | null;
  /** Broker CUMULATIVE filled quantity after this event. Never a delta. */
  readonly cumulativeQty: number;
  readonly averagePrice?: number | null;
  /** The broker's own status string, verbatim. Mapped by the adapter that owns that vocabulary. */
  readonly rawStatus?: string | null;
  readonly observedAtWall?: number | null;
}

/** Async broker boundary: all remote-capable reads are promises. */
export interface BrokerAdapter {
  readonly mode: BrokerAdapterMode;
  /** Pure preparation hook (for example stable bounded broker tags); no transport calls. */
  prepareOrder?(req: BrokerOrderRequest): BrokerOrderRequest;
  submitOrder(req: BrokerOrderRequest, beforePost?: BeforeBrokerPost): Promise<BrokerOrder>;
  cancelOrder(clientOrderId: string): Promise<BrokerOrder | undefined>;
  modifyOrder?(clientOrderId: string, request: BrokerModifyRequest): Promise<BrokerOrder>;
  getOrder(clientOrderId: string): Promise<BrokerOrder | undefined>;
  listOrders(): Promise<BrokerOrder[]>;
  listPositions(): Promise<BrokerPosition[]>;
  /** Hydrate session-local client↔broker identity after durable restart reconciliation. */
  adoptOrder?(
    intent: IBoxOrderIntent,
    snapshot: BrokerOrder,
  ): Promise<BrokerOrder>;
  margins?(): Promise<BrokerMargin | null>;
  health?(): Promise<BrokerHealth>;
  /**
   * Apply ONE already-attributed external order observation to this adapter's session state.
   *
   * THE POINT OF THIS SEAM. Without it a broker order-update stream can only ever change a status
   * label: the adapter's own `waitForResolution` poll loop is what an order waiter is actually
   * blocked on, so an event that never reaches the adapter cannot make a fill arrive sooner. With
   * it, a stream event updates the same session snapshot the poll loop reads AND wakes that loop,
   * so the waiter resolves on the stream rather than on the next REST interval.
   *
   * CONTRACT:
   *   - the observation has ALREADY been attributed (ownership, account) by the projection;
   *   - the adapter re-validates the EVIDENCE exactly as it does for a REST snapshot
   *     (brokerExecutionEvidence.ts) — a stream is a faster source, never a more trusted one;
   *   - cumulative quantity is MONOTONIC: a lower figure is discarded, never applied;
   *   - it returns the merged snapshot, or undefined when the order is unknown to this session.
   *
   * Optional so the paper adapter and every existing test are unchanged.
   */
  applyOrderUpdate?(update: ExternalOrderUpdate): BrokerOrder | undefined;

  /**
   * THE ACCOUNT BEHIND THE CREDENTIAL THIS ADAPTER WOULD USE RIGHT NOW, or null when unproven.
   *
   * WHY THIS IS ON THE ADAPTER AND NOT READ FROM THE SESSION. Until this existed, the only identity
   * an adapter exposed was `mode` ("live" / "paper"), and the manager's idea of "the current
   * account" came from a completely separate provider threaded down from the broker registry. Those
   * two can disagree, and the window in which they disagree is precisely the dangerous one: a
   * re-login installs a replacement credential SYNCHRONOUSLY, then awaits session persistence and
   * resets feeds. An order authorised a moment before that install would be transmitted on the new
   * account's credential while every other signal still described the old one.
   *
   * Asking the adapter closes that gap, because the adapter resolves its credential from the same
   * object that answers this question. A guard can therefore compare the account an order was
   * STAMPED with against the account whose credential is about to sign it.
   *
   * Optional: paper adapters and existing tests have no credential to describe, and `undefined`
   * (like a null return) means "cannot prove", which callers must never read as "matches".
   */
  dispatchAccount?(): string | null;
}

/**
 * A submission whose outcome at the broker is UNKNOWN. The order may or may not exist.
 *
 * WHY `Error.cause` IS SET AS WELL AS `causeValue`. This class stored the underlying error only in
 * its own `causeValue` property and called `super(message)` with no options bag, so `.cause` stayed
 * undefined. Meanwhile the code that has to recover the HTTP status from inside the wrapper —
 * `findKiteHttpError` — walked the standard `.cause` chain. The two never met, so a rate-limited
 * placement (which is CORRECTLY wrapped as ambiguous, because a 429'd POST may still have reached
 * the exchange) reported no status at all: `Retry-After: 30` produced zero penalty and zero
 * cooldown, and the next request walked straight back into a budget the broker had just told us to
 * back off from.
 *
 * `causeValue` is retained because it is load-bearing elsewhere in the tree and is part of this
 * repo's error convention; `cause` is now populated with the same value so standard traversal —
 * including Node's own error formatting and `--test` diff output — can see it too. They are always
 * the same object, never two different causes.
 */
export class BrokerAmbiguousSubmitError extends Error {
  readonly clientOrderId: string;
  readonly causeValue: unknown;
  readonly order: BrokerOrder | undefined;

  constructor(
    clientOrderId: string,
    message: string,
    causeValue?: unknown,
    order?: BrokerOrder,
  ) {
    super(message, { cause: causeValue });
    this.name = "BrokerAmbiguousSubmitError";
    this.clientOrderId = clientOrderId;
    this.causeValue = causeValue;
    this.order = order;
  }
}

export class BrokerOrderRejectedError extends Error {
  constructor(
    readonly order: BrokerOrder,
    readonly causeValue?: unknown,
  ) {
    // As above: keep `causeValue` (the repo convention) and mirror it onto the standard `.cause`
    // so a nested transport error is reachable by ordinary cause-chain traversal.
    super(order.reject_reason ?? "Broker rejected order.", { cause: causeValue });
    this.name = "BrokerOrderRejectedError";
  }
}

export class BrokerDisabledError extends Error {
  constructor(message = "Live broker adapter is disabled.") {
    super(message);
    this.name = "BrokerDisabledError";
  }
}

/**
 * A cancellation that was NEVER TRANSMITTED — proven, not assumed.
 *
 * Raised only when the request was withdrawn while still queued behind broker pacing, so the
 * transport was never invoked. That makes it categorically different from
 * {@link BrokerAmbiguousSubmitError}: there is nothing to reconcile, because nothing was sent.
 *
 * WHAT A CALLER MUST CONCLUDE. The order is UNCHANGED and, if it was working before, it is working
 * still — the exposure has NOT been reduced. So this is a reason to try again (or to escalate),
 * never a reason to believe the order is gone. The two failure directions are not symmetric: wrongly
 * believing a cancel succeeded leaves live exposure that nobody is watching.
 */
/**
 * A cancellation whose OUTCOME COULD NOT BE ESTABLISHED — neither cancelled nor provably untouched.
 *
 * Raised when a durable, non-terminal intent cannot be acted on because the adapter has no session
 * knowledge of it and the identity could not be re-established by adoption. The order is very likely
 * still WORKING at the broker.
 *
 * WHY THIS IS AN ERROR AND NOT AN EMPTY SUCCESS. The adapter returns `undefined` for an unknown client
 * order id, and that used to be resolved as a no-op: the operator-facing sweep answered
 * `{ ok: true, eligible: 1, cancelled: [], failures: [] }` with HTTP 200 while making zero broker
 * calls. "I could not do this" and "there was nothing to do" are opposite facts, and only one of them
 * is safe to report as success. Surfacing it as a failure puts the intent in `failures`, which flips
 * `ok` to false and the route to 207, so a supervising operator sees an unresolved order instead of a
 * green tick.
 */
export class BrokerCancelUnresolvedError extends Error {
  /** Unknown — deliberately not `false`. Nothing was transmitted BY US, but the order may be live. */
  readonly transmitted = false;

  constructor(
    readonly clientOrderId: string,
    readonly brokerOrderId: string | null,
  ) {
    super(
      `Cancellation for ${clientOrderId}` +
        (brokerOrderId ? ` (broker order ${brokerOrderId})` : "") +
        " is UNRESOLVED: the order is durable and non-terminal but this session cannot act on it, and " +
        "its broker identity could not be re-established. No cancellation was sent and the order may " +
        "still be working. Reconcile, or cancel it broker-side.",
    );
    this.name = "BrokerCancelUnresolvedError";
  }
}

export class BrokerCancelNotTransmittedError extends Error {
  /** Always false, and proven by the transport queue rather than inferred from a timeout. */
  readonly transmitted = false;

  constructor(
    readonly clientOrderId: string,
    readonly brokerOrderId: string,
  ) {
    super(
      `The cancellation for ${clientOrderId} (broker order ${brokerOrderId}) exceeded its deadline while ` +
        "still queued behind broker pacing, so it was withdrawn and NO request was sent. The order is " +
        "unchanged and may still be working — cancellation must be retried.",
    );
    this.name = "BrokerCancelNotTransmittedError";
  }
}

export function isBrokerOrderTerminal(state: BrokerOrderState): boolean {
  return state === "COMPLETE" || state === "CANCELLED" || state === "REJECTED";
}

export function assertBoundedLimit(req: BrokerOrderRequest, configuredMaxChaseTicks?: number): void {
  if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
    throw new Error(`Invalid order quantity ${req.quantity}.`);
  }
  const pricing = req.pricing;
  if (
    pricing.order_type !== "LIMIT" ||
    !Number.isFinite(pricing.reference_price) || pricing.reference_price <= 0 ||
    !Number.isFinite(pricing.tick_size) || pricing.tick_size <= 0 ||
    !Number.isInteger(pricing.max_chase_ticks) || pricing.max_chase_ticks < 0 ||
    (configuredMaxChaseTicks !== undefined && pricing.max_chase_ticks > configuredMaxChaseTicks) ||
    !Number.isFinite(pricing.limit_price) || pricing.limit_price <= 0 || pricing.limit_price > 10_000_000
  ) {
    throw new Error("Invalid bounded LIMIT pricing envelope.");
  }
  const ticks = pricing.limit_price / pricing.tick_size;
  if (Math.abs(ticks - Math.round(ticks)) > 1e-7) {
    throw new Error(`LIMIT ${pricing.limit_price} is not aligned to tick size ${pricing.tick_size}.`);
  }
  const band = pricing.tick_size * pricing.max_chase_ticks;
  const tolerance = Math.max(1e-8, pricing.tick_size / 10_000);
  const lower = pricing.reference_price - band - tolerance;
  const upper = pricing.reference_price + band + tolerance;
  const correctlyDirected = req.side === "BUY"
    ? pricing.limit_price >= pricing.reference_price - tolerance && pricing.limit_price <= upper
    : pricing.limit_price <= pricing.reference_price + tolerance && pricing.limit_price >= lower;
  if (!correctlyDirected) {
    throw new Error(`LIMIT ${pricing.limit_price} exceeds the configured chase band.`);
  }
}

/** Stable strategy identity used by OrderManager and durable intents. */
export function boxClientOrderId(args: {
  tradeId: string;
  purpose: BoxOrderPurpose;
  role: BoxLegRole;
  attempt: number | string;
}): string {
  const attempt = typeof args.attempt === "number" ? `attempt-${args.attempt}` : String(args.attempt);
  return `BOX:${args.tradeId}:${args.purpose}:${args.role}:${attempt}`;
}

function paperState(status: PaperLegExecution["status"]): BrokerOrderState {
  switch (status) {
    case "CREATED": return "CREATED";
    case "SUBMITTED":
    case "IN_FLIGHT":
    // The broker has the order; nothing has executed. ACK IS NOT FILL.
    case "ACKNOWLEDGED": return "ACKNOWLEDGED";
    case "PENDING": return "OPEN";
    case "PARTIALLY_FILLED": return "PARTIALLY_FILLED";
    // A cancel is in flight but unconfirmed, so the order may still fill. The durable
    // vocabulary already permits CANCEL_REQUESTED -> COMPLETE for exactly this reason.
    case "CANCEL_REQUESTED": return "CANCEL_REQUESTED";
    case "FILLED":
    case "UNWOUND": return "COMPLETE";
    case "CANCELLED": return "CANCELLED";
    case "TIMED_OUT": return "CANCELLED";
    case "FAILED":
    case "UNWIND_FAILED": return "REJECTED";
    case "UNWINDING": return "OPEN";
  }
}

/**
 * Deterministic paper adapter. It executes exactly one request through the
 * existing LegExecutor, preserving its arrival, depth-walk, queue and timeout
 * semantics while presenting a broker-neutral async contract.
 */
export class PaperBrokerAdapter implements BrokerAdapter {
  readonly mode = "paper" as const;
  private readonly orders = new Map<string, BrokerOrder>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly deps: {
      executor: LegExecutor;
      now: () => number;
      defaultLatencyMs?: number;
    },
  ) {}

  async submitOrder(req: BrokerOrderRequest): Promise<BrokerOrder> {
    assertBoundedLimit(req);
    if (!req.paper) throw new Error("PaperBrokerAdapter requires deterministic paper evidence.");
    const existing = this.orders.get(req.client_order_id);
    if (existing) return cloneOrder(existing);

    const created = fromRequest(req, this.deps.now());
    created.state = "SUBMITTING";
    this.orders.set(req.client_order_id, created);

    const paper = req.paper;
    const latencyMs = paper.latency_ms ?? this.deps.defaultLatencyMs;
    const result = await this.deps.executor.run({
      requests: [{
        role: req.role,
        side: req.side,
        inst: paper.instrument,
        detected_price: paper.detected_price,
        detected_qty: paper.detected_qty,
        quantity: req.quantity,
        pricing: {
          order_type: "MARKETABLE_LIMIT",
          side: req.side,
          quantity: req.quantity,
          reference_price: req.pricing.reference_price,
          tick_size: req.pricing.tick_size,
          max_chase_ticks: req.pricing.max_chase_ticks,
          limit_price: req.pricing.limit_price,
        },
      }],
      submitAt: paper.submit_at,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      phase: req.phase === "unwind" ? "unwind" : "entry",
      // LegExecutor appends the role to its internal paper order id. The broker-
      // neutral client id remains exactly `req.client_order_id` in our projection.
      orderIdPrefix: req.client_order_id,
      abortReason: () => this.cancelled.has(req.client_order_id)
        ? { reason: "discovery_stopped", detail: "paper order cancelled by client" }
        : null,
    });
    const leg = result.legs[0];
    if (!leg) throw new Error(`LegExecutor returned no result for ${req.client_order_id}.`);
    const order = paperLegToBroker(req, leg, this.deps.now());
    this.orders.set(req.client_order_id, order);
    return cloneOrder(order);
  }

  async cancelOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    const current = this.orders.get(clientOrderId);
    if (!current) return undefined;
    if (!isBrokerOrderTerminal(current.state)) {
      this.cancelled.add(clientOrderId);
      current.state = "CANCEL_REQUESTED";
      current.updated_at = this.deps.now();
    }
    return cloneOrder(current);
  }

  async getOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    const value = this.orders.get(clientOrderId);
    return value ? cloneOrder(value) : undefined;
  }

  async listOrders(): Promise<BrokerOrder[]> {
    return [...this.orders.values()].map(cloneOrder);
  }

  async listPositions(): Promise<BrokerPosition[]> {
    const positions = new Map<string, BrokerPosition>();
    const fills = [...this.orders.values()]
      .flatMap((order) => order.fills.map((fill) => ({ order, fill })))
      .sort((a, b) => a.fill.at - b.fill.at || a.fill.fill_id.localeCompare(b.fill.fill_id));

    for (const { order, fill } of fills) {
      const key = `${order.exchange}:${order.tradingsymbol}`;
      const delta = (order.side === "BUY" ? 1 : -1) * fill.quantity;
      const current = positions.get(key) ?? {
        token: order.token,
        exchange: order.exchange,
        tradingsymbol: order.tradingsymbol,
        net_quantity: 0,
        average_price: 0,
      };
      const prior = current.net_quantity;
      // An UNPRICED fill still moves the net quantity — exposure is exposure — but it cannot
      // contribute to a cost basis. Folding a null in as zero would understate the basis, which is
      // exactly the fabricated-accounting failure brokerExecutionEvidence.ts exists to prevent.
      const fillPrice = fill.price;
      if (prior === 0 || Math.sign(prior) === Math.sign(delta)) {
        const total = Math.abs(prior) + Math.abs(delta);
        current.average_price = fillPrice === null
          ? current.average_price
          : total === 0
            ? 0
            : ((Math.abs(prior) * current.average_price) + (Math.abs(delta) * fillPrice)) / total;
        current.net_quantity = prior + delta;
      } else if (Math.abs(delta) < Math.abs(prior)) {
        // A partial close realises P&L but does not rewrite the remaining lot's basis.
        current.net_quantity = prior + delta;
      } else if (Math.abs(delta) === Math.abs(prior)) {
        current.net_quantity = 0;
        current.average_price = 0;
      } else {
        // The close crossed through flat and opened exposure in the opposite direction.
        current.net_quantity = prior + delta;
        if (fillPrice !== null) current.average_price = fillPrice;
      }
      positions.set(key, current);
    }
    return [...positions.values()].filter((position) => position.net_quantity !== 0);
  }

  async health(): Promise<BrokerHealth> {
    return {
      ok: true,
      transport: "up",
      authenticated: true,
      message: null,
      checked_at: this.deps.now(),
    };
  }
}

function fromRequest(req: BrokerOrderRequest, now: number): BrokerOrder {
  return {
    client_order_id: req.client_order_id,
    broker_order_id: null,
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
    state: "CREATED",
    filled_quantity: 0,
    pending_quantity: req.quantity,
    average_price: null,
    fills: [],
    reject_family: null,
    reject_reason: null,
    created_at: now,
    updated_at: now,
  };
}

function paperLegToBroker(req: BrokerOrderRequest, leg: PaperLegExecution, now: number): BrokerOrder {
  const order = fromRequest(req, leg.submit_at || now);
  order.broker_order_id = leg.order_id;
  order.state = paperState(leg.status);
  order.filled_quantity = leg.fill_qty;
  order.pending_quantity = leg.remaining_qty;
  order.average_price = leg.average_fill_price;
  order.fills = leg.fills.map((fill, index) => ({
    fill_id: `paper:${leg.client_order_id}:${fill.quote_version ?? "na"}:${fill.at}:${index}`,
    quantity: fill.qty,
    price: fill.price,
    at: fill.at,
  }));
  order.reject_reason = leg.fail_reason;
  order.reject_family = leg.fail_reason ? "generic" : null;
  order.updated_at = leg.resolved_at ?? now;
  return order;
}

function cloneOrder(order: BrokerOrder): BrokerOrder {
  return {
    ...order,
    pricing: { ...order.pricing },
    fills: order.fills.map((fill) => ({ ...fill })),
  };
}

/**
 * Compatibility helper retained for existing simulator callers/tests.
 * Outstanding paper fill quantity remains computed exactly as before.
 */
export function residualFromLegs(legs: PaperLegExecution[], now: number): ResidualLegExposure[] {
  const out: ResidualLegExposure[] = [];
  for (const leg of legs) {
    const outstanding = leg.fill_qty - leg.unwound_qty;
    if (outstanding <= 0) continue;
    out.push({
      token: leg.token,
      tradingsymbol: leg.tradingsymbol,
      role: leg.role,
      side: leg.side,
      quantity: outstanding,
      average_price: leg.average_fill_price ?? leg.fill_price ?? 0,
      source: "partial_entry",
      created_at: now,
    });
  }
  return out;
}
