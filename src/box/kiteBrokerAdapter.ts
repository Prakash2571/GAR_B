import {
  BrokerAmbiguousSubmitError,
  BrokerDisabledError,
  BrokerOrderRejectedError,
  BrokerPreSubmitRefusedError,
  assertBoundedLimit,
  isBrokerOrderTerminal,
  type BrokerAdapter,
  type BeforeBrokerPost,
  type BrokerHealth,
  type BrokerMargin,
  type BrokerModifyRequest,
  type BrokerOrder,
  type BrokerOrderRequest,
  type BrokerOrderState,
  type BrokerPosition,
  type BrokerRejectFamily,
} from "./brokerAdapter.js";
import {
  type BrokerEndpointClass,
  type BrokerPacingClass,
  type EffectiveBrokerPacing,
  isRateLimited,
  parseRetryAfterMs,
  RateBudgetLedger,
  resolveBrokerPacing,
  TransportPacer,
  type TransportPacerStats,
} from "./brokerPacing.js";
import type { BoxConfig } from "./config.js";
import {
  evaluateExecutionEvidence,
  readNonNegativeInteger,
  readPositivePrice,
} from "./brokerExecutionEvidence.js";
import { cloneBrokerOrder, mergeBrokerOrderSnapshot, type BrokerOrderMergeOptions } from "./brokerOrderMerge.js";
import type { ExternalOrderUpdate } from "./brokerAdapter.js";
import type { ExecutionTimingRecorder } from "./executionTiming.js";
import type { ExecutionMode, IBoxOrderIntent, OrderSide } from "./types.js";

export interface KiteTransportOrder {
  order_id: string;
  status: string;
  exchange: string;
  tradingsymbol: string;
  transaction_type: OrderSide;
  quantity: number;
  filled_quantity: number;
  pending_quantity: number;
  average_price: number;
  price: number;
  tag: string | null;
  status_message: string | null;
  order_timestamp: string | null;
  exchange_update_timestamp: string | null;
}

export interface KiteTransportPosition {
  instrument_token?: number;
  exchange: string;
  tradingsymbol: string;
  quantity: number;
  average_price: number;
}

export interface KitePlaceOrderRequest {
  exchange: string;
  tradingsymbol: string;
  transaction_type: OrderSide;
  quantity: number;
  order_type: "LIMIT";
  product: "NRML";
  validity: "DAY";
  price: number;
  tag: string;
}

export interface KiteBrokerTransport {
  placeOrder(request: KitePlaceOrderRequest, opts?: { beforeSend?: () => void }): Promise<{ order_id: string }>;
  cancelOrder(orderId: string): Promise<void>;
  modifyOrder(orderId: string, request: { quantity?: number; price: number }): Promise<void>;
  getOrder(orderId: string): Promise<KiteTransportOrder | null>;
  listOrders(): Promise<KiteTransportOrder[]>;
  listPositions(): Promise<KiteTransportPosition[]>;
  margins?(): Promise<BrokerMargin | null>;
  health?(): Promise<BrokerHealth>;
}

export type KiteAccessTokenProvider = () => string | Promise<string>;

export class KiteHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "KiteHttpError";
  }
}

/**
 * Minimal bounded-timeout Kite Connect HTTP transport for regular NRML LIMIT
 * orders. It deliberately has no market-order API.
 */
export class KiteHttpTransport implements KiteBrokerTransport {
  constructor(
    private readonly config: {
      apiKey: string;
      accessToken: KiteAccessTokenProvider;
      timeoutMs: number;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  async placeOrder(request: KitePlaceOrderRequest, opts: { beforeSend?: () => void } = {}): Promise<{ order_id: string }> {
    try {
      const data = await this.request<{ order_id: string }>("POST", "/orders/regular", {
        exchange: request.exchange,
        tradingsymbol: request.tradingsymbol,
        transaction_type: request.transaction_type,
        quantity: request.quantity,
        order_type: request.order_type,
        product: request.product,
        validity: request.validity,
        price: request.price,
        tag: request.tag,
      }, true, opts.beforeSend);
      if (!data?.order_id) {
        throw new BrokerAmbiguousSubmitError(
          "transport-pending",
          "Kite place-order response omitted order_id; placement is ambiguous and requires reconciliation.",
        );
      }
      return data;
    } catch (error) {
      // A LOCAL REFUSAL (send guard threw) is a proven no-POST, never a broker outcome: it must
      // propagate untouched and never be wrapped as an ambiguous submission.
      if (error instanceof BrokerPreSubmitRefusedError) throw error;
      if (error instanceof BrokerAmbiguousSubmitError || isDefinitivePlacementRejection(error)) throw error;
      throw new BrokerAmbiguousSubmitError(
        "transport-pending",
        "Kite placement outcome is unknown; reconciliation is required before retry.",
        error,
      );
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request("DELETE", `/orders/regular/${encodeURIComponent(orderId)}`);
  }

  async modifyOrder(orderId: string, request: { quantity?: number; price: number }): Promise<void> {
    await this.request("PUT", `/orders/regular/${encodeURIComponent(orderId)}`, {
      order_type: "LIMIT",
      price: request.price,
      ...(request.quantity !== undefined ? { quantity: request.quantity } : {}),
    });
  }

  async getOrder(orderId: string): Promise<KiteTransportOrder | null> {
    const history = await this.request<KiteTransportOrder[]>(
      "GET",
      `/orders/${encodeURIComponent(orderId)}`,
    );
    return history.at(-1) ?? null;
  }

  async listOrders(): Promise<KiteTransportOrder[]> {
    return this.request<KiteTransportOrder[]>("GET", "/orders");
  }

  async listPositions(): Promise<KiteTransportPosition[]> {
    const data = await this.request<{ net?: KiteTransportPosition[] }>("GET", "/portfolio/positions");
    return data.net ?? [];
  }

  async margins(): Promise<BrokerMargin | null> {
    const data = await this.request<Record<string, unknown>>("GET", "/user/margins/equity");
    const available = numericPath(data, "available", "live_balance");
    const utilised = numericPath(data, "utilised", "debits");
    return { available, utilised };
  }

  async health(): Promise<BrokerHealth> {
    try {
      await this.request("GET", "/user/profile");
      return {
        ok: true,
        transport: "up",
        authenticated: true,
        message: null,
        checked_at: (this.config.now ?? Date.now)(),
      };
    } catch (error) {
      return {
        ok: false,
        transport: "down",
        authenticated: !(error instanceof KiteHttpError && (error.status === 401 || error.status === 403)),
        message: errorMessage(error),
        checked_at: (this.config.now ?? Date.now)(),
      };
    }
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, string | number>,
    ambiguousSubmit = false,
    beforeSend?: () => void,
  ): Promise<T> {
    // Resolve the token FIRST. It is the last thing that can suspend before the wire — in
    // production it is synchronous, but the type permits a promise, and a promise hop between
    // the entry guard and `fetch` is exactly the Defect-3 window this fix closes.
    const token = await this.config.accessToken();
    const controller = new AbortController();
    // A single deadline covers BOTH the network round trip AND the body read below (the timer
    // is cleared only in `finally`, after `response.json()`), so a stalled body cannot hang
    // unbounded. Uses setTimeout, which is unaffected by wall-clock steps.
    const timeout = setTimeout(() => controller.abort(), Math.max(250, this.config.timeoutMs));
    const fetchImpl = this.config.fetchImpl ?? fetch;
    try {
      const url = `${this.config.baseUrl ?? "https://api.kite.trade"}${path}`;
      const init = {
        method,
        headers: {
          "X-Kite-Version": "3",
          Authorization: `token ${this.config.apiKey}:${token}`,
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(body ? { body: new URLSearchParams(stringValues(body)).toString() } : {}),
        signal: controller.signal,
      };
      // FINAL SYNCHRONOUS SEND GUARD (Defect 3). LAST statement before `fetch`, AFTER the token
      // await, with NO further `await` until the network call itself. A throw here — a
      // BrokerPreSubmitRefusedError from the composed live-entry guard — proves that no HTTP
      // request was transmitted, so the refusal stays a proven local no-POST and never an
      // ambiguous broker submission. Only placement passes it; reads/cancels leave it undefined.
      beforeSend?.();
      const response = await fetchImpl(url, init);
      const payload = await response.json() as { data?: T; message?: string; error_type?: string };
      if (!response.ok) {
        throw new KiteHttpError(
          response.status,
          payload.message ?? payload.error_type ?? `Kite HTTP ${response.status}`,
          payload,
        );
      }
      return payload.data as T;
    } catch (error) {
      // A LOCAL REFUSAL is not a broker outcome: it must propagate untouched, never be dressed
      // up as an ambiguous submission (which would quarantine an order that was never sent).
      if (error instanceof BrokerPreSubmitRefusedError) throw error;
      if (ambiguousSubmit && !isDefinitivePlacementRejection(error)) {
        throw new BrokerAmbiguousSubmitError(
          "transport-pending",
          "Kite placement did not produce a definitive typed 4xx rejection; reconciliation is required.",
          error,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface KiteBrokerAdapterConfig {
  executionMode: ExecutionMode;
  enabled: boolean;
  /**
   * LIVE TIMING INSTRUMENTATION (Phase 2). Optional and FAIL-OPEN.
   *
   * The adapter marks the stages only IT can witness: transport start, the HTTP request leaving
   * the wire, the response, the broker order id, the ACK, each cumulative fill, and the cancel
   * request/acknowledgement. The OrderManager owns the queue stages and the terminal publish, and
   * both write to the same trace, keyed by client order id.
   *
   * The adapter never CREATES a trace: without the strategy identity a sample cannot be filed
   * under the right dimensions, so a mark for an unknown order is dropped rather than guessed at.
   */
  timing?: ExecutionTimingRecorder;
  ackTimeoutMs: number;
  workingTimeoutMs: number;
  partialTimeoutMs: number;
  cancelTimeoutMs: number;
  /**
   * GENERAL transport pacing: order-status polls, order lists, positions, margins, health.
   *
   * This is also the poll cadence in `waitForResolution` / `confirmTerminalAfterCancel`, and
   * its meaning is unchanged. ORDER MUTATIONS are paced separately — see {@link pacing}.
   */
  brokerMinIntervalMs: number;
  /**
   * The resolved order-mutation vs general pacing. Optional so an existing test that builds a
   * config literal keeps compiling; absent, it is derived from `brokerMinIntervalMs` and the
   * broker's published order limit.
   */
  pacing?: EffectiveBrokerPacing;
  /**
   * The SHARED, application-owned multi-window order budget for this broker ACCOUNT (Task 8).
   *
   * Optional so existing tests that build a config literal keep compiling; when absent the
   * adapter paces only per-second via {@link pacing} and enforces no longer window. When present
   * it MUST be the ONE ledger shared across every adapter/consumer on the same account (the
   * engine owns it), because the broker meters the account, not the adapter instance. The adapter
   * consults it at the final pre-wire boundary: an over-budget ENTRY placement is refused with a
   * proven no-POST {@link BrokerPreSubmitRefusedError} (no HTTP request leaves), while a
   * protective CANCEL/MODIFY spends the recovery reserve so a placement storm cannot starve it.
   */
  rateBudget?: RateBudgetLedger;
  maxModifications: number;
  maxChaseTicks: number;
}

export function kiteAdapterConfigFromBoxConfig(cfg: BoxConfig): KiteBrokerAdapterConfig {
  return {
    executionMode: cfg.executionMode,
    enabled: cfg.liveTradingEnabled,
    ackTimeoutMs: cfg.liveAckTimeoutMs,
    workingTimeoutMs: cfg.liveWorkingTimeoutMs,
    partialTimeoutMs: cfg.livePartialTimeoutMs,
    cancelTimeoutMs: cfg.liveCancelTimeoutMs,
    brokerMinIntervalMs: cfg.liveBrokerMinIntervalMs,
    pacing: resolveBrokerPacing("zerodha", cfg.liveBrokerMinIntervalMs, cfg.liveBrokerOrderMinIntervalMs),
    maxModifications: cfg.liveMaxModifications,
    maxChaseTicks: cfg.liveMaxChaseTicks,
  };
}

/** Map the broker-metered endpoint class onto the per-second pacing bucket. */
function pacingClassFor(klass: BrokerEndpointClass): BrokerPacingClass {
  return klass === "data_read" ? "general" : "order_mutation";
}

/**
 * Best-effort read of a `Retry-After` value from a Kite error body.
 *
 * Kite does not surface response headers on {@link KiteHttpError}, so we look for a Retry-After
 * hint the body may carry. Returns null when absent — the ledger then applies its own
 * conservative default cooldown rather than treating a missing hint as "retry now".
 */
function readRetryAfterHeader(body: unknown): string | null {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const raw = record["retry_after"] ?? record["Retry-After"] ?? record["retryAfter"];
    if (typeof raw === "string") return raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

/**
 * Live adapter with a double deployment gate. Every method checks the gate before
 * touching the injected transport, so disabled instances make exactly zero broker
 * calls (including reads, cancellation, modification, margins and health).
 */
export class KiteBrokerAdapter implements BrokerAdapter {
  readonly mode = "live" as const;
  private readonly orders = new Map<string, BrokerOrder>();
  private readonly clientByBroker = new Map<string, string>();
  private readonly modifications = new Map<string, number>();
  private readonly pacer: TransportPacer;

  constructor(
    private readonly transport: KiteBrokerTransport,
    private readonly config: KiteBrokerAdapterConfig,
    private readonly clock: {
      now: () => number;
      wait: (ms: number) => Promise<void>;
    } = {
      now: Date.now,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  ) {
    this.pacer = new TransportPacer(
      this.config.pacing ??
        resolveBrokerPacing("zerodha", this.config.brokerMinIntervalMs, 0),
      this.clock,
    );
  }

  /** The pacing actually in force, for diagnostics. Never a configured-but-unused value. */
  effectivePacing(): EffectiveBrokerPacing {
    return this.pacer.effective();
  }

  /** Observed pacing cost, for diagnostics. */
  pacingStats(): TransportPacerStats {
    return this.pacer.stats();
  }

  prepareOrder(req: BrokerOrderRequest): BrokerOrderRequest {
    return {
      ...req,
      pricing: { ...req.pricing },
      tag: stableKiteTag(req.client_order_id, req.tag),
    };
  }

  async submitOrder(req: BrokerOrderRequest, beforePost?: BeforeBrokerPost): Promise<BrokerOrder> {
    this.ensureEnabled();
    const prepared = this.prepareOrder(req);
    assertBoundedLimit(prepared, this.config.maxChaseTicks);
    req = prepared;
    const existing = this.orders.get(req.client_order_id);
    if (existing) return clone(existing);

    const order = requestOrder(req, this.clock.now());
    order.state = "SUBMITTING";
    order.tag = stableKiteTag(req.client_order_id, req.tag);
    this.orders.set(req.client_order_id, order);

    // TRANSPORT START: before `call()`, so the pacing wait is attributed to transport_wait_ms
    // rather than being hidden inside the POST duration.
    this.mark(req.client_order_id, "transport_started");
    let placed: { order_id: string };
    // The order-budget placement guard, resolved once so the SAME closure runs at the boundary.
    const placementGuard = this.placementBudgetGuard(req.client_order_id);
    // Fires at the FINAL SYNCHRONOUS instant before the wire (Defect 3): threaded THROUGH the
    // adapter pacer AND the transport's token-resolution await down to KiteHttpTransport.request,
    // where it runs immediately before `fetch` with no further await. Previously it ran inside
    // the pacer callback, leaving the token-await promise hop between the guard and the send — a
    // window in which entry could be disarmed while the POST was still on its way to the wire.
    const beforeSend = (): void => {
      beforePost?.();
      // ORDER BUDGET (Task 8): the FINAL pre-wire check. An over-budget placement throws
      // BrokerPreSubmitRefusedError here — before any HTTP request — and is recorded against the
      // shared account budget only when allowed. No-op when no ledger is wired.
      placementGuard();
      // HTTP REQUEST START: marked here because this is the true moment the POST leaves for the
      // network — post_to_http_response_ms then measures the broker, NOT our rate limiter.
      this.mark(req.client_order_id, "http_request_started");
    };
    try {
      // FAST REFUSAL: if the shared budget is ALREADY exhausted, refuse now — before the pacing
      // wait — so an over-budget entry does not sit through a pacing interval only to be refused
      // at the wire. Pure read (no record); the authoritative check+record still runs in
      // `beforeSend` at the send boundary, so budget is consumed only for a request that leaves.
      // A throw here is caught below and cleans up the session projection like any pre-submit
      // refusal.
      this.refusePlacementIfBudgetExhausted(req.client_order_id);
      placed = await this.call(() => {
        return this.transport.placeOrder({
          exchange: req.exchange,
          tradingsymbol: req.tradingsymbol,
          transaction_type: req.side,
          quantity: req.quantity,
          order_type: "LIMIT",
          product: "NRML",
          validity: "DAY",
          price: req.pricing.limit_price,
          tag: order.tag as string,
        }, { beforeSend });
      }, "order_place");
      this.mark(req.client_order_id, "http_response");
    } catch (error) {
      if (error instanceof BrokerPreSubmitRefusedError) {
        // No HTTP request started. Remove only the session-local projection so a
        // durable local REJECTED row cannot look like a working broker order.
        this.orders.delete(req.client_order_id);
        throw error;
      }
      // A 429 feeds the shared budget a cooldown (never a resend). Done before any classification
      // so the cooldown is recorded even on the ambiguous path below.
      this.penalizeIfRateLimited(error);
      // The response is an observable event whether it succeeded or failed. Recording it on the
      // failure path is what makes a timeout's duration measurable instead of invisible.
      this.mark(req.client_order_id, "http_response");
      if (error instanceof BrokerAmbiguousSubmitError || !isDefinitivePlacementRejection(error)) {
        // AMBIGUOUS TRANSPORT OUTCOME (audit divergence D6).
        //
        // The POST may have been accepted despite the failure: a timeout, a 5xx or a 429 tells
        // us nothing about whether the exchange received the order. Dhan already handled this
        // by looking the order up by correlation id; Kite did not, and instead quarantined
        // every ambiguous submit for the periodic reconciler — even though the stable tag makes
        // an immediate lookup possible.
        //
        // So: ASK THE BROKER. Never re-POST.
        const adopted = await this.reconcileByTag(req, order).catch(() => null);
        if (adopted) {
          // The order DOES exist. Carry on with its real state, exactly as Dhan does.
          return await this.resolveAdopted(req, adopted);
        }
        // Quarantine the LATEST accepted state, not the pre-POST object: a postback that landed
        // while the POST was in flight replaced the map entry, so mutating `order` here would mutate
        // an orphan and the thrown error would carry `filled 0` over a real fill.
        const quarantined = this.quarantine(req.client_order_id, order);
        throw new BrokerAmbiguousSubmitError(
          req.client_order_id,
          `${errorMessage(error)} (${describeAmbiguity(error)}; tag lookup did not uniquely identify an order, so reconciliation is required and NO retry was attempted)`,
          error,
          clone(quarantined),
        );
      }
      // A DEFINITIVE rejection, merged rather than written blind — the same treatment Dhan's
      // definitive-4xx path gets. If a fill was observed on the stream while the POST was in flight,
      // a bare REJECTED would erase real exposure; the merge routes that contradiction to
      // RECONCILIATION_REQUIRED instead of silently choosing one side.
      const rejected = this.commit(req.client_order_id, {
        ...cloneBrokerOrder(this.orders.get(req.client_order_id) ?? order),
        state: "REJECTED",
        reject_family: classifyKiteReject(error),
        reject_reason: errorMessage(error),
        updated_at: this.clock.now(),
      });
      throw new BrokerOrderRejectedError(clone(rejected), error);
    }

    // THE ACK-OVERWRITES-FILL WINDOW. `order` was created before the POST. A postback for this
    // client order id can legitimately land while the POST response is in flight, in which case the
    // map already holds a merged snapshot and mutating `order` would mutate an orphan. The ACK is
    // therefore committed THROUGH the map, and the resolution loop starts from the merged result.
    //
    // ACKNOWLEDGED is a WORKING state, so the merge cannot use it to rewind a stream-confirmed
    // terminal state, and it cannot lower a stream-confirmed cumulative quantity.
    const acknowledged = this.commit(req.client_order_id, {
      ...cloneBrokerOrder(order),
      broker_order_id: placed.order_id,
      state: "ACKNOWLEDGED",
      updated_at: this.clock.now(),
    });
    // BROKER ORDER ID + ACK. Two marks because they are two different facts: the id proves an
    // order EXISTS, and the ACK proves the broker ACCEPTED it. Neither proves any quantity
    // executed — see orderLifecycle.stageProvesExecution.
    this.mark(req.client_order_id, "broker_order_id");
    this.mark(req.client_order_id, "acknowledged");
    this.clientByBroker.set(placed.order_id, req.client_order_id);
    try {
      return await this.waitForResolution(acknowledged);
    } catch (error) {
      const quarantined = this.quarantine(req.client_order_id, acknowledged);
      throw new BrokerAmbiguousSubmitError(
        req.client_order_id,
        `Kite order ${placed.order_id} became uncertain while awaiting broker state; reconciliation is required.`,
        error,
        clone(quarantined),
      );
    }
  }

  async cancelOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    this.ensureEnabled();
    const order = this.orders.get(clientOrderId);
    if (!order) return undefined;
    if (isBrokerOrderTerminal(order.state)) return clone(order);
    if (!order.broker_order_id) {
      return clone(this.quarantine(clientOrderId, order));
    }
    const brokerOrderId = order.broker_order_id;
    // Written THROUGH the map rather than mutated in place: if a stream observation replaces the map
    // entry during the DELETE below, an in-place mutation would apply to a detached object and the
    // confirmation loop would then write that orphan lineage back over the merged fill.
    this.commit(clientOrderId, { ...cloneBrokerOrder(order), state: "CANCEL_REQUESTED", updated_at: this.clock.now() });
    // CANCEL REQUESTED. This opens cancel_request_to_terminal_ms — the measured span that sizes
    // paper's cancel-vs-fill race window. It is deliberately marked BEFORE the DELETE is sent,
    // because the race starts the moment we commit to cancelling.
    this.mark(clientOrderId, "cancel_requested");
    await withDeadline(
      this.call(() => this.transport.cancelOrder(brokerOrderId), "order_cancel"),
      this.config.cancelTimeoutMs,
      "Kite cancellation timed out; reconciliation is required.",
    ).catch((error) => {
      this.penalizeIfRateLimited(error);
      this.quarantine(clientOrderId, order);
      throw error;
    });
    // The broker accepted the cancel REQUEST. It is not yet a cancellation: the order may still
    // be filling right now, which is why confirmTerminalAfterCancel re-reads until terminal.
    this.mark(clientOrderId, "cancel_acknowledged");
    return clone(await this.confirmTerminalAfterCancel(clientOrderId));
  }

  async modifyOrder(clientOrderId: string, request: BrokerModifyRequest): Promise<BrokerOrder> {
    this.ensureEnabled();
    const order = this.orders.get(clientOrderId);
    if (!order?.broker_order_id) throw new Error(`Unknown broker order ${clientOrderId}.`);
    const quantity = request.quantity ?? order.quantity;
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > order.quantity) {
      throw new Error("Kite modification quantity must be a positive integer no larger than the original order.");
    }
    assertBoundedLimit({
      client_order_id: order.client_order_id,
      role: order.role,
      trade_id: order.trade_id,
      attempt_id: order.attempt_id,
      purpose: order.purpose,
      phase: order.phase,
      exchange: order.exchange,
      tradingsymbol: order.tradingsymbol,
      token: order.token,
      side: order.side,
      quantity,
      pricing: { ...order.pricing, limit_price: request.limit_price },
      ...(order.tag ? { tag: order.tag } : {}),
    }, this.config.maxChaseTicks);
    const count = this.modifications.get(clientOrderId) ?? 0;
    if (count >= this.config.maxModifications) throw new Error("Live order modification limit reached.");
    await this.call(() => this.transport.modifyOrder(order.broker_order_id as string, {
      price: request.limit_price,
      ...(request.quantity !== undefined ? { quantity: request.quantity } : {}),
    }), "order_modify");
    this.modifications.set(clientOrderId, count + 1);
    order.limit_price = request.limit_price;
    order.pricing = { ...order.pricing, limit_price: request.limit_price };
    order.quantity = quantity;
    order.pending_quantity = Math.max(0, quantity - order.filled_quantity);
    order.updated_at = this.clock.now();
    return clone(await this.refresh(order));
  }

  async getOrder(clientOrderId: string): Promise<BrokerOrder | undefined> {
    this.ensureEnabled();
    const order = this.orders.get(clientOrderId);
    if (!order) return undefined;
    return clone(await this.refresh(order));
  }

  async listOrders(): Promise<BrokerOrder[]> {
    this.ensureEnabled();
    const raw = await this.call(() => this.transport.listOrders());
    // ── NO AWAIT BEYOND THIS POINT ───────────────────────────────────────────────────────────
    // The map reads below were already post-await, so the cumulative floor was current; but the
    // PAYLOAD predates any stream event that landed during the round trip, so an unconditional write
    // still regressed state, average price, pending quantity and evidence. Merging fixes that.
    return raw.map((item) => {
      const clientId = this.clientByBroker.get(item.order_id) ?? `KITE_ORPHAN:${item.order_id}`;
      const known = this.orders.get(clientId);
      const normalized = normalizeKiteOrder(item, known, this.clock.now());
      if (!known) return clone(normalized);
      return clone(this.commit(clientId, normalized, {
        observedCumulativeQty: readNonNegativeInteger(item.filled_quantity).value,
      }));
    });
  }

  async adoptOrder(intent: IBoxOrderIntent, snapshot: BrokerOrder): Promise<BrokerOrder> {
    this.ensureEnabled();
    if (!snapshot.broker_order_id ||
      (intent.broker_order_id !== null && snapshot.broker_order_id !== intent.broker_order_id)) {
      throw new Error("Cannot adopt a broker order without matching durable broker identity.");
    }
    const immutableMatches =
      snapshot.exchange === intent.exchange &&
      snapshot.tradingsymbol === intent.tradingsymbol &&
      snapshot.side === intent.side &&
      snapshot.quantity === intent.quantity &&
      (!intent.broker_tag || !snapshot.tag || snapshot.tag === intent.broker_tag) &&
      snapshot.limit_price === intent.limit_price;
    if (!immutableMatches) {
      throw new Error(`Broker order ${snapshot.broker_order_id} does not match durable immutable intent fields.`);
    }
    const alreadyOwned = this.clientByBroker.get(snapshot.broker_order_id);
    if (alreadyOwned && alreadyOwned !== intent.client_order_id) {
      throw new Error(`Broker order ${snapshot.broker_order_id} is already attributed to ${alreadyOwned}.`);
    }
    const brokerOrderId = snapshot.broker_order_id;
    const adopted: BrokerOrder = {
      ...snapshot,
      client_order_id: intent.client_order_id,
      broker_order_id: brokerOrderId,
      tag: intent.broker_tag ?? snapshot.tag,
      role: intent.role,
      trade_id: intent.trade_id,
      attempt_id: intent.attempt_id,
      purpose: intent.purpose,
      phase: intent.phase,
      exchange: intent.exchange,
      tradingsymbol: intent.tradingsymbol,
      token: intent.token,
      side: intent.side,
      quantity: intent.quantity,
      pricing: {
        order_type: "LIMIT",
        reference_price: intent.reference_price,
        tick_size: intent.tick_size,
        max_chase_ticks: intent.max_chase_ticks,
        limit_price: intent.limit_price,
      },
      limit_price: intent.limit_price,
      fills: snapshot.fills.map((fill) => ({ ...fill })),
    };
    // ADOPTION MERGES. An unconditional write discarded a session entry that a stream observation
    // had already advanced — restart adoption and a live stream can overlap. Merging keeps the
    // higher cumulative quantity and cannot reopen a confirmed terminal order, while every
    // durable immutable field above is still asserted before we get here.
    return clone(this.commit(intent.client_order_id, adopted));
  }

  async listPositions(): Promise<BrokerPosition[]> {
    this.ensureEnabled();
    const positions = await this.call(() => this.transport.listPositions());
    return positions.map((position) => ({
      token: position.instrument_token ?? 0,
      exchange: position.exchange,
      tradingsymbol: position.tradingsymbol,
      net_quantity: position.quantity,
      average_price: position.average_price,
    }));
  }

  async margins(): Promise<BrokerMargin | null> {
    this.ensureEnabled();
    return this.transport.margins ? this.call(() => this.transport.margins!()) : null;
  }

  async health(): Promise<BrokerHealth> {
    if (!this.isEnabled()) {
      return {
        ok: false,
        transport: "disabled",
        authenticated: false,
        message: "Kite live adapter is disabled by execution mode or kill switch.",
        checked_at: this.clock.now(),
      };
    }
    return this.transport.health
      ? this.call(() => this.transport.health!())
      : {
          ok: true,
          transport: "unknown",
          authenticated: true,
          message: null,
          checked_at: this.clock.now(),
        };
  }

  /**
   * Ask Kite whether our stable tag already exists — the anti-duplicate primitive, and the
   * counterpart to Dhan's `reconcileByCorrelation`.
   *
   * ADOPTION IS ONLY SAFE WHEN THE ORDER IS UNIQUELY IDENTIFIED. Three outcomes:
   *
   *   exactly one match, immutable attributes agree → ADOPT it. The order exists; we now own it.
   *   no match                                      → return null. We do NOT conclude "no order
   *                                                    was created": one order-book read that
   *                                                    does not yet show a just-placed order is
   *                                                    weak evidence, and acting on it is how
   *                                                    duplicate orders happen. The caller
   *                                                    quarantines instead, and NEVER retries.
   *   several matches, or attributes disagree        → return null and quarantine. Adopting the
   *                                                    wrong order would attribute someone
   *                                                    else's exposure to this Box.
   *
   * The tag is derived deterministically from the client order id (see {@link stableKiteTag}),
   * which itself carries the attempt number — so two attempts at the same leg have different
   * tags and cannot be confused with one another.
   */
  private async reconcileByTag(req: BrokerOrderRequest, pending: BrokerOrder): Promise<BrokerOrder | null> {
    const tag = pending.tag;
    if (!tag) return null;
    const raw = await this.call(() => this.transport.listOrders());
    const matches = raw.filter((item) => item.tag === tag);
    if (matches.length !== 1) {
      if (matches.length > 1) {
        console.warn(
          `[Kite] ${matches.length} broker orders carry tag ${tag}; refusing to adopt any of them for ${req.client_order_id}.`,
        );
      }
      return null;
    }
    const candidate = matches[0]!;

    // The tag is a hash, so a collision is conceivable and a mismatch would be catastrophic.
    // Verify the attributes that CANNOT legitimately differ before taking ownership.
    const attributesAgree =
      candidate.exchange === req.exchange &&
      candidate.tradingsymbol === req.tradingsymbol &&
      candidate.transaction_type === req.side &&
      candidate.quantity === req.quantity;
    if (!attributesAgree) {
      console.warn(
        `[Kite] broker order ${candidate.order_id} matched tag ${tag} but its immutable attributes disagree with ${req.client_order_id}; refusing to adopt.`,
      );
      return null;
    }

    const alreadyOwned = this.clientByBroker.get(candidate.order_id);
    if (alreadyOwned && alreadyOwned !== req.client_order_id) {
      console.warn(
        `[Kite] broker order ${candidate.order_id} is already attributed to ${alreadyOwned}; refusing to adopt it for ${req.client_order_id}.`,
      );
      return null;
    }

    // `pending` is the PRE-AWAIT submission snapshot. The latest accepted state is re-read here,
    // after the listOrders round trip, so a stream observation delivered during it is the merge base
    // rather than something the adoption write silently discards.
    const current = this.orders.get(req.client_order_id) ?? pending;
    const adopted = this.commit(
      req.client_order_id,
      normalizeKiteOrder(candidate, current, this.clock.now()),
      { observedCumulativeQty: readNonNegativeInteger(candidate.filled_quantity).value },
    );
    // The order exists at the broker, so these facts are now established — even though our POST
    // appeared to fail. Recording them keeps the latency sample honest rather than losing the
    // whole operation from calibration.
    this.mark(req.client_order_id, "broker_order_id");
    this.mark(req.client_order_id, "acknowledged");
    console.warn(
      `[Kite] adopted existing broker order ${candidate.order_id} for ${req.client_order_id} after an ambiguous submission; no retry was attempted.`,
    );
    return adopted;
  }

  /** Continue an adopted order's lifecycle, quarantining it if it becomes uncertain. */
  private async resolveAdopted(req: BrokerOrderRequest, adopted: BrokerOrder): Promise<BrokerOrder> {
    if (isBrokerOrderTerminal(adopted.state)) return clone(adopted);
    try {
      return await this.waitForResolution(adopted);
    } catch (error) {
      adopted.state = "RECONCILIATION_REQUIRED";
      adopted.updated_at = this.clock.now();
      throw new BrokerAmbiguousSubmitError(
        req.client_order_id,
        `Kite order ${adopted.broker_order_id} was adopted after an ambiguous submission but its terminal state remains uncertain.`,
        error,
        clone(adopted),
      );
    }
  }

  /**
   * Resolvers waiting for the NEXT observation of one order (see the Dhan adapter for the full
   * argument). Zerodha delivers order updates as TEXT frames on the market-data socket; without
   * this seam such an event could only change a status label, because an order waiter is blocked on
   * `waitForResolution`'s poll interval, not on the socket.
   */
  private readonly orderWaiters = new Map<string, Set<() => void>>();
  /** Client order ids observed while no waiter was parked; the next wait consumes the latch. */
  private readonly pendingObservation = new Set<string>();
  private streamObservationsApplied = 0;
  private streamObservationsIgnored = 0;

  /** Sleep up to `ms`, waking EARLY on an external observation of this order. */
  private async waitOrObservation(ms: number, clientOrderId: string): Promise<void> {
    // Edge-not-lost: if an observation arrived AFTER the previous poll but BEFORE we re-entered
    // this wait, the latch is already set and we return immediately rather than sleeping a full
    // interval on news we have technically already received.
    if (this.pendingObservation.delete(clientOrderId)) return;
    let waiters = this.orderWaiters.get(clientOrderId);
    if (!waiters) {
      waiters = new Set();
      this.orderWaiters.set(clientOrderId, waiters);
    }
    let wake: () => void = () => {};
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    waiters.add(wake);
    try {
      await Promise.race([this.clock.wait(ms), woken]);
    } finally {
      waiters.delete(wake);
      if (waiters.size === 0) this.orderWaiters.delete(clientOrderId);
    }
  }

  private wakeOrderWaiters(clientOrderId: string): void {
    const waiters = this.orderWaiters.get(clientOrderId);
    if (!waiters || waiters.size === 0) {
      // No waiter is parked right now. Latch the edge so the NEXT waitOrObservation returns at
      // once instead of sleeping through an interval — the observation already updated the
      // session snapshot, so the loop must re-read it promptly.
      this.pendingObservation.add(clientOrderId);
      return;
    }
    for (const wake of [...waiters]) {
      try { wake(); } catch { /* a waiter must never break the ingestion path */ }
    }
  }

  /**
   * APPLY ONE EXTERNAL ORDER OBSERVATION (a Kite order postback text frame).
   *
   * Same contract as the Dhan adapter's: already attributed by the projection, re-validated through
   * the shared evidence reader, cumulative-monotonic, and it wakes the order's waiters so the fill
   * is seen on the event rather than on the next poll.
   */
  applyOrderUpdate(update: ExternalOrderUpdate): BrokerOrder | undefined {
    const known = this.orders.get(update.clientOrderId);
    if (!known) {
      this.streamObservationsIgnored++;
      return undefined;
    }
    const observedQuantity = readNonNegativeInteger(update.cumulativeQty);
    const observedPrice = readPositivePrice(update.averagePrice ?? null);
    const label = String(update.rawStatus ?? "");
    const claimedState = kiteState(label, observedQuantity.value ?? known.filled_quantity, known.quantity);
    const verdict = evaluateExecutionEvidence({
      statusLabel: label,
      claimedState,
      requestedQuantity: known.quantity,
      priorFilled: known.filled_quantity,
      quantity: observedQuantity,
      price: observedPrice,
    });
    const observedFilled = observedQuantity.present ? (observedQuantity.value ?? 0) : null;
    const regressed = observedFilled !== null && observedFilled < known.filled_quantity;
    const at = update.observedAtWall ?? this.clock.now();

    // A QUANTITY REGRESSION MUST NOT DISCARD THE WHOLE OBSERVATION.
    //
    // Quantity is not the only thing an order update carries: Kite can report `CANCELLED` alongside
    // a `filled_quantity` that reflects a pre-fill snapshot. Dropping the whole observation would
    // throw away the CANCELLATION of the remainder along with the stale number, leaving the order
    // "working" in the session snapshot with its waiters never woken.
    //
    // The candidate below is therefore RAW-FAITHFUL — it reports exactly what this observation said —
    // and `mergeBrokerOrderSnapshot` applies the monotonic quantity floor, the price rule, the
    // terminal guard and the fill-record rule. Stream and REST now share one implementation of that
    // authority, which is what stops the two paths from disagreeing.
    const candidate = clone(known);
    candidate.filled_quantity = observedFilled ?? verdict.filledQuantity;
    candidate.pending_quantity = Math.max(0, known.quantity - candidate.filled_quantity);
    candidate.average_price = verdict.averagePrice;
    candidate.execution_evidence = verdict.quality;
    if (update.brokerOrderId) candidate.broker_order_id = update.brokerOrderId;
    candidate.state = verdict.sufficient
      ? kiteState(label, candidate.filled_quantity, known.quantity)
      : known.state;
    if (!verdict.sufficient) candidate.reject_reason = verdict.detail;
    candidate.fills = candidate.filled_quantity > 0
      ? [{
        fill_id: `kite:stream:${candidate.broker_order_id ?? update.clientOrderId}:${candidate.filled_quantity}:${verdict.averagePrice ?? "unpriced"}`,
        quantity: candidate.filled_quantity,
        price: verdict.averagePrice,
        at,
      }]
      : [];
    candidate.updated_at = at;

    const merged = mergeBrokerOrderSnapshot(known, candidate, { observedCumulativeQty: observedFilled });
    // When the quantity went backwards AND nothing else moved, the observation genuinely carries
    // nothing on any track. Only then is it ignored outright.
    if (regressed && merged.order.state === known.state && merged.order.filled_quantity === known.filled_quantity) {
      this.streamObservationsIgnored++;
      return clone(known);
    }
    this.orders.set(update.clientOrderId, merged.order);
    this.markFill(update.clientOrderId, merged.order.filled_quantity);
    this.streamObservationsApplied++;
    this.wakeOrderWaiters(update.clientOrderId);
    return clone(merged.order);
  }

  streamObservationStats(): { applied: number; ignored: number } {
    return { applied: this.streamObservationsApplied, ignored: this.streamObservationsIgnored };
  }

  private async waitForResolution(order: BrokerOrder): Promise<BrokerOrder> {
    const started = this.clock.now();
    let partialAt: number | null = null;
    while (!isBrokerOrderTerminal(order.state)) {
      const elapsed = this.clock.now() - started;
      const deadline = order.state === "ACKNOWLEDGED"
        ? this.config.ackTimeoutMs
        : this.config.workingTimeoutMs;
      if (elapsed >= deadline || (partialAt !== null && this.clock.now() - partialAt >= this.config.partialTimeoutMs)) {
        return clone(await this.protectiveCancelAndConfirm(order));
      }
      // Wake on the EVENT, fall back on the interval: REST stays a controlled fallback.
      await this.waitOrObservation(Math.max(1, this.config.brokerMinIntervalMs), order.client_order_id);
      // A stream observation may have ALREADY updated this order's session snapshot (and woken us)
      // through applyOrderUpdate. That snapshot is authoritative and cumulative-monotonic, so adopt
      // it FIRST. If it is now terminal, the fill was seen on the event and a REST re-poll would
      // only risk overwriting a fresh terminal state with a staler open snapshot — so we skip it.
      const observed = this.orders.get(order.client_order_id);
      if (observed && observed !== order) {
        order = observed;
        if (isBrokerOrderTerminal(order.state)) break;
      }
      order = await this.refresh(order);
      if (order.state === "PARTIALLY_FILLED" && partialAt === null) partialAt = this.clock.now();
    }
    return clone(order);
  }

  private async protectiveCancelAndConfirm(order: BrokerOrder): Promise<BrokerOrder> {
    if (!order.broker_order_id || isBrokerOrderTerminal(order.state)) return order;
    const clientOrderId = order.client_order_id;
    const brokerOrderId = order.broker_order_id;
    this.commit(clientOrderId, { ...cloneBrokerOrder(order), state: "CANCEL_REQUESTED", updated_at: this.clock.now() });
    this.mark(clientOrderId, "cancel_requested");
    try {
      await withDeadline(
        this.call(() => this.transport.cancelOrder(brokerOrderId), "order_cancel"),
        this.config.cancelTimeoutMs,
        "Protective cancellation timed out.",
      );
      this.mark(clientOrderId, "cancel_acknowledged");
      return await this.confirmTerminalAfterCancel(clientOrderId);
    } catch (error) {
      this.penalizeIfRateLimited(error);
      // Quarantine the LATEST accepted state, not the pre-await snapshot: a fill observed while the
      // cancel was in flight is real exposure and must travel with the quarantine.
      const quarantined = this.quarantine(clientOrderId, order);
      throw new BrokerAmbiguousSubmitError(
        clientOrderId,
        "Protective cancellation could not establish terminal cumulative quantity; order is quarantined.",
        error,
        clone(quarantined),
      );
    }
  }

  /**
   * Poll until the cancellation is terminal.
   *
   * Keyed by client order id, NOT by a captured object: `refresh` commits through the map, so
   * holding an object across iterations would reintroduce the stale-base problem. The wait is
   * `waitOrObservation` rather than a plain sleep so a fill racing the cancel is seen on the EVENT —
   * this loop is exactly where the cancel-versus-fill race is decided.
   */
  private async confirmTerminalAfterCancel(clientOrderId: string): Promise<BrokerOrder> {
    const deadline = this.clock.now() + this.config.cancelTimeoutMs;
    while (this.clock.now() <= deadline) {
      const known = this.orders.get(clientOrderId);
      if (!known) break;
      const refreshed = await this.refresh(known);
      if (isBrokerOrderTerminal(refreshed.state)) return refreshed;
      await this.waitOrObservation(Math.max(1, this.config.brokerMinIntervalMs), clientOrderId);
      const observed = this.orders.get(clientOrderId);
      if (observed && isBrokerOrderTerminal(observed.state)) return observed;
    }
    const quarantined = this.quarantine(clientOrderId, this.orders.get(clientOrderId));
    throw new BrokerAmbiguousSubmitError(
      clientOrderId,
      "Cancellation was acknowledged locally but broker terminal quantity remains uncertain.",
      undefined,
      clone(quarantined),
    );
  }

  /**
   * Move the LATEST accepted state to RECONCILIATION_REQUIRED.
   *
   * A confirmed TERMINAL state is left alone: quarantining an order the broker has already resolved
   * would manufacture uncertainty and send a settled order back through recovery.
   */
  private quarantine(clientOrderId: string, fallback: BrokerOrder | undefined): BrokerOrder {
    const current = this.orders.get(clientOrderId) ?? fallback;
    if (!current) {
      // AMBIGUOUS, not a generic fault. Every caller of this helper is on a path that previously
      // guaranteed a BrokerAmbiguousSubmitError, and the manager routes on that type to decide
      // whether an order may still exist at the broker. A plain Error would lose that classification.
      throw new BrokerAmbiguousSubmitError(
        clientOrderId,
        `Order ${clientOrderId} vanished from the session projection before it could be quarantined; ` +
          "reconciliation is required.",
      );
    }
    if (isBrokerOrderTerminal(current.state)) return current;
    return this.commit(clientOrderId, {
      ...cloneBrokerOrder(current),
      state: "RECONCILIATION_REQUIRED",
      updated_at: this.clock.now(),
    });
  }

  /**
   * Re-read one order and merge the result into the session projection.
   *
   * BOTH the merge BASE and the write target are read AFTER the await, so a stream observation that
   * landed during the round trip is neither ignored (it sets `priorFilled`, which is what makes the
   * evidence reader's monotonic floor meaningful) nor overwritten. See {@link commit}.
   */
  private async refresh(order: BrokerOrder): Promise<BrokerOrder> {
    if (!order.broker_order_id) return order;
    const clientOrderId = order.client_order_id;
    const raw = await this.call(() => this.transport.getOrder(order.broker_order_id as string));
    // ── NO AWAIT BEYOND THIS POINT ───────────────────────────────────────────────────────────
    // The latest ACCEPTED state, which may have advanced on the stream while the read was in flight.
    const current = this.orders.get(clientOrderId) ?? order;
    if (!raw) {
      // MISSING-RESPONSE BRANCH. Returning the pre-await snapshot here discarded an intervening
      // stream update. UNKNOWN is still recorded — the broker may own something we cannot read — but
      // it is merged, so a confirmed fill survives and a confirmed TERMINAL state is not reopened.
      return this.commit(clientOrderId, {
        ...cloneBrokerOrder(current),
        state: "UNKNOWN",
        updated_at: this.clock.now(),
      });
    }
    const normalized = normalizeKiteOrder(raw, current, this.clock.now());
    // The RAW reading is handed to the merge so a payload describing a smaller fill cannot donate
    // its average price to a larger accepted cumulative quantity.
    return this.commit(clientOrderId, normalized, {
      observedCumulativeQty: readNonNegativeInteger(raw.filled_quantity).value,
    });
  }

  /**
   * Mark a timing stage. FAIL-OPEN and silent when instrumentation is off or the order has no
   * trace — a metrics failure must never be able to interfere with an order, least of all a
   * cancel.
   */
  private mark(clientOrderId: string, stage: Parameters<ExecutionTimingRecorder["mark"]>[1]): void {
    try {
      this.config.timing?.mark(clientOrderId, stage);
    } catch {
      /* telemetry must never affect execution */
    }
  }

  /** Record an observed cumulative filled quantity. Fail-open. */
  private markFill(clientOrderId: string, cumulativeQty: number): void {
    try {
      this.config.timing?.markFill(clientOrderId, cumulativeQty);
    } catch {
      /* telemetry must never affect execution */
    }
  }

  /**
   * COMMIT ONE OBSERVATION — the ONLY way a REST path may write the session projection.
   *
   * WHY THIS EXISTS. Every REST path used to capture a snapshot, `await` the transport, then write a
   * value derived from that PRE-AWAIT snapshot back into the map. A WebSocket observation applied
   * during the await (`applyOrderUpdate` is synchronous, so it lands whole) was therefore both
   * invisible to the merge and destroyed by the write — the reproduced "cached 30, stream 75, older
   * REST CANCELLED/30 wins" lost update.
   *
   * THE INVARIANT. This method re-reads the map and merges and writes with NO `await` anywhere in
   * between, so the whole read-merge-write runs in one JS tick and is atomic with respect to
   * `applyOrderUpdate` for the same reason `applyOrderUpdate` itself is safe. Callers must therefore
   * call it only AFTER their last await, and must use its RETURN value rather than the snapshot they
   * were holding.
   */
  private commit(
    clientOrderId: string,
    candidate: BrokerOrder,
    options?: BrokerOrderMergeOptions,
  ): BrokerOrder {
    const merged = mergeBrokerOrderSnapshot(this.orders.get(clientOrderId), candidate, options);
    this.orders.set(clientOrderId, merged.order);
    if (merged.conflict !== null) {
      // NEVER SILENT. A conflict means the two observations asserted mutually exclusive facts; the
      // merge has already moved the order to RECONCILIATION_REQUIRED, and this is the only place an
      // operator can learn WHY without reading the durable audit.
      console.warn(`[Kite] execution evidence conflict for ${clientOrderId}: ${merged.conflict}`);
    }
    // A CONFLICTING broker id is deliberately NOT registered: it belongs to a different broker order,
    // so attributing this client order id to it would compound the attribution fault. The order is in
    // RECONCILIATION_REQUIRED and the reconciler owns it from here.
    if (merged.order.broker_order_id && merged.conflict === null) {
      this.clientByBroker.set(merged.order.broker_order_id, clientOrderId);
    }
    // TIMING: the broker's CUMULATIVE quantity. The recorder ignores anything that is not an
    // increase, so re-polling an unchanged order does not manufacture extra "fill" events.
    this.markFill(clientOrderId, merged.order.filled_quantity);
    return merged.order;
  }

  private isEnabled(): boolean {
    return this.config.executionMode === "live" && this.config.enabled === true;
  }

  private ensureEnabled(): void {
    if (!this.isEnabled()) throw new BrokerDisabledError();
  }

  /**
   * Paced transport. Every broker touch goes through here.
   *
   * `klass` is the endpoint class the broker meters at (`order_place` / `order_modify` /
   * `order_cancel` / `data_read`). It selects BOTH the per-second pacing bucket (order mutations
   * are paced faster than general reads) AND — for order endpoints — the multi-window
   * {@link RateBudgetLedger} check. See `brokerPacing.ts` for why the two are separated.
   *
   * The ledger check for a PLACEMENT is deliberately NOT done here: it must ride the final
   * synchronous pre-wire boundary (`beforeSend`) so a refusal is a proven no-POST. This method
   * gates the RECOVERY endpoints (cancel/modify), which have no `beforeSend` hook, immediately
   * before the transport call — if refused (only possible when even the reserve is spent), it
   * throws before any request leaves.
   */
  private call<T>(operation: () => Promise<T>, klass: BrokerEndpointClass = "data_read"): Promise<T> {
    if (klass === "order_cancel" || klass === "order_modify") {
      this.reserveRecoveryBudgetOrThrow(klass);
    }
    return this.pacer.run(operation, pacingClassFor(klass));
  }

  /**
   * Fast pre-pacing refusal: throw immediately if the shared placement budget is ALREADY spent.
   *
   * A pure read — it does NOT record. Its only job is to avoid sitting through a pacing interval
   * for a placement the budget will refuse anyway; the authoritative check+record still happens at
   * the send boundary in {@link placementBudgetGuard}. A no-op when no ledger is wired.
   */
  private refusePlacementIfBudgetExhausted(clientOrderId: string): void {
    const ledger = this.config.rateBudget;
    if (!ledger) return;
    const decision = ledger.check("order_place", this.clock.now());
    if (!decision.allowed) {
      ledger.noteRefusal("order_place");
      throw new BrokerPreSubmitRefusedError(
        clientOrderId,
        "pre_post",
        true,
        `order budget exhausted: ${decision.reason}`,
      );
    }
  }

  /**
   * Consult the shared order budget for a PLACEMENT at the pre-wire boundary.
   *
   * Returns a synchronous guard to run inside `beforeSend`. When the placement would breach a
   * window it throws {@link BrokerPreSubmitRefusedError} at stage `pre_post` — the adapter's own
   * catch and the transport both re-throw it untouched, so NO HTTP request is transmitted and the
   * durable intent terminalises as a free REJECTED no-POST (never a broker reject, never retried).
   * When allowed it RECORDS the placement against the budget. A no-op when no ledger is wired.
   */
  private placementBudgetGuard(clientOrderId: string): () => void {
    const ledger = this.config.rateBudget;
    if (!ledger) return () => undefined;
    return () => {
      const now = this.clock.now();
      const decision = ledger.check("order_place", now);
      if (!decision.allowed) {
        ledger.noteRefusal("order_place");
        throw new BrokerPreSubmitRefusedError(
          clientOrderId,
          "pre_post",
          true,
          `order budget exhausted: ${decision.reason}`,
        );
      }
      ledger.record("order_place", now);
    };
  }

  /** Gate a recovery mutation (cancel/modify) against the reserve; throw before any wire use. */
  private reserveRecoveryBudgetOrThrow(klass: "order_cancel" | "order_modify"): void {
    const ledger = this.config.rateBudget;
    if (!ledger) return;
    const now = this.clock.now();
    const decision = ledger.check(klass, now);
    if (!decision.allowed) {
      ledger.noteRefusal(klass);
      // Even the recovery reserve is spent (or a broker cooldown is active). Surface it as a
      // proven no-POST refusal rather than sending into a budget the broker will 429.
      throw new BrokerPreSubmitRefusedError(
        "recovery",
        "pre_post",
        false,
        `recovery budget unavailable: ${decision.reason}`,
      );
    }
    ledger.record(klass, now);
  }

  /**
   * Feed a caught error to the shared budget as a throttle signal WITHOUT ever resending.
   *
   * A 429 means the account is over budget in a way our own count did not predict (most likely an
   * unobservable external consumer). {@link RateBudgetLedger.penalize} records a hard cooldown; we
   * then let the caller's EXISTING ambiguous/reconcile-by-tag path run — a 429 tells us nothing
   * about whether the exchange saw the order, so the order is NEVER replayed.
   */
  private penalizeIfRateLimited(error: unknown): void {
    const ledger = this.config.rateBudget;
    if (!ledger) return;
    const status = error instanceof KiteHttpError ? error.status : null;
    if (!isRateLimited(status)) return;
    const retryAfterMs = error instanceof KiteHttpError
      ? parseRetryAfterMs(readRetryAfterHeader(error.body), this.clock.now())
      : null;
    ledger.penalize(this.clock.now(), retryAfterMs);
  }
}

export function stableKiteTag(clientOrderId: string, requested?: string): string {
  const safe = requested?.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
  if (safe) return safe;
  let hash = 0x811c9dc5;
  for (const char of clientOrderId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `BOX${(hash >>> 0).toString(36).toUpperCase()}`.slice(0, 20);
}

export function classifyKiteReject(error: unknown): BrokerRejectFamily {
  const message = errorMessage(error).toLowerCase();
  if (/margin|funds|cash/.test(message)) return "margin";
  if (/price.*band|circuit|range/.test(message)) return "price_band";
  if (/instrument|contract|token|scrip.*not/.test(message)) return "instrument_unavailable";
  if (/market.*clos|exchange.*clos|outside.*hour/.test(message)) return "market_closed";
  if (/rate.*limit|too many|429/.test(message)) return "rate_limit";
  if (/\brms\b|risk management/.test(message)) return "rms";
  if (/quantity|freeze|lot size/.test(message)) return "quantity_freeze";
  if (/auth|token|permission|401|403/.test(message)) return "auth";
  return "generic";
}

/**
 * Project one Kite order row onto the broker-neutral shape.
 *
 * Subject to the SAME execution-evidence rules as the Dhan projection
 * (brokerExecutionEvidence.ts). `KiteTransportOrder` declares `filled_quantity` and
 * `average_price` as numbers, but they are coerced from a JSON payload: a field the API omits
 * arrives as `undefined`/`NaN` at runtime, and reading that as a confirmed zero is the same
 * fabrication. Kite order updates also arrive over the websocket postback, which lands here too,
 * so the validation has to live at this funnel rather than in one caller.
 */
function normalizeKiteOrder(raw: KiteTransportOrder, known: BrokerOrder | undefined, now: number): BrokerOrder {
  const observedQuantity = readNonNegativeInteger(raw.filled_quantity);
  const observedPrice = readPositivePrice(raw.average_price);
  const priorFilled = known?.filled_quantity ?? 0;
  const claimedState = kiteState(raw.status, observedQuantity.value ?? priorFilled, raw.quantity);
  const verdict = evaluateExecutionEvidence({
    statusLabel: raw.status,
    claimedState,
    requestedQuantity: raw.quantity,
    priorFilled,
    quantity: observedQuantity,
    price: observedPrice,
  });
  const filled = verdict.filledQuantity;
  const state: BrokerOrderState = verdict.sufficient
    ? kiteState(raw.status, filled, raw.quantity)
    : "RECONCILIATION_REQUIRED";
  const base = known ?? {
    client_order_id: `KITE_ORPHAN:${raw.order_id}`,
    broker_order_id: raw.order_id,
    tag: raw.tag,
    role: "k1_ce" as const,
    trade_id: null,
    attempt_id: "orphan",
    purpose: "PROTECTIVE_CANCEL" as const,
    phase: "unwind" as const,
    exchange: raw.exchange,
    tradingsymbol: raw.tradingsymbol,
    token: 0,
    side: raw.transaction_type,
    quantity: raw.quantity,
    pricing: {
      order_type: "LIMIT" as const,
      reference_price: raw.price > 0 ? raw.price : 0.05,
      tick_size: 0.05,
      max_chase_ticks: 0,
      limit_price: raw.price > 0 ? raw.price : 0.05,
    },
    limit_price: raw.price,
    state,
    filled_quantity: 0,
    pending_quantity: raw.quantity,
    average_price: null,
    fills: [],
    reject_family: null,
    reject_reason: null,
    created_at: parseTime(raw.order_timestamp) ?? now,
    updated_at: now,
  };
  return {
    ...base,
    broker_order_id: raw.order_id,
    tag: raw.tag ?? base.tag,
    state,
    quantity: raw.quantity,
    pricing: { ...base.pricing, limit_price: raw.price },
    limit_price: raw.price,
    filled_quantity: filled,
    pending_quantity: Math.max(0, raw.quantity - filled),
    average_price: verdict.averagePrice,
    fills: filled > 0 ? [{
      fill_id: `kite:${raw.order_id}:${filled}:${verdict.averagePrice ?? "unpriced"}`,
      quantity: filled,
      // NULL, never zero: an unpublished average price is absent data, not a free execution.
      price: verdict.averagePrice,
      at: parseTime(raw.exchange_update_timestamp) ?? now,
    }] : [],
    execution_evidence: verdict.quality,
    reject_family: state === "REJECTED" ? classifyKiteReject(raw.status_message ?? raw.status) : null,
    reject_reason: state === "REJECTED" ? raw.status_message ?? raw.status : verdict.detail,
    updated_at: parseTime(raw.exchange_update_timestamp) ?? now,
  };
}

function kiteState(status: string, filled: number, quantity: number): BrokerOrderState {
  const value = status.trim().toUpperCase();
  if (value === "COMPLETE") return "COMPLETE";
  if (value.includes("CANCEL")) return "CANCELLED";
  if (value.includes("REJECT")) return "REJECTED";
  if (filled > 0 && filled < quantity) return "PARTIALLY_FILLED";
  if (value === "OPEN" || value.includes("TRIGGER PENDING")) return "OPEN";
  if (value.includes("VALIDATION") || value.includes("PUT ORDER")) return "ACKNOWLEDGED";
  return "UNKNOWN";
}

function requestOrder(req: BrokerOrderRequest, now: number): BrokerOrder {
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

function clone(order: BrokerOrder): BrokerOrder {
  return {
    ...order,
    pricing: { ...order.pricing },
    fills: order.fills.map((fill) => ({ ...fill })),
  };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stringValues(input: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)]));
}

function numericPath(input: Record<string, unknown>, parent: string, child: string): number | null {
  const nested = input[parent];
  if (!nested || typeof nested !== "object") return null;
  const value = (nested as Record<string, unknown>)[child];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDefinitivePlacementRejection(error: unknown): boolean {
  return error instanceof KiteHttpError && error.status >= 400 && error.status < 500 && error.status !== 429;
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /timeout|timed out/i.test(error.message));
}

/**
 * Classify WHY a submission outcome is unknown, for the quarantine message.
 *
 * Purely diagnostic, and deliberately so: every branch below is handled identically (adopt if
 * uniquely identified, otherwise quarantine and never retry). The classification exists because
 * an operator triaging a quarantined order needs to know whether the request probably reached
 * the exchange — a timeout means very likely yes, a 429 means probably not, and a 5xx could be
 * either. Guessing differently per branch is exactly the reasoning that produces duplicate
 * orders, so the behaviour stays uniform and only the explanation varies.
 */
function describeAmbiguity(error: unknown): string {
  if (isTimeoutLike(error)) {
    return "the request timed out, so the order may well have reached the exchange";
  }
  if (error instanceof KiteHttpError) {
    if (error.status === 429) return "the broker rate-limited us, so the order was probably not accepted";
    if (error.status >= 500) return `the broker returned ${error.status}, so acceptance is unknown`;
    return `the broker returned ${error.status} without a definitive rejection`;
  }
  return "the transport failed without a definitive broker verdict";
}
