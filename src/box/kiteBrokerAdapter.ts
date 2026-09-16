import {
  BrokerAmbiguousSubmitError,
  BrokerCancelNotTransmittedError,
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
  type TransportConcurrencyLimits,
  type TransportPacerStats,
  TransportRequestAbandonedError,
  type TransportSubmission,
  type TransportUrgency,
} from "./brokerPacing.js";
import { Deadline } from "../brokers/deadline.js";
import type { BoxConfig } from "./config.js";
import {
  evaluateExecutionEvidence,
  readNonNegativeInteger,
  readPositivePrice,
} from "./brokerExecutionEvidence.js";
import { cloneBrokerOrder, mergeBrokerOrderSnapshot, type BrokerOrderMergeOptions } from "./brokerOrderMerge.js";
import { parseIstBrokerTimestamp } from "./brokerTimestamps.js";
import type { ExternalOrderUpdate } from "./brokerAdapter.js";
import type { ExecutionTimingRecorder } from "./executionTiming.js";
import type { BoxOrderPurpose, ExecutionMode, IBoxOrderIntent, OrderSide } from "./types.js";

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
    /**
     * The response's VERBATIM `Retry-After` header, or null when it carried none.
     *
     * Previously this class carried no header at all, so the only place left to look for a backoff
     * hint was the JSON body — which Kite's 429 does not contain. The broker's actual instruction
     * was therefore discarded on every rate limit, and the cooldown fell back to a conservative
     * one-second default instead of the 30 seconds it had asked for. Kept as the raw string so
     * `parseRetryAfterMs` can handle BOTH documented forms (delta-seconds and an HTTP date).
     */
    readonly retryAfter: string | null = null,
  ) {
    super(message);
    this.name = "KiteHttpError";
  }
}

/**
 * The subset of `Response` this transport needs.
 *
 * Declared structurally, and with `text`/`headers` OPTIONAL, because the suites inject hand-written
 * response literals (`{ ok, status, json }`) rather than real `Response` objects. Reading the body
 * has to work for both without pretending a fake carries headers it does not.
 */
type KiteResponseLike = {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null } | undefined;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
};

/** The `Retry-After` header, read defensively — a fake response may expose no headers at all. */
function retryAfterHeaderOf(response: KiteResponseLike): string | null {
  try {
    return response.headers?.get("retry-after") ?? null;
  } catch {
    // A header bag that throws must not be able to convert a 429 into a transport fault.
    return null;
  }
}

/**
 * Read a response body WITHOUT letting a non-JSON payload destroy the HTTP status.
 *
 * The old code called `await response.json()` unconditionally, and did it BEFORE checking
 * `response.ok`. An error status served with an HTML or empty body — routine from an edge gateway,
 * and exactly what a throttling proxy returns — made `json()` throw, so no `KiteHttpError` was ever
 * constructed and the 429 was lost entirely: the adapter saw an opaque `SyntaxError` and could
 * neither cool down nor classify it.
 *
 * `readFailure` distinguishes "the body could not be read" from "the body was not JSON", because
 * only the former is a genuine transport fault (an aborted body read). A non-JSON body on an error
 * status is not a fault at all — the status IS the information.
 */
async function readKiteResponseBody(
  response: KiteResponseLike,
): Promise<{ parsed: unknown; raw: string | null; readFailure: unknown }> {
  if (typeof response.text === "function") {
    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      // An aborted/severed body read. Real fault — surfaced, not swallowed.
      return { parsed: null, raw: null, readFailure: error };
    }
    if (raw === "") return { parsed: null, raw: "", readFailure: null };
    try {
      return { parsed: JSON.parse(raw) as unknown, raw, readFailure: null };
    } catch {
      return { parsed: null, raw, readFailure: null };
    }
  }
  if (typeof response.json === "function") {
    try {
      return { parsed: await response.json(), raw: null, readFailure: null };
    } catch (error) {
      return { parsed: null, raw: null, readFailure: error };
    }
  }
  return { parsed: null, raw: null, readFailure: null };
}

/** Kite's error envelope, when the body was JSON at all. */
function kiteErrorMessage(parsed: unknown, raw: string | null, status: number): string {
  if (parsed && typeof parsed === "object") {
    const record = parsed as { message?: unknown; error_type?: unknown };
    if (typeof record.message === "string" && record.message !== "") return record.message;
    if (typeof record.error_type === "string" && record.error_type !== "") return record.error_type;
  }
  // Non-JSON body: keep a BOUNDED excerpt. It is often the only clue about which proxy answered.
  if (raw !== null && raw.trim() !== "") return `Kite HTTP ${status}: ${raw.trim().slice(0, 200)}`;
  return `Kite HTTP ${status}`;
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
      const response = (await fetchImpl(url, init)) as unknown as KiteResponseLike;
      // Read the header BEFORE the body: a body read can fail, and the broker's backoff
      // instruction must survive that.
      const retryAfter = retryAfterHeaderOf(response);
      const { parsed, raw, readFailure } = await readKiteResponseBody(response);
      if (!response.ok) {
        // The STATUS is the information, and it now survives a non-JSON body. This is what makes a
        // real 429 (often served with an HTML error page) reach `penalizeIfRateLimited` at all.
        throw new KiteHttpError(
          response.status,
          kiteErrorMessage(parsed, raw, response.status),
          parsed ?? (raw === null ? null : { message: raw.slice(0, 500) }),
          retryAfter,
        );
      }
      // A 2xx whose body could not be READ is a genuine transport fault (an aborted body read):
      // surface it so the placement path still classifies the submission as ambiguous.
      if (readFailure !== null) throw readFailure;
      if (!parsed || typeof parsed !== "object") {
        throw new Error(
          `Kite ${method} ${path} returned HTTP ${response.status} with a body that was not JSON; ` +
            "the outcome cannot be read from it.",
        );
      }
      return (parsed as { data?: T }).data as T;
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
   * Concurrency bounds for the transport queue. Optional; the module default is used when absent.
   *
   * Exposed so a deployment can pin the transport to a single in-flight call if it needs to, without
   * losing the priority ordering that keeps a cancel from queueing behind a poll.
   */
  concurrency?: Partial<TransportConcurrencyLimits>;
  /**
   * THE ACCOUNT THAT OWNS THE CREDENTIAL THIS ADAPTER SIGNS WITH — read fresh, every time.
   *
   * Wired in production to the same object the access token is resolved from, so the two cannot
   * describe different accounts. Read fresh rather than captured at construction precisely because a
   * re-login REPLACES the credential in place on a long-lived adapter.
   *
   * Optional: absent means the deployment cannot prove which account it signs as, which is reported
   * as null (unproven) and never as a match.
   */
  credentialAccount?: () => string | null;
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
/**
 * Does this order REDUCE risk? Everything except a new ENTRY does.
 *
 * The recovery rate-limit reserve exists so that getting flat is still possible when the placement
 * budget is spent. `EXIT`, `EMERGENCY_RESIDUAL` and `PROTECTIVE_CANCEL` all shrink exposure, so all
 * three may draw on it; only `ENTRY` — the one purpose that ADDS exposure — may not.
 *
 * An unknown/absent purpose is treated as NOT protective. That is the conservative direction: it can
 * only withhold the reserve, never hand it to something that increases risk.
 */
function isProtectivePurpose(purpose: BoxOrderPurpose | undefined): boolean {
  return purpose === "EXIT" || purpose === "EMERGENCY_RESIDUAL" || purpose === "PROTECTIVE_CANCEL";
}

/**
 * Map the broker-metered endpoint class onto a DISPATCH TIER.
 *
 * Cancels and modifies reduce risk, so they outrank everything. A placement outranks a read: an
 * entry leg delayed behind a routine positions poll widens the very window the hedge-first ordering
 * exists to close. Reads always yield.
 */
function urgencyForEndpoint(klass: BrokerEndpointClass): TransportUrgency {
  if (klass === "order_cancel" || klass === "order_modify") return "recovery";
  if (klass === "order_place") return "placement";
  return "read";
}

/**
 * Find a {@link KiteHttpError} anywhere in an error's cause chain.
 *
 * Wrapping is not optional on the placement path — an ambiguous 429'd POST must be reported as
 * ambiguous — so the HTTP status has to be recovered from inside the wrapper rather than assumed to
 * be at the top. Depth-bounded so a self-referential `cause` cannot spin.
 */
function findKiteHttpError(error: unknown): KiteHttpError | null {
  // BOTH cause properties are traversed. This walked `.cause` only, while the wrappers that
  // actually appear on the placement path (`BrokerAmbiguousSubmitError`, `BrokerOrderRejectedError`)
  // stored the nested error in `causeValue` — so this function returned null for precisely the case
  // its doc comment says it exists to handle, and a 429'd POST produced no cooldown. The wrappers
  // now populate `.cause` too, but both are read here so the recovery does not depend on every
  // wrapper in the tree having been updated.
  //
  // Breadth-first over a bounded frontier with an identity set, so a cycle or a diamond (the
  // placement path wraps TWICE) can neither spin nor re-walk.
  const seen = new Set<unknown>();
  let frontier: unknown[] = [error];
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const node of frontier) {
      if (node === null || node === undefined) continue;
      if (node instanceof KiteHttpError) return node;
      if (typeof node !== "object") continue;
      if (seen.has(node)) continue;
      seen.add(node);
      const record = node as { cause?: unknown; causeValue?: unknown };
      next.push(record.cause, record.causeValue);
    }
    frontier = next;
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
  /**
   * Rate-limit responses already charged to the budget, so one 429 costs exactly one penalty.
   *
   * A `WeakSet` keyed on the error instance: several layers may catch the same rejection, and the
   * entry disappears with the error itself, so this can never grow.
   */
  private readonly penalizedRateLimits = new WeakSet<object>();

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
      this.config.concurrency ?? {},
    );
  }

  /**
   * The account behind the credential this adapter would sign the NEXT request with.
   *
   * Resolved from the credential holder itself, so it cannot drift from the token in use. Fail-safe:
   * any fault reading it is reported as "unproven" (null) rather than as a match, because a guard
   * that treats an error as agreement is worse than no guard at all.
   */
  dispatchAccount(): string | null {
    try {
      const account = this.config.credentialAccount?.() ?? null;
      return typeof account === "string" && account.trim() !== "" ? account.trim() : null;
    } catch {
      return null;
    }
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
    const placementGuard = this.placementBudgetGuard(req.client_order_id, req.purpose);
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
      this.refusePlacementIfBudgetExhausted(req.client_order_id, req.purpose);
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
        // A PROTECTIVE placement (EXIT / EMERGENCY_RESIDUAL / PROTECTIVE_CANCEL) reduces risk, so it
        // rides the recovery tier alongside cancels rather than queueing behind routine reads like
        // an entry does. Same test `isProtectivePurpose` already uses for the budget reserve, so the
        // two cannot disagree about what counts as risk-reducing.
      }, "order_place", { urgency: isProtectivePurpose(req.purpose) ? "recovery" : "placement" });
      this.mark(req.client_order_id, "http_response");
    } catch (error) {
      if (error instanceof BrokerPreSubmitRefusedError) {
        // No HTTP request started. Remove only the session-local projection so a
        // durable local REJECTED row cannot look like a working broker order.
        this.orders.delete(req.client_order_id);
        throw error;
      }
      // A PROVEN NO-REQUEST propagates untouched, exactly like a pre-submit refusal. A protective
      // cancellation that was withdrawn while still queued means the order is UNCHANGED and still
      // working at the broker; quarantining it here would both invent uncertainty and (via the
      // registry's `unknown_order_state` blocker) wedge logout and broker switching. This catch-all
      // used to swallow it and quarantine anyway, reintroducing the wedge the error type prevents.
      if (error instanceof BrokerCancelNotTransmittedError) throw error;
      // A LOCAL BUDGET REFUSAL IS ALSO A PROVEN NO-REQUEST. `reserveRecoveryBudgetOrThrow` throws at
      // the dispatch boundary -- when the recovery reserve is spent or a 429 cooldown is active --
      // BEFORE the transport is touched. Falling through to `quarantine()` turned a healthy working leg
      // into RECONCILIATION_REQUIRED because OUR OWN budget said no, which is uncertainty we invented.
      if (error instanceof BrokerPreSubmitRefusedError) throw error;
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
      /*
       * A PROVEN NO-REQUEST IS NOT AMBIGUITY — AND THIS IS THE PATH THAT RAISES IT.
       *
       * `waitForResolution` calls `protectiveCancelAndConfirm` on ack/working/partial timeout, so this
       * catch is the PRIMARY path on which a withdrawn-while-queued cancellation surfaces. Quarantining
       * it here re-created exactly the wedge those error types exist to prevent: the order is untouched
       * and still working, but it was reported RECONCILIATION_REQUIRED, which the gateway reads as an
       * uncertain entry (returning BEFORE partial-entry recovery, so sibling fills go un-unwound) and
       * the registry reads as `unknown_order_state`, refusing logout and broker switching.
       *
       * The identical guard exists in the catch around the POST itself, where a cancellation error can
       * never appear. It was missing from the one place it was needed.
       */
      if (error instanceof BrokerCancelNotTransmittedError) throw error;
      if (error instanceof BrokerPreSubmitRefusedError) throw error;
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
    // Idempotent: a cancellation already on the wire is awaited, not duplicated. See the same guard
    // in `protectiveCancelAndConfirm` for why a second DELETE is actively harmful.
    if (order.state === "CANCEL_REQUESTED" || this.cancelAlreadyDispatched(clientOrderId)) {
      return clone(await this.confirmTerminalAfterCancel(clientOrderId));
    }
    const brokerOrderId = order.broker_order_id;
    await this.sendCancelWithinDeadline(clientOrderId, brokerOrderId, order);
    // The broker accepted the cancel REQUEST. It is not yet a cancellation: the order may still
    // be filling right now, which is why confirmTerminalAfterCancel re-reads until terminal.
    this.mark(clientOrderId, "cancel_acknowledged");
    return clone(await this.confirmTerminalAfterCancel(clientOrderId));
  }

  /**
   * Put a cancellation on the wire under ONE absolute deadline that governs BOTH the queue and the
   * network — or prove that it never left.
   *
   * THE DEFECT THIS REPLACES. The old code raced `withDeadline` against a promise that had already
   * been appended to the pacer's FIFO chain. Losing that race rejected the CALLER but did nothing
   * whatsoever to the queued work, so the sequence was:
   *
   *     a slow read occupies the transport
   *       → this cancel is queued behind it
   *       → the caller is told the cancellation TIMED OUT
   *       → the read finally returns
   *       → the DELETE is transmitted, long after everyone stopped waiting for it
   *
   * The reported lifecycle and the actual broker activity disagreed, and a timeout could be read as
   * "nothing was sent" while a cancellation was in fact still pending on the wire.
   *
   * Now there are three OUTCOMES, not two, and they are distinguished by evidence rather than
   * guessed:
   *
   *   1. Acknowledged — the broker accepted the cancel request.
   *   2. WITHDRAWN BEFORE DISPATCH — the deadline expired while it was queued. `abandon()` returning
   *      true is PROOF the request never reached the transport, so the order is left exactly as it
   *      was (still working, not quarantined) and the caller is told plainly that nothing was sent.
   *      Manufacturing a RECONCILIATION_REQUIRED here would invent uncertainty and, via the
   *      registry's `unknown_order_state` blocker, would also wedge logout and broker switching.
   *   3. Dispatched, then failed or timed out — genuinely AMBIGUOUS. The DELETE may have reached the
   *      exchange, so the order is quarantined for reconciliation exactly as before.
   *
   * `CANCEL_REQUESTED` is committed from inside the dispatched closure, so that state now means "the
   * DELETE is on the wire" rather than "we intend to send one".
   */
  private async sendCancelWithinDeadline(
    clientOrderId: string,
    brokerOrderId: string,
    priorOrder: BrokerOrder,
  ): Promise<void> {
    const deadline = this.deadlineIn(this.config.cancelTimeoutMs);
    const submission = this.submitPaced(
      () => {
        // AT DISPATCH. Written THROUGH the map rather than mutated in place: if a stream observation
        // replaces the map entry during the DELETE, an in-place mutation would apply to a detached
        // object and the confirmation loop would write that orphan lineage back over the merged fill.
        const latest = this.orders.get(clientOrderId) ?? priorOrder;
        if (!isBrokerOrderTerminal(latest.state)) {
          this.commit(clientOrderId, {
            ...cloneBrokerOrder(latest),
            state: "CANCEL_REQUESTED",
            updated_at: this.clock.now(),
          });
          // Opens cancel_request_to_terminal_ms — the measured span that sizes paper's
          // cancel-vs-fill race window. The race starts when the DELETE goes out.
          this.mark(clientOrderId, "cancel_requested");
        }
        // Latched at DISPATCH and never cleared: this is what makes the idempotence guards survive a
        // later quarantine that overwrites the CANCEL_REQUESTED state.
        this.cancelDispatched.add(clientOrderId);
        return this.transport.cancelOrder(brokerOrderId);
      },
      "order_cancel",
      { deadline },
    );

    try {
      await withDeadline(
        submission.result,
        this.config.cancelTimeoutMs,
        "Kite cancellation timed out; reconciliation is required.",
      );
    } catch (error) {
      this.penalizeIfRateLimited(error);
      // A LOCAL BUDGET REFUSAL IS ALSO A PROVEN NO-REQUEST. `reserveRecoveryBudgetOrThrow` runs at
      // the dispatch boundary and throws BEFORE the transport is touched, so quarantining here would
      // invent uncertainty about a request that demonstrably never left — and, via the registry's
      // `unknown_order_state` blocker, would additionally wedge logout and broker switching.
      if (error instanceof BrokerPreSubmitRefusedError) throw error;
      // Withdraw it if it is STILL QUEUED. A true return proves no request was transmitted.
      if (submission.abandon("The cancellation deadline expired.") || error instanceof TransportRequestAbandonedError) {
        throw new BrokerCancelNotTransmittedError(
          clientOrderId,
          brokerOrderId,
          // The LATEST accepted snapshot, not the pre-cancel one: a fill observed while the
          // cancellation sat queued is real exposure and must travel with the refusal.
          clone(this.orders.get(clientOrderId) ?? priorOrder),
        );
      }
      this.quarantine(clientOrderId, priorOrder);
      throw error;
    }
    // The broker accepted the cancel REQUEST. It is not yet a cancellation: the order may still
    // be filling right now, which is why confirmTerminalAfterCancel re-reads until terminal.
    this.mark(clientOrderId, "cancel_acknowledged");
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
    /*
     * THE ATTEMPT IS COUNTED BEFORE THE WIRE, NOT AFTER A SUCCESSFUL RESPONSE.
     *
     * THE DEFECT THIS FIXES. The counter used to be incremented only after the PUT RESOLVED, so a
     * modification that reached Kite but whose response timed out, 5xx'd or 429'd threw before being
     * counted. The exchange had applied it; our count said it never happened. Repeat that and the
     * chase issues strictly more modifications than `BOX_LIVE_MAX_MODIFICATIONS` permits, silently
     * consuming Kite's own per-order modification allowance — and Kite rejects the whole order once
     * that is exhausted, at the worst possible moment.
     *
     * Counting first is the conservative direction: an attempt that provably never left (a synchronous
     * refusal below the wire) costs one of our own budget slots, which can only ever make us modify
     * LESS. Over-counting our own budget is recoverable; under-counting the broker's is not.
     */
    this.modifications.set(clientOrderId, count + 1);
    await this.call(() => this.transport.modifyOrder(order.broker_order_id as string, {
      price: request.limit_price,
      ...(request.quantity !== undefined ? { quantity: request.quantity } : {}),
    }), "order_modify");
    /*
     * WRITTEN THROUGH `commit`, NEVER MUTATED IN PLACE AFTER AN AWAIT.
     *
     * `order` was read BEFORE the PUT. If a stream observation landed during the round trip,
     * `this.orders` now holds a different, merged object and mutating `order` here edited a DETACHED
     * ORPHAN: the new limit price and quantity never reached the session projection, and
     * `pending_quantity` was computed from the orphan's stale `filled_quantity`. That is precisely the
     * lost-update class `commit()` exists to prevent — this was the one REST path still bypassing it.
     */
    const latest = this.orders.get(clientOrderId) ?? order;
    const merged = this.commit(clientOrderId, {
      ...cloneBrokerOrder(latest),
      limit_price: request.limit_price,
      pricing: { ...latest.pricing, limit_price: request.limit_price },
      quantity,
      pending_quantity: Math.max(0, quantity - latest.filled_quantity),
      updated_at: this.clock.now(),
    });
    return clone(await this.refresh(merged));
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
   * Re-read this order over REST, but let AUTHORITATIVE TERMINAL STREAM EVIDENCE end the wait early.
   *
   * THE DEFECT THIS CLOSES. `waitForResolution` had two suspension points and only the first was
   * wakeable. `waitOrObservation` races the poll interval against a stream wake, so an event that
   * arrives while we are sleeping is picked up at once — that path already worked. But the very next
   * line was a bare `await this.refresh(order)`, and `waitOrObservation`'s `finally` has by then
   * already removed the waiter. So during the REST round trip there was nothing registered to wake,
   * and `wakeOrderWaiters` could only set the `pendingObservation` latch — which is not consulted
   * until the TOP OF THE NEXT ITERATION, i.e. after REST returns.
   *
   * The consequence was pure latency, but on the worst possible path. A `COMPLETE` postback for a
   * hedge BUY was merged into the session snapshot immediately and yet `submitOrder` stayed pending
   * until the outstanding poll came back — and the hedge-first barrier holds every dependent
   * uncovered SELL until `submitOrder` RESOLVES. So every millisecond spent waiting on a read whose
   * answer we already had was added directly to the naked-short window.
   *
   * WHAT IS PRESERVED. The abandoned read is not cancelled and its result is not discarded: handlers
   * stay attached, so it still lands in `commit()` and merges under the monotonic cumulative floor
   * and the terminal guard. A late REST payload describing a SMALLER fill therefore still cannot
   * rewind the stream's terminal state, and no rejection is left unhandled. Only a TERMINAL
   * observation short-circuits; a partial one is not sufficient evidence to stop polling, so the
   * read remains the plan.
   */
  private async refreshOrTerminalObservation(order: BrokerOrder): Promise<BrokerOrder> {
    const clientOrderId = order.client_order_id;

    // Registered BEFORE the read starts, and synchronously, so an event delivered during the round
    // trip cannot fall between the two. (`applyOrderUpdate` is synchronous, so there is no
    // interleaving point here.)
    let waiters = this.orderWaiters.get(clientOrderId);
    if (!waiters) {
      waiters = new Set();
      this.orderWaiters.set(clientOrderId, waiters);
    }
    let wake: () => void = () => {};
    // Reassigned on every nonterminal event so one registration serves the whole read (see the loop).
    let observed = new Promise<"observed">((resolve) => {
      wake = () => resolve("observed");
    });
    waiters.add(wake);

    // If an edge was already latched, consume it: the snapshot may ALREADY be terminal.
    if (this.pendingObservation.delete(clientOrderId)) {
      const latched = this.orders.get(clientOrderId);
      if (latched && isBrokerOrderTerminal(latched.state)) {
        waiters.delete(wake);
        if (waiters.size === 0) this.orderWaiters.delete(clientOrderId);
        return latched;
      }
    }

    // Never let the caller's rejection escape unhandled just because we stopped awaiting it.
    const reading = this.refresh(order).then(
      (refreshed) => ({ ok: true as const, order: refreshed }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    try {
      /*
       * THE OBSERVATION STAYS ARMED ACROSS NONTERMINAL EVENTS.
       *
       * THE DEFECT THIS FIXES. This raced the read against ONE observation and then fell out of the
       * `try`, whose `finally` de-registered the waiter. So a PARTIAL fill arriving during the read
       * won the race, was found to be nonterminal, and the listener was torn down — after which a
       * COMPLETE arriving moments later had nothing to wake. The fast path silently degraded to
       * "wait for REST" for the rest of the read, which on a hedge leg is exactly the latency the
       * hedge-first barrier turns into a naked-short window.
       *
       * Looping keeps ONE registration alive for the whole read and re-arms the promise after each
       * nonterminal event, so partial -> partial -> COMPLETE releases on the COMPLETE.
       */
      for (;;) {
        // Consume any snapshot that is ALREADY terminal before waiting again — an event may have
        // landed between the previous iteration's wake and this check.
        const current = this.orders.get(clientOrderId);
        if (current && isBrokerOrderTerminal(current.state)) return current;

        const winner = await Promise.race([reading, observed]);
        if (winner !== "observed") break;

        const snapshot = this.orders.get(clientOrderId);
        // TERMINAL evidence only. Anything less and the read is still the authority — but we keep
        // listening rather than giving up on the stream for the remainder of this read.
        if (snapshot && isBrokerOrderTerminal(snapshot.state)) return snapshot;

        // Re-arm for the NEXT event on the same registration.
        waiters.delete(wake);
        observed = new Promise<"observed">((resolve) => {
          wake = () => resolve("observed");
        });
        waiters.add(wake);
      }
    } finally {
      waiters.delete(wake);
      if (waiters.size === 0) this.orderWaiters.delete(clientOrderId);
    }

    const outcome = await reading;
    if (!outcome.ok) throw outcome.error;
    // Prefer whatever the map holds now: `refresh` commits through it, and a stream observation that
    // landed during the read has already been merged in.
    return this.orders.get(clientOrderId) ?? outcome.order;
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
    /*
     * THE ACK PHASE IS LATCHED, AND ONLY EXITED ONCE.
     *
     * THE DEFECT THIS FIXES. The deadline used to be re-derived on every pass from `order.state`,
     * while `elapsed` was always measured from `started`. But `kiteState` maps every transient
     * `*PENDING` label — `VALIDATION PENDING`, `OPEN PENDING`, `MODIFY PENDING`,
     * `MODIFY VALIDATION PENDING`, `PUT ORDER REQ RECEIVED` — back to `ACKNOWLEDGED`. So a healthy
     * order resting for 4s under the 30s working budget would, the moment one poll happened to
     * report a pending label, be judged against the 3s ACK budget instead: `4000 >= 3000` and it was
     * protectively CANCELLED. Cancelling a live entry leg turns a four-leg box into a partial entry;
     * if the leg was a BUY hedge it also records zero proven coverage, so the dependent SELL is
     * refused and the partial is guaranteed.
     *
     * Once the broker has been seen WORKING, the order has demonstrably been accepted and can never
     * legitimately return to "waiting for acknowledgement". Latching that is what makes the budget
     * monotonic; the latch is ONE-WAY: once the broker has been seen working the order keeps the
     * longer budget, which is correct, because acceptance is not a state an order returns from.
     */
    let ackPhase = order.state === "ACKNOWLEDGED" || order.state === "SUBMITTING";
    while (!isBrokerOrderTerminal(order.state)) {
      if (ackPhase && order.state !== "ACKNOWLEDGED" && order.state !== "SUBMITTING") ackPhase = false;
      const elapsed = this.clock.now() - started;
      const deadline = ackPhase ? this.config.ackTimeoutMs : this.config.workingTimeoutMs;
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
      order = await this.refreshOrTerminalObservation(order);
      if (isBrokerOrderTerminal(order.state)) break;
      if (order.state === "PARTIALLY_FILLED" && partialAt === null) partialAt = this.clock.now();
    }
    return clone(order);
  }

  private async protectiveCancelAndConfirm(order: BrokerOrder): Promise<BrokerOrder> {
    if (!order.broker_order_id || isBrokerOrderTerminal(order.state)) return order;
    /*
     * A CANCELLATION IS ALREADY IN FLIGHT — DO NOT SEND A SECOND ONE.
     *
     * `CANCEL_REQUESTED` is deliberately NOT terminal (the order can still be filling), so the
     * terminality check above does not cover it. Without this guard a second DELETE went out
     * whenever a cancel was already pending — our own earlier cancel whose confirmation timed out,
     * an operator cancelling from the Kite console, or this loop coming round again because
     * `CANCEL_REQUESTED` never satisfies the `while` condition. Kite answers a DELETE on an order
     * already in `CANCEL PENDING` with a definitive 400, which the catch below then converts into a
     * forced quarantine — so a perfectly resolvable order became `RECONCILIATION_REQUIRED`, and one
     * such leg makes the whole entry `uncertain` in the gateway, which returns BEFORE partial-entry
     * recovery and so leaves the other legs' confirmed fills un-unwound.
     *
     * Waiting for the outcome we already asked for is strictly better than asking twice.
     */
    if (order.state === "CANCEL_REQUESTED" || this.cancelAlreadyDispatched(order.client_order_id)) {
      return this.confirmTerminalAfterCancel(order.client_order_id);
    }
    const clientOrderId = order.client_order_id;
    const brokerOrderId = order.broker_order_id;
    try {
      // Same deadline discipline as the public cancel: one absolute budget governing the queue AND
      // the wire, and a withdrawal that PROVES nothing was transmitted rather than inferring it.
      await this.sendCancelWithinDeadline(clientOrderId, brokerOrderId, order);
      return await this.confirmTerminalAfterCancel(clientOrderId);
    } catch (error) {
      this.penalizeIfRateLimited(error);
      // PROVEN NO-REQUEST. The protective cancel never left, so this order is still working exactly
      // as it was and there is no broker uncertainty to reconcile. Report it as the un-sent refusal
      // it is; dressing it up as ambiguous would quarantine an order the broker never heard about
      // and would tell the operator to reconcile something that never happened.
      if (error instanceof BrokerCancelNotTransmittedError) throw error;
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
      // Same fast path as the resolution loop: this read used to be a bare await, so a fill that
      // raced the cancel had to wait out the whole round trip before it could be seen.
      const refreshed = await this.refreshOrTerminalObservation(known);
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
  /**
   * Client order ids for which a DELETE was actually dispatched.
   *
   * SEPARATE FROM THE `CANCEL_REQUESTED` STATE, because `quarantine` overwrites that state with
   * `RECONCILIATION_REQUIRED` — which erased the very latch the double-cancel guards key on, so after a
   * dispatched-then-timed-out cancel a retry sent the second DELETE those guards exist to prevent. Kite
   * answers a DELETE on an order already in CANCEL PENDING with a definitive 400, which the catch paths
   * then convert into a forced quarantine of a resolvable order.
   */
  private readonly cancelDispatched = new Set<string>();

  /** Has a cancellation for this order already been put on the wire? Survives quarantine. */
  private cancelAlreadyDispatched(clientOrderId: string): boolean {
    return this.cancelDispatched.has(clientOrderId);
  }

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
  private call<T>(
    operation: () => Promise<T>,
    klass: BrokerEndpointClass = "data_read",
    opts: { deadline?: Deadline | null; urgency?: TransportUrgency } = {},
  ): Promise<T> {
    // EVERY paced broker touch now feeds a 429 to the budget, not just the three mutation call
    // sites that used to do it by hand. A rate-limited STATUS POLL is the same signal as a rate
    // limited placement — the account is over budget in a way our own count did not predict — and
    // ignoring it meant we kept polling straight into a throttle the broker had already announced.
    // `penalizeIfRateLimited` is identity-deduplicated, so a caller that also catches and penalizes
    // the same error cannot double-charge it.
    return this.submitPaced(operation, klass, opts).result.catch((error: unknown) => {
      this.penalizeIfRateLimited(error);
      throw error;
    });
  }

  /**
   * As {@link call}, but returns the pacer handle so a caller can withdraw a still-queued request.
   *
   * The recovery budget is now charged through `beforeDispatch` — i.e. at ACTUAL DISPATCH — rather
   * than synchronously at enqueue. Charging at enqueue recorded spend against the broker's budget
   * for cancels that were later abandoned in the queue and never sent, which made our count of
   * consumed capacity drift permanently above what the broker had actually seen.
   */
  private submitPaced<T>(
    operation: () => Promise<T>,
    klass: BrokerEndpointClass = "data_read",
    opts: { deadline?: Deadline | null; urgency?: TransportUrgency } = {},
  ): TransportSubmission<T> {
    const recovery = klass === "order_cancel" || klass === "order_modify";
    return this.pacer.submit(operation, pacingClassFor(klass), {
      urgency: opts.urgency ?? urgencyForEndpoint(klass),
      ...(opts.deadline ? { deadline: opts.deadline } : {}),
      ...(recovery ? { beforeDispatch: () => this.reserveRecoveryBudgetOrThrow(klass) } : {}),
    });
  }

  /**
   * A deadline anchored to this adapter's OWN clock.
   *
   * The adapters inject a virtual clock in tests, so a deadline built on `performance.now()` would
   * be unrelated to the time the test is driving. `Deadline.at` exists precisely for this.
   */
  private deadlineIn(budgetMs: number): Deadline {
    const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 1;
    return Deadline.at(this.clock.now() + budget, budget, () => this.clock.now());
  }

  /**
   * Fast pre-pacing refusal: throw immediately if the shared placement budget is ALREADY spent.
   *
   * A pure read — it does NOT record. Its only job is to avoid sitting through a pacing interval
   * for a placement the budget will refuse anyway; the authoritative check+record still happens at
   * the send boundary in {@link placementBudgetGuard}. A no-op when no ledger is wired.
   */
  private refusePlacementIfBudgetExhausted(clientOrderId: string, purpose?: BoxOrderPurpose): void {
    const ledger = this.config.rateBudget;
    if (!ledger) return;
    const decision = ledger.check("order_place", this.clock.now(), { protective: isProtectivePurpose(purpose) });
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
  private placementBudgetGuard(clientOrderId: string, purpose?: BoxOrderPurpose): () => void {
    const ledger = this.config.rateBudget;
    if (!ledger) return () => undefined;
    const protective = isProtectivePurpose(purpose);
    return () => {
      const now = this.clock.now();
      const decision = ledger.check("order_place", now, { protective });
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
  /**
   * Apply the broker's own cooldown when a request was rate limited.
   *
   * THE DEFECT THIS FIXES. This used to test only `error instanceof KiteHttpError`. But a PLACEMENT
   * that is rate limited does not surface as a bare `KiteHttpError`: the submit path wraps it in a
   * {@link BrokerAmbiguousSubmitError} (correctly — a 429'd POST may or may not exist at the broker).
   * The `instanceof` check therefore missed exactly the case that matters most, so an HTTP 429 with
   * `Retry-After: 30` produced NO penalty and NO cooldown, and the next request went straight back
   * into a budget the broker had just told us to back off from — deepening the throttle.
   *
   * Now the cause chain is walked, so a 429 is honoured wherever it was wrapped.
   */
  private penalizeIfRateLimited(error: unknown): void {
    const ledger = this.config.rateBudget;
    if (!ledger) return;
    const http = findKiteHttpError(error);
    if (!http || !isRateLimited(http.status)) return;
    // ONE 429 RESPONSE MUST COST ONE PENALTY. Several layers may legitimately see the same error
    // (the paced `call()` wrapper and the caller's own catch), and `penalize` extends a cooldown
    // rather than replacing it, so a double call would not shorten the backoff — but it would
    // double-count `penalties`, which operators read as "how often did the broker throttle us".
    // Identity-keyed on the error instance, so two genuinely separate 429s still count twice.
    if (this.penalizedRateLimits.has(http)) return;
    this.penalizedRateLimits.add(http);
    // The broker's OWN instruction, from the response header it actually sent. `parseRetryAfterMs`
    // already understands both documented forms; it was simply never given a header before.
    ledger.penalize(this.clock.now(), parseRetryAfterMs(http.retryAfter, this.clock.now()));
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
    // OUR clock. `order_timestamp` is the broker's IST wall clock and belongs on the exchange axis,
    // not on the axis we measure our own latency against.
    created_at: now,
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
      // The fill's RECEIPT time on our clock. The exchange's own stamp for the same event is on the
      // order as `exchange_updated_at`; mixing the two is what made the latency fields unsound.
      at: now,
    }] : [],
    execution_evidence: verdict.quality,
    reject_family: state === "REJECTED" ? classifyKiteReject(raw.status_message ?? raw.status) : null,
    reject_reason: state === "REJECTED" ? raw.status_message ?? raw.status : verdict.detail,
    // OUR clock, always. The broker's own stamp is carried separately below so the two clocks can
    // never be subtracted from one another by accident.
    updated_at: now,
    exchange_updated_at: parseTime(raw.exchange_update_timestamp),
  };
}

/**
 * Kite order statuses that are TERMINAL — the order can never change again.
 *
 * EXACT matches only, and that is the entire point. See {@link kiteState}.
 */
const KITE_TERMINAL_STATUS: ReadonlyMap<string, BrokerOrderState> = new Map([
  ["COMPLETE", "COMPLETE"],
  ["CANCELLED", "CANCELLED"],
  // Kite reports a cancelled after-market order under its own label. Still terminal.
  ["CANCELLED AMO", "CANCELLED"],
  ["REJECTED", "REJECTED"],
]);

/**
 * Translate a Kite order status into our lifecycle state.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS REPLACES — a substring test that called a PENDING cancellation a FINISHED one:
 *
 * ```ts
 * if (value === "COMPLETE") return "COMPLETE";
 * if (value.includes("CANCEL")) return "CANCELLED";      // ← the defect
 * if (value.includes("REJECT")) return "REJECTED";
 * ```
 *
 * Kite publishes `CANCEL PENDING` (and `CANCEL VALIDATION PENDING`) while a cancellation request is
 * still being worked. Both contain "CANCEL", so both were mapped to `CANCELLED` — which
 * {@link isBrokerOrderTerminal} treats as TERMINAL. `waitForResolution` therefore stopped waiting and
 * reported `state: CANCELLED, filled: 0, pending: 75` for an order that was still live at the
 * exchange and could still fill in full.
 *
 * WHY THAT IS A NAKED-EXPOSURE BUG, not a cosmetic one. The hedge-coverage ledger releases a BUY
 * hedge once its dependent SELL is deemed dead. A short entry sitting in CANCEL PENDING was deemed
 * dead, so its long hedge was released and sold — and then the short filled. The result is a naked
 * short option, created by believing a cancellation that had not happened. `includes("REJECT")` had
 * the same shape and would misread a hypothetical "REJECT PENDING" identically.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULE NOW. Terminal is an EXACT match against {@link KITE_TERMINAL_STATUS}. Everything else is
 * non-terminal, and anything containing "PENDING" is non-terminal *by definition* — the word is
 * Kite's own statement that the outcome is not settled. An unrecognised status is `UNKNOWN`, which is
 * also non-terminal, so a status Kite adds in future fails CLOSED (we keep polling and, on deadline
 * expiry, quarantine) rather than being guessed into a terminal state.
 *
 * The direction of every error here is deliberate: over-waiting on an order that is really finished
 * costs latency and ends in an honest quarantine; under-waiting on an order that is really live
 * destroys a hedge. Only one of those is recoverable.
 */
function kiteState(status: string, filled: number, quantity: number): BrokerOrderState {
  const value = status.trim().toUpperCase();

  const terminal = KITE_TERMINAL_STATUS.get(value);
  if (terminal) return terminal;

  // NON-TERMINAL FROM HERE ON. Nothing below may return COMPLETE, CANCELLED or REJECTED.
  if (value.includes("PENDING")) {
    // A cancellation IN PROGRESS. Reported as CANCEL_REQUESTED so the caller keeps confirming until
    // the broker states a terminal cumulative quantity — the cancel-versus-fill race is decided by
    // the broker, never by us.
    if (value.includes("CANCEL")) return "CANCEL_REQUESTED";
    // TRIGGER PENDING is a resting stop order: live at the exchange, working, not settled.
    if (value === "TRIGGER PENDING") return "OPEN";
    // MODIFY/VALIDATION/OPEN PENDING: accepted, not yet working. A partial fill outranks the label.
    if (filled > 0 && filled < quantity) return "PARTIALLY_FILLED";
    return "ACKNOWLEDGED";
  }

  if (filled > 0 && filled < quantity) return "PARTIALLY_FILLED";
  if (value === "OPEN") return "OPEN";
  if (value === "PUT ORDER REQ RECEIVED" || value === "AMO REQ RECEIVED") return "ACKNOWLEDGED";
  // Unrecognised: NOT terminal. Keep observing rather than inventing an outcome.
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

/**
 * Epoch ms for a Kite order timestamp — an IST wall clock with NO zone suffix.
 *
 * This used to be a bare `Date.parse`, which reads a zone-less date-time as HOST-LOCAL. On a UTC
 * host (every deployment target in `deploy/`) that placed every Kite stamp 5h30m in the future and
 * silently inflated the latency figures derived from it. Delegated to the shared IST parser so both
 * live adapters cannot drift; see `brokerTimestamps.ts` for the full rationale.
 */
function parseTime(value: string | null): number | null {
  return parseIstBrokerTimestamp(value);
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
