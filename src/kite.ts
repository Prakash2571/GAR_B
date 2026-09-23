
/**
 * Minimal Kite Connect v3 client implemented with native `fetch` so it needs no
 * external dependencies.
 *
 * THIS CLIENT DOES NOT OWN THE LOGIN. The api key and access token are INSTALLED into
 * it via `KiteClient.installProvidedToken` — either by the in-app OAuth flow
 * (`src/brokers/zerodha/auth.ts`, the default) or by the external token provider when
 * `BROKER_LOGIN_MODE=provider`. Keeping the exchange out of this class is deliberate: the
 * api SECRET is needed only to compute a login checksum, and it must not be reachable from
 * the object that talks to the data and order endpoints.
 *
 * Docs: https://kite.trade/docs/connect/v3/
 */

import { Deadline } from "./brokers/deadline.js";

const KITE_API_ROOT = "https://api.kite.trade";

/**
 * Default per-request deadline for KiteClient's REST calls (Defect 4).
 *
 * `fetch` has NO timeout of its own, and every method here did `await res.json()` /
 * `await res.text()` AFTER it with nothing bounding either the headers or the body — a single
 * stalled Zerodha socket could hang a profile probe, a quote refresh or the entry-time basket
 * margin forever. The historical endpoints have their own gate/watchdog (HistoricalGate); this
 * bound covers everything else. 8s is generous for a REST call yet finite, and an operator can
 * lower it via `KITE_HTTP_TIMEOUT_MS`.
 */
const KITE_HTTP_TIMEOUT_MS = (() => {
  const raw = process.env.KITE_HTTP_TIMEOUT_MS;
  const v = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(v) ? Math.min(30_000, Math.max(500, Math.round(v))) : 8_000;
})();

export interface KiteConfig {
  apiKey: string;
  /** Unused in this backend (no OAuth checksum); kept optional for config compatibility. */
  apiSecret?: string;
}

export interface SessionData {
  access_token: string;
  user_id: string;
  user_name: string;
  email: string;
  // The API returns many more fields; we keep it open.
  [key: string]: unknown;
}

export interface Instrument {
  instrument_token: number;
  exchange_token: number;
  tradingsymbol: string;
  name: string;
  last_price: number;
  expiry: string;
  strike: number;
  tick_size: number;
  lot_size: number;
  instrument_type: string;
  segment: string;
  exchange: string;
}

export interface OhlcQuote {
  instrument_token: number;
  last_price: number;
  ohlc: { open: number; high: number; low: number; close: number };
}

/** Full quote fields we use: last price, day close, and open interest. */
export interface FullQuote {
  instrument_token: number;
  last_price: number;
  close: number;
  oi: number;
  /**
   * Exchange's own "when did this last trade" stamp, "YYYY-MM-DD HH:MM:SS" in IST,
   * or "" when Kite didn't send one (it is absent for some instruments).
   *
   * This is the only field in a /quote response that reveals whether the market is
   * actually OPEN. On an exchange holiday /quote answers with the previous session's
   * prices and OI and looks entirely normal — see isQuoteFromToday.
   */
  last_trade_time: string;
}

/** Extended full quote that also includes OHLC for EOD capture. */
export interface FullQuoteOhlc {
  instrument_token: number;
  last_price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  oi: number;
}

/** Full historical candle data (OHLCV + OI). */
export interface HistoricalCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number;
}

/**
 * Who is asking for historical candles.
 *
 * `interactive` — a request a user is waiting on (a chart endpoint).
 * `background`  — a scheduler or backfill. Yields to interactive work.
 */
export type HistoricalPriority = "interactive" | "background";

/**
 * Minimum spacing between historical requests. Kite allows ~3/second on that
 * endpoint; 350ms is ~2.9/s, which leaves headroom without being wasteful.
 */
const HISTORICAL_MIN_GAP_MS = 350;

/**
 * A slot is handed back after this long no matter what the request is doing.
 *
 * `fetch` here has no timeout of its own, so without this one stalled connection
 * would hold the gate and every other historical call in the process would queue
 * behind it forever. Releasing early can briefly allow two in flight — which is a
 * far better failure than a wedged queue.
 */
const HISTORICAL_SLOT_TIMEOUT_MS = 20_000;

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Serialises and paces every historical-candle request in the process.
 *
 * Why this exists rather than a `delay()` at each call site. The rate limit is a
 * property of the ACCOUNT, not of any one loop, and this endpoint is used by two
 * very different kinds of caller: the OI/prev-close/hourly/EOD backfills, which can
 * issue hundreds of calls back to back, and the chart endpoints, which issue one or
 * two while a user waits. Per-loop delays only worked because those loops happened
 * to run sequentially; nothing enforced it, and a user opening a stock page during a
 * backfill put both on the wire at once with no coordination — the classic route to
 * a 429 that then poisons a whole reconstruction.
 *
 * Priority is what makes queueing safe here. A plain FIFO queue would fix the rate
 * limit and introduce something worse: a cold-start option backfill is ~180 requests
 * (a minute of wall clock), and a user request landing behind it would appear to
 * hang. Interactive callers therefore jump ahead of every queued background one, so
 * they wait for at most the request in flight plus one gap — well under a second.
 *
 * Background work can in principle be starved by a constant stream of interactive
 * requests. That is the right trade for this app (interactive volume is a handful of
 * page loads) and the backfills are gap-aware, so anything they miss is simply
 * picked up on the next 30-minute pass.
 */
class HistoricalGate {
  private busy = false;
  private lastStartedAt = 0;
  private waiting: { background: boolean; resume: () => void }[] = [];

  /** Timings are constructor args purely so tests can run with short ones. */
  constructor(
    private readonly minGapMs = HISTORICAL_MIN_GAP_MS,
    private readonly slotTimeoutMs = HISTORICAL_SLOT_TIMEOUT_MS,
  ) {}

  async run<T>(prio: HistoricalPriority, call: () => Promise<T>): Promise<T> {
    await this.acquire(prio);
    // Release exactly once, whichever of the watchdog or the finally gets there
    // first, so a slot can never be handed out twice.
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      this.release();
    };
    const watchdog = setTimeout(releaseOnce, this.slotTimeoutMs);
    try {
      const gap = this.minGapMs - (Date.now() - this.lastStartedAt);
      if (gap > 0) await sleepMs(gap);
      // Stamped at START, so the gap paces request starts rather than adding to
      // however long the previous response happened to take.
      this.lastStartedAt = Date.now();
      return await call();
    } finally {
      clearTimeout(watchdog);
      releaseOnce();
    }
  }

  private acquire(prio: HistoricalPriority): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }
    return new Promise<void>((resume) => {
      const entry = { background: prio === "background", resume };
      if (entry.background) {
        this.waiting.push(entry);
        return;
      }
      // Ahead of every queued background call, behind interactive ones already
      // waiting — FIFO within a priority class.
      let i = 0;
      while (i < this.waiting.length && !this.waiting[i]!.background) i++;
      this.waiting.splice(i, 0, entry);
    });
  }

  /** Hand the slot straight to the next waiter, or mark the gate free. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next.resume();
    else this.busy = false;
  }

  /** How many calls are queued behind the one in flight (for logging/tests). */
  get queued(): number {
    return this.waiting.length;
  }
}

const historicalGate = new HistoricalGate();

/** How many historical requests are currently queued. Exposed for logging. */
export function historicalQueueDepth(): number {
  return historicalGate.queued;
}

/** Raw shape of a /quote entry (only the fields we read). */
interface RawFullQuote {
  instrument_token: number;
  last_price?: number;
  ohlc?: { open?: number; high?: number; low?: number; close?: number };
  oi?: number;
  last_trade_time?: string;
  /** Indices carry no last_trade_time; this is the equivalent stamp for them. */
  exchange_timestamp?: string;
}

/** Raw /quote entry including market depth (5 levels of bid/ask). */
interface RawDepthQuote {
  instrument_token: number;
  last_price?: number;
  depth?: {
    buy?: { price?: number; quantity?: number }[];
    sell?: { price?: number; quantity?: number }[];
  };
}

/** Best-bid / best-ask (plus last) for an instrument. */
export interface QuoteDepth {
  last: number;
  bid: number; // best bid (you SELL into this)
  ask: number; // best ask (you BUY at this)
}

/** One price level of the order book. */
export interface DepthLevel {
  price: number;
  qty: number;
}

/** Full 5-level order book (best first) + last price. */
export interface QuoteLadder {
  last: number;
  bids: DepthLevel[]; // buy side, best first
  asks: DepthLevel[]; // sell side, best first
}

/** One order line for the basket-margin request. */
export interface BasketOrder {
  exchange: string;
  tradingsymbol: string;
  transaction_type: "BUY" | "SELL";
  variety: string;
  product: string;
  order_type: string;
  quantity: number;
  price: number;
}

/**
 * One order line for the virtual contract note (POST /charges/orders).
 * Same shape as a basket order except the fill price is `average_price` (the
 * charges are computed on the executed value, not on a limit price).
 */
export interface ChargeOrder {
  order_id: string;
  exchange: string;
  tradingsymbol: string;
  transaction_type: "BUY" | "SELL";
  variety: string;
  product: string;
  order_type: string;
  quantity: number;
  average_price: number;
}

/**
 * The charge heads Zerodha bills per order, exactly as the virtual contract
 * note reports them. Every value is in rupees and already sided: Zerodha only
 * levies STT on the SELL leg of a futures trade and stamp duty only on the BUY
 * leg, so the zeroes in this breakdown are meaningful, not missing data.
 */
export interface OrderChargeBreakdown {
  /** STT (equity/F&O) or CTT (commodities). */
  transaction_tax: number;
  /** Which of the two the above is, as reported by Kite ("stt" / "ctt"). */
  transaction_tax_type: string;
  exchange_turnover_charge: number;
  sebi_turnover_charge: number;
  brokerage: number;
  stamp_duty: number;
  /** GST is 18% of (brokerage + exchange + SEBI), split igst / cgst+sgst. */
  gst: { igst: number; cgst: number; sgst: number; total: number };
  total: number;
}

/** A single order's charges, tied back to the order line we asked about. */
export interface OrderCharges {
  order_id: string;
  tradingsymbol: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  price: number;
  charges: OrderChargeBreakdown;
  /**
   * The untouched `charges` object Kite returned. Persisted alongside the
   * parsed numbers so a new charge head Zerodha introduces is still on record
   * even though this parser doesn't know about it yet.
   */
  raw: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Read Kite's per-order charge object defensively.
 *
 * Every head is optional as far as this parser is concerned: charges are money,
 * so a shape change must degrade to "0 for that head" rather than NaN poisoning
 * the trade's P&L. `total` is taken from the response when present (Zerodha's
 * own rounding is the authority) and otherwise recomputed from the heads.
 */
function parseCharges(raw: unknown): OrderChargeBreakdown {
  const c = (raw ?? {}) as Record<string, unknown>;
  const gstRaw = (c.gst ?? {}) as Record<string, unknown>;

  const igst = num(gstRaw.igst);
  const cgst = num(gstRaw.cgst);
  const sgst = num(gstRaw.sgst);
  const gstTotal = num(gstRaw.total) || igst + cgst + sgst;

  const transaction_tax = num(c.transaction_tax);
  const exchange_turnover_charge = num(c.exchange_turnover_charge);
  const sebi_turnover_charge = num(c.sebi_turnover_charge);
  const brokerage = num(c.brokerage);
  const stamp_duty = num(c.stamp_duty);

  const total =
    num(c.total) ||
    transaction_tax +
      exchange_turnover_charge +
      sebi_turnover_charge +
      brokerage +
      stamp_duty +
      gstTotal;

  return {
    transaction_tax,
    transaction_tax_type:
      typeof c.transaction_tax_type === "string" ? c.transaction_tax_type : "",
    exchange_turnover_charge,
    sebi_turnover_charge,
    brokerage,
    stamp_duty,
    gst: { igst, cgst, sgst, total: gstTotal },
    total,
  };
}

export class KiteError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "KiteError";
    this.status = status;
  }
}

export class KiteClient {
  private apiKey: string;
  private accessToken: string | null = null;
  /**
   * The account (Kite `user_id`) that owns {@link accessToken}, or null when unproven.
   *
   * Deliberately adjacent to the token and only ever written together with it — see
   * {@link installProvidedToken}.
   */
  private accountId: string | null = null;
  /**
   * Notified when the broker rejects this session on an authenticated REST call.
   *
   * Optional so a test or a standalone script can construct a client with no wiring. In the running
   * backend `index.ts` installs it; see {@link setAuthFailureHandler} for what it must do and why
   * clearing the in-memory token alone is not enough.
   */
  private onAuthFailure: ((info: { status: number; endpoint: string }) => void) | null = null;

  constructor(config: KiteConfig) {
    // NO OAUTH IN STRIKEEDGE. The api key and access token are installed by the
    // broker token acquisition service (`installProvidedToken`), which fetches them
    // from the external CalSpread provider. `api_secret` is therefore unused — there is no
    // request-token checksum to compute — and an empty api key at construction is
    // fine because the installer supplies it before the first authenticated call.
    this.apiKey = config.apiKey ?? "";
  }

  /**
   * Install the api key + access token provisioned by the token acquisition
   * service. This REPLACES the Zerodha OAuth login flow: This backend never exchanges
   * a request token itself.
   */
  installProvidedToken(apiKey: string, accessToken: string, account?: string | null): void {
    if (apiKey) this.apiKey = apiKey;
    this.accessToken = accessToken;
    // THE ACCOUNT IS INSTALLED WITH THE TOKEN, IN ONE SYNCHRONOUS STEP.
    //
    // This is the binding that makes an account check at the send boundary mean anything. The
    // execution path resolves the credential LAZILY, per HTTP call, from this object — so the token
    // used for a POST is read from mutable process state AFTER the order was already authorised. If
    // the account identity lived anywhere else (a separate session-metadata field updated a moment
    // later, say), then between those two writes the process would be holding account B's
    // credential while still believing it was acting as account A, and no guard downstream could
    // detect it. Writing both here, with no await in between, makes that window structurally
    // impossible: whoever reads the token can read the account that owns it.
    //
    // `undefined` means the caller did not name an account — the identity is UNPROVEN, which is
    // recorded as null rather than silently inheriting the previous account's name.
    this.accountId = typeof account === "string" && account.trim() !== "" ? account.trim() : null;
  }

  /**
   * The broker account the CURRENTLY INSTALLED access token belongs to, or null when unproven.
   *
   * Read at the send boundary to confirm that the credential about to be used still belongs to the
   * account an order was authorised under. Null is honest and must never be treated as a match.
   */
  getSessionAccount(): string | null {
    return this.accountId;
  }

  /**
   * Run a fetch+body-read under a SINGLE absolute deadline (Defect 4).
   *
   * The AbortController's signal is threaded into `fetch`, and the timer is cleared only AFTER
   * `fn` has consumed the body — so a stalled header AND a stalled body both abort, rather than
   * the body read hanging unbounded once headers arrive. The `Deadline` uses a monotonic clock,
   * so an NTP step cannot make the timeout fire early or never. On abort, `fetch`/`res.json()`
   * reject with an AbortError, which the callers already translate into a `KiteError`.
   *
   * This is a READ/idempotent bound only. KiteClient issues no order mutations (those go through
   * KiteHttpTransport), so timing out here is always safe to surface — there is no write whose
   * outcome could be left ambiguous.
   */
  private async withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = Deadline.in(KITE_HTTP_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline.timerMs());
    try {
      return await fn(controller.signal);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new KiteError(`Kite request exceeded ${KITE_HTTP_TIMEOUT_MS}ms deadline.`, 504);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A bounded authenticated GET returning `{ status, ok, json }` (Defect 4).
   *
   * Both the headers and the JSON body are consumed INSIDE the deadline, so neither can hang
   * unbounded. Callers keep their exact success/error handling; only the transport is bounded.
   */
  private async getJson<J>(url: string): Promise<{ status: number; ok: boolean; json: J }> {
    return this.withDeadline(async (signal) => {
      const res = await fetch(url, { headers: this.authHeader(), signal });
      const json = (await res.json()) as J;
      return { status: res.status, ok: res.ok, json };
    });
  }

  /** A bounded authenticated JSON POST returning `{ status, ok, json }` (Defect 4). */
  private async postJson<J>(url: string, body: unknown): Promise<{ status: number; ok: boolean; json: J }> {
    return this.withDeadline(async (signal) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...this.authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const json = (await res.json()) as J;
      return { status: res.status, ok: res.ok, json };
    });
  }

  /**
   * Step 2/3 — NOT IMPLEMENTED HERE, ON PURPOSE.
   *
   * The request-token exchange lives in `src/brokers/zerodha/auth.ts`
   * (`exchangeZerodhaRequestToken`), not on this client, so the api SECRET stays out of
   * the object that holds the data/order transport. `ActiveBrokerManager.completeZerodhaLogin`
   * performs the exchange and then calls {@link installProvidedToken} here.
   *
   * Retained as a throwing stub so a caller reaching for the wrong seam fails loudly and
   * is pointed at the right one, rather than silently doing nothing.
   */
  async generateSession(_requestToken: string): Promise<SessionData> {
    throw new KiteError(
      "KiteClient does not perform the Zerodha request-token exchange. Use " +
        "exchangeZerodhaRequestToken() in src/brokers/zerodha/auth.ts (or " +
        "ActiveBrokerManager.completeZerodhaLogin), which then installs the token here.",
      400,
    );
  }

  /**
   * Allow restoring a previously obtained access token (e.g. from a store).
   *
   * The account is CLEARED rather than left in place: this seam takes a bare token with no identity,
   * so retaining the previous account's name would attach a stale claim to a new credential — the
   * exact confusion the account/token binding exists to prevent. Callers that know the account
   * should use {@link installProvidedToken} instead.
   */
  setAccessToken(token: string): void {
    this.accessToken = token;
    this.accountId = null;
  }

  hasSession(): boolean {
    return this.accessToken !== null;
  }

  /** The app's API key (public; needed for the WebSocket URL). */
  getApiKey(): string {
    return this.apiKey;
  }

  /** The current access token, or null if not yet authenticated. */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  /** Forget the current session (logout). Subsequent calls require re-login. */
  clearSession(): void {
    this.accessToken = null;
    // The account goes with the token. A cleared session that still named an account would let a
    // send-boundary check "match" against an identity backed by no credential at all.
    this.accountId = null;
  }

  /**
   * Install the callback fired when the broker REJECTS this session on an authenticated REST call.
   *
   * WHY THIS EXISTS — the REST path used to do a quarter of the job.
   *
   * Every authenticated read in this class ends with `if (status === 401 || status === 403)
   * this.clearSession()`. That clears IN-PROCESS state and nothing else. The WebSocket death path in
   * `index.ts` does four things for the same event: clears the in-memory token, forgets the session
   * METADATA on the broker manager, invalidates the ENCRYPTED ROW in `broker_sessions`, and tells the
   * engine to drop its cached books. The REST path did one of the four.
   *
   * The consequence is a dead token that survives a restart. The operator signs in to kite.zerodha.com
   * or the Kite mobile app at 12:30 — Kite permits ONE active access_token per api_key, so the API
   * token dies immediately. The next REST call 403s and clears memory, but the encrypted row still
   * carries TODAY's `login_date` and the matching api key. Any restart (a deploy, an OOM kill, a
   * systemd restart) then runs `restore()` → `adoptStoredKiteSession()`, which validated exactly two
   * things — same IST day, same api key — and installed the corpse. `sessionFor` reported
   * `authenticated: true`, `healthFor` reported `data_ready: true` and `trading_ready: true`, and the
   * dashboard showed a healthy session with no problems.
   *
   * Then the Box engine arms against it. Every leg POST 403s. On a four-leg box that is a partially
   * filled spread you can neither complete nor cancel, with the status surface claiming health
   * throughout.
   *
   * FIRE-AND-FORGET BY CONTRACT. The handler must never throw into the calling REST path and must
   * never be awaited there: a durable-store failure while invalidating a session cannot be allowed to
   * mask or replace the broker error the caller is already handling.
   */
  setAuthFailureHandler(handler: (info: { status: number; endpoint: string }) => void): void {
    this.onAuthFailure = handler;
  }

  /**
   * The broker rejected this session on an authenticated call. Drop it, and tell everyone who holds
   * state derived from it.
   *
   * Called INSTEAD OF a bare `clearSession()` at every 401/403 site, so there is one place that
   * decides what session death means and it cannot be partially implemented at one call site.
   */
  private noteAuthFailure(status: number, endpoint: string): void {
    if (status !== 401 && status !== 403) return;
    const had = this.accessToken !== null;
    this.clearSession();
    // Only escalate when there WAS a session to lose. A 401 raised because no token is installed yet
    // (`authHeader()` throws exactly that) is not session death and must not invalidate a stored row
    // that a concurrent login may be in the middle of writing.
    if (!had) return;
    try {
      this.onAuthFailure?.({ status, endpoint });
    } catch {
      // A handler fault must not become the error the caller sees. The token is already cleared, which
      // is the part that stops this process hammering Kite with a dead credential.
    }
  }

  private authHeader(): Record<string, string> {
    if (!this.accessToken) {
      throw new KiteError(
        "Zerodha access token is not installed yet. Sign in to Zerodha from the workspace " +
          "(POST /api/broker/zerodha/login/start), or — when BROKER_LOGIN_MODE=provider — wait for " +
          "token acquisition to complete. See GET /api/runtime/status for the current token state.",
        401,
      );
    }
    return {
      "X-Kite-Version": "3",
      Authorization: `token ${this.apiKey}:${this.accessToken}`,
    };
  }

  /** Authenticated user profile (the /user/ docs endpoint). */
  async getProfile(): Promise<Record<string, unknown>> {
    // Header AND body under one deadline: the body read lives inside the callback so a stalled
    // body aborts too, instead of `res.json()` hanging after the headers arrive.
    const { status, ok, json } = await this.withDeadline(async (signal) => {
      const res = await fetch(`${KITE_API_ROOT}/user/profile`, { headers: this.authHeader(), signal });
      const body = (await res.json()) as { status: string; data?: Record<string, unknown>; message?: string };
      return { status: res.status, ok: res.ok, json: body };
    });
    if (!ok || json.status !== "success" || !json.data) {
      // A rejected/expired token means the session is dead — drop it.
      if (status === 401 || status === 403) this.noteAuthFailure(status, "/user/profile");
      throw new KiteError(
        json.message ?? `Failed to fetch profile (HTTP ${status}).`,
        status || 500,
      );
    }
    return json.data;
  }

  /**
   * ACCOUNT FUNDS — the equity segment's available balance and what is already blocked.
   *
   * WHY THIS LIVES ON THE MARKET-DATA CLIENT AND NOT ONLY ON THE LIVE ORDER ADAPTER
   *
   * `KiteBrokerAdapter.margins()` already reads this endpoint, but that adapter is constructed only
   * on the LIVE path. An operator running a paper rehearsal has a perfectly good authenticated
   * Zerodha session — it is the same session streaming their prices — and "how much can I actually
   * trade with?" is exactly the question they need answered BEFORE arming, not after. Reading it
   * here makes the figure available in every mode that has a session, which is the only way the
   * number is useful when it matters.
   *
   * WHAT THE TWO FIELDS MEAN, and why both are returned. `available.live_balance` is Zerodha's
   * spendable figure; `utilised.debits` is what is already blocked. This method does NOT combine
   * them: whether `available` is already net of the encumbrance is a per-broker semantic decided in
   * `src/box/fundsSemantics.ts`, and doing that arithmetic in two places is how the two answers come
   * to disagree. Both numbers travel; the meaning is applied once, elsewhere.
   *
   * NULL IS "UNKNOWN", NEVER "ZERO". A field the response does not carry stays null, so a caller can
   * never mistake an absent figure for an empty account. `Number.isFinite(0)` is true, so presence is
   * decided by the parse, not by the value.
   *
   * THROWS on an auth failure (and drops the session, like every other authenticated read here), so a
   * dead token surfaces as a dead token rather than as ₹0.
   */
  async getFunds(): Promise<{
    available: number | null;
    utilised: number | null;
    components: Record<string, number | null>;
  }> {
    const { status, ok, json } = await this.getJson<{
      status: string;
      data?: {
        net?: unknown;
        available?: Record<string, unknown>;
        utilised?: Record<string, unknown>;
      };
      message?: string;
    }>(`${KITE_API_ROOT}/user/margins/equity`);
    if (!ok || json.status !== "success" || !json.data) {
      if (status === 401 || status === 403) this.noteAuthFailure(status, "/user/margins/equity");
      throw new KiteError(json.message ?? `Failed to fetch funds (HTTP ${status}).`, status || 500);
    }
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    /*
     * CAPTURE THE WHOLE BREAKDOWN, not just the two headline numbers.
     *
     * This response carries a dozen distinct figures and this method used to read two and discard
     * the rest — so an operator whose headline read far below their own Kite funds screen had no way
     * to find out which component accounted for the difference. The evidence was fetched, parsed and
     * thrown away in the same function.
     *
     * Every nested numeric is forwarded under its VENDOR field name (`available.collateral`,
     * `utilised.span`, …) so the published snapshot can be held beside the broker's screen and
     * compared directly. Non-numeric and absent fields are simply not present — `null` here would
     * claim the broker reported an unknown, which is different from not reporting the field at all.
     */
    const components: Record<string, number | null> = {};
    const net = num(json.data.net);
    if (net !== null) components.net = net;
    for (const group of ["available", "utilised"] as const) {
      const bag = json.data[group];
      if (bag === null || typeof bag !== "object") continue;
      for (const [key, raw] of Object.entries(bag as Record<string, unknown>)) {
        const value = num(raw);
        if (value !== null) components[`${group}.${key}`] = value;
      }
    }
    return {
      // Unchanged: the DEFAULT basis stays `available.live_balance`, so nothing about the figure this
      // method has always returned is altered by capturing more of the payload.
      available: num(json.data.available?.live_balance),
      utilised: num(json.data.utilised?.debits),
      components,
    };
  }

  /**
   * Fetch OHLC + last price for a set of instruments via REST.
   * Identifiers are "exchange:tradingsymbol" (e.g. "NSE:INFY", "NFO:INFY24JULFUT").
   * Works regardless of market hours (returns the latest available snapshot),
   * and handles the 500-instruments-per-request limit by chunking.
   */
  async getQuoteOhlc(identifiers: string[]): Promise<OhlcQuote[]> {
    const out: OhlcQuote[] = [];
    for (let i = 0; i < identifiers.length; i += 500) {
      const chunk = identifiers.slice(i, i + 500);
      const qs = chunk.map((id) => `i=${encodeURIComponent(id)}`).join("&");
      const { status, ok, json } = await this.getJson<{
        status: string;
        data?: Record<string, OhlcQuote>;
        message?: string;
      }>(`${KITE_API_ROOT}/quote/ohlc?${qs}`);
      if (!ok || json.status !== "success" || !json.data) {
        if (status === 401 || status === 403) this.noteAuthFailure(status, "/quote/ohlc");
        throw new KiteError(
          json.message ?? `Failed to fetch quotes (HTTP ${status}).`,
          status || 500,
        );
      }
      for (const v of Object.values(json.data)) {
        if (v && typeof v.instrument_token === "number") out.push(v);
      }
    }
    return out;
  }

  /**
   * Full quote (/quote): includes last price, OHLC close AND open interest (oi)
   * for F&O instruments. Chunked at 500 identifiers per request.
   */
  async getQuoteFull(identifiers: string[]): Promise<FullQuote[]> {
    const out: FullQuote[] = [];
    for (let i = 0; i < identifiers.length; i += 500) {
      const chunk = identifiers.slice(i, i + 500);
      const qs = chunk.map((id) => `i=${encodeURIComponent(id)}`).join("&");
      const { status, ok, json } = await this.getJson<{
        status: string;
        data?: Record<string, RawFullQuote>;
        message?: string;
      }>(`${KITE_API_ROOT}/quote?${qs}`);
      if (!ok || json.status !== "success" || !json.data) {
        if (status === 401 || status === 403) this.noteAuthFailure(status, "/quote");
        throw new KiteError(
          json.message ?? `Failed to fetch quotes (HTTP ${status}).`,
          status || 500,
        );
      }
      for (const v of Object.values(json.data)) {
        if (v && typeof v.instrument_token === "number") {
          out.push({
            instrument_token: v.instrument_token,
            last_price: v.last_price ?? 0,
            close: v.ohlc?.close ?? 0,
            oi: v.oi ?? 0,
            // Prefer the trade stamp; fall back to the exchange stamp, which is
            // what an INDEX carries (the NIFTY spot has no "last trade").
            last_trade_time: v.last_trade_time ?? v.exchange_timestamp ?? "",
          });
        }
      }
    }
    return out;
  }

  /**
   * Full quote with OHLC (/quote): includes last price, full OHLC, and open
   * interest (oi) for F&O instruments. Used by the EOD capture scheduler.
   * Chunked at 500 identifiers per request.
   */
  async getQuoteFullOhlc(identifiers: string[]): Promise<FullQuoteOhlc[]> {
    const out: FullQuoteOhlc[] = [];
    for (let i = 0; i < identifiers.length; i += 500) {
      const chunk = identifiers.slice(i, i + 500);
      const qs = chunk.map((id) => `i=${encodeURIComponent(id)}`).join("&");
      const { status, ok, json } = await this.getJson<{
        status: string;
        data?: Record<string, RawFullQuote>;
        message?: string;
      }>(`${KITE_API_ROOT}/quote?${qs}`);
      if (!ok || json.status !== "success" || !json.data) {
        if (status === 401 || status === 403) this.noteAuthFailure(status, "/quote");
        throw new KiteError(
          json.message ?? `Failed to fetch quotes (HTTP ${status}).`,
          status || 500,
        );
      }
      for (const v of Object.values(json.data)) {
        if (v && typeof v.instrument_token === "number") {
          out.push({
            instrument_token: v.instrument_token,
            last_price: v.last_price ?? 0,
            open: v.ohlc?.open ?? 0,
            high: v.ohlc?.high ?? 0,
            low: v.ohlc?.low ?? 0,
            close: v.ohlc?.close ?? 0,
            oi: v.oi ?? 0,
          });
        }
      }
    }
    return out;
  }

  /**
   * Best bid/ask (market depth) per instrument, keyed by instrument_token.
   * Used to fill trades realistically: buy at ask, sell at bid.
   */
  async getQuoteDepth(identifiers: string[]): Promise<Map<number, QuoteDepth>> {
    const out = new Map<number, QuoteDepth>();
    for (let i = 0; i < identifiers.length; i += 500) {
      const chunk = identifiers.slice(i, i + 500);
      const qs = chunk.map((id) => `i=${encodeURIComponent(id)}`).join("&");
      const { status, ok, json } = await this.getJson<{
        status: string;
        data?: Record<string, RawDepthQuote>;
        message?: string;
      }>(`${KITE_API_ROOT}/quote?${qs}`);
      if (!ok || json.status !== "success" || !json.data) {
        if (status === 401 || status === 403) this.noteAuthFailure(status, "/quote");
        throw new KiteError(
          json.message ?? `Failed to fetch quotes (HTTP ${status}).`,
          status || 500,
        );
      }
      for (const v of Object.values(json.data)) {
        if (v && typeof v.instrument_token === "number") {
          const last = v.last_price ?? 0;
          const bid = v.depth?.buy?.[0]?.price ?? last;
          const ask = v.depth?.sell?.[0]?.price ?? last;
          out.set(v.instrument_token, { last, bid, ask });
        }
      }
    }
    return out;
  }

  /**
   * Full 5-level order book per instrument. Fills are taken at the touch (best
   * bid / best ask); the deeper levels are kept because they show the size
   * behind the quote.
   */
  async getQuoteLadder(identifiers: string[]): Promise<Map<number, QuoteLadder>> {
    const out = new Map<number, QuoteLadder>();
    for (let i = 0; i < identifiers.length; i += 500) {
      const chunk = identifiers.slice(i, i + 500);
      const qs = chunk.map((id) => `i=${encodeURIComponent(id)}`).join("&");
      const { status, ok, json } = await this.getJson<{
        status: string;
        data?: Record<string, RawDepthQuote>;
        message?: string;
      }>(`${KITE_API_ROOT}/quote?${qs}`);
      if (!ok || json.status !== "success" || !json.data) {
        if (status === 401 || status === 403) this.noteAuthFailure(status, "/quote");
        throw new KiteError(
          json.message ?? `Failed to fetch quotes (HTTP ${status}).`,
          status || 500,
        );
      }
      for (const v of Object.values(json.data)) {
        if (v && typeof v.instrument_token === "number") {
          const toLevels = (arr?: { price?: number; quantity?: number }[]) =>
            (arr ?? [])
              .map((l) => ({ price: l.price ?? 0, qty: l.quantity ?? 0 }))
              .filter((l) => l.price > 0);
          out.set(v.instrument_token, {
            last: v.last_price ?? 0,
            bids: toLevels(v.depth?.buy),
            asks: toLevels(v.depth?.sell),
          });
        }
      }
    }
    return out;
  }

  /**
   * Basket margin (/margins/basket): margin for a set of orders.
   *
   * VERIFIED against https://kite.trade/docs/connect/v3/margins/ (2026-09-10). The response has two
   * distinct blocks and the documentation defines them as:
   *
   *   initial — "Total margins required to execute the orders"
   *   final   — "Total margins with the spread benefit"
   *
   * They are NOT interchangeable. In Zerodha's own documented example the same two-leg basket shows
   * initial ₹96,504.98 and final ₹34,786.73 — a factor of ~2.8. `final` describes the COMPLETED
   * hedged structure; it is not evidence that the account can fund the SEQUENCE that creates it,
   * because at the first leg no spread benefit exists yet.
   *
   * WHAT THIS USED TO DO, AND WHY IT WAS WRONG. It returned `total: final || initial`, which
   *   (a) handed callers the spread-benefit figure as the funding number, and
   *   (b) silently fell back to `initial` whenever `final.total` was 0 — a legitimate value — so the
   *       caller could not tell which of two very different quantities it had received.
   *
   * Now `initial` and `final` are both preserved, `total` names which one it is via `total_basis`,
   * and a missing block is reported as `null` rather than coerced to 0. `total` remains `final` when
   * present, because that is the right number for DISPLAYING the margin of a completed box; callers
   * making a FUNDING decision must use the stage model in src/box/boxCapital.ts, which consumes
   * `initial` and `final` separately.
   *
   * `option_premium` is a COMPONENT of each block's `total` (see the documented margin structure), so
   * premium must never be added on top of these figures — that would double-count it.
   */
  async getBasketMargin(
    orders: BasketOrder[],
  ): Promise<{
    initial: number;
    final: number;
    total: number;
    initial_available: boolean;
    final_available: boolean;
    total_basis: "final" | "initial" | "unavailable";
  }> {
    const { status, ok, json } = await this.postJson<{
      status: string;
      data?: { initial?: { total?: number }; final?: { total?: number } };
      message?: string;
    }>(`${KITE_API_ROOT}/margins/basket?consider_positions=true`, orders);
    if (!ok || json.status !== "success" || !json.data) {
      if (status === 401 || status === 403) this.noteAuthFailure(status, "/margins/basket");
      throw new KiteError(
        json.message ?? `Failed to fetch basket margin (HTTP ${status}).`,
        status || 500,
      );
    }
    // PRESENCE is tracked separately from VALUE: a block Zerodha did not send is UNKNOWN, and a
    // block whose total is genuinely 0 is a real zero. Collapsing the two with `??  0` is what made
    // the old `final || initial` fallback undetectable.
    const rawInitial = json.data.initial?.total;
    const rawFinal = json.data.final?.total;
    const initialAvailable = typeof rawInitial === "number" && Number.isFinite(rawInitial);
    const finalAvailable = typeof rawFinal === "number" && Number.isFinite(rawFinal);
    const initial = initialAvailable ? (rawInitial as number) : 0;
    const final = finalAvailable ? (rawFinal as number) : 0;
    return {
      initial,
      final,
      total: finalAvailable ? final : initial,
      initial_available: initialAvailable,
      final_available: finalAvailable,
      total_basis: finalAvailable ? "final" : initialAvailable ? "initial" : "unavailable",
    };
  }

  /**
   * Virtual contract note (/charges/orders): the exact brokerage and statutory
   * charges Zerodha would bill for a set of executed orders.
   *
   * This is the ONLY source of charge numbers in this app — we never reimplement
   * Zerodha's rate card locally, because the rates change (STT, stamp duty and
   * exchange slabs have all moved in recent years) and a stale local formula
   * would silently misstate every trade's P&L.
   *
   * Results come back in request order; we still carry each request's order_id
   * across so a caller can match a response to its leg without trusting order.
   */
  async getOrderCharges(orders: ChargeOrder[]): Promise<OrderCharges[]> {
    if (orders.length === 0) return [];

    const { status, ok, json } = await this.postJson<{
      status: string;
      data?: unknown;
      message?: string;
    }>(`${KITE_API_ROOT}/charges/orders`, orders);

    if (!ok || json.status !== "success" || !Array.isArray(json.data)) {
      if (status === 401 || status === 403) this.noteAuthFailure(status, "/charges/orders");
      throw new KiteError(
        json.message ?? `Failed to fetch order charges (HTTP ${status}).`,
        status || 500,
      );
    }

    const rows = json.data as Record<string, unknown>[];
    return rows.map((row, i) => {
      const req = orders[i];
      const chargesRaw = row?.charges;
      return {
        order_id:
          typeof row?.order_id === "string" && row.order_id
            ? row.order_id
            : (req?.order_id ?? String(i)),
        tradingsymbol:
          typeof row?.tradingsymbol === "string"
            ? row.tradingsymbol
            : (req?.tradingsymbol ?? ""),
        transaction_type:
          row?.transaction_type === "SELL" || row?.transaction_type === "BUY"
            ? row.transaction_type
            : (req?.transaction_type ?? "BUY"),
        quantity: num(row?.quantity) || (req?.quantity ?? 0),
        price: num(row?.price) || (req?.average_price ?? 0),
        charges: parseCharges(chargesRaw),
        raw: chargesRaw ?? null,
      };
    });
  }

  /**
   * Fetch + validate one historical-candle request, through the shared gate.
   *
   * All four historical methods differ only in how they MAP the candle rows, so the
   * request, the error handling and the rate gate live here once. Returns raw Kite
   * candle rows: [timestamp, open, high, low, close, volume, oi].
   */
  private async historicalCandles(
    url: string,
    prio: HistoricalPriority,
  ): Promise<unknown[][]> {
    return historicalGate.run(prio, async () => {
      // Inside the gate for pacing, but the network+body are ALSO bounded by the request
      // deadline (Defect 4): the gate's slot watchdog only hands the SLOT back, it never aborts
      // a stalled socket, so without this a hung body read would still occupy a connection and
      // return to no one.
      const { status, ok, json } = await this.getJson<{
        status: string;
        data?: { candles?: unknown[][] };
        message?: string;
      }>(url);
      if (!ok || json.status !== "success" || !json.data?.candles) {
        if (status === 401 || status === 403) this.noteAuthFailure(status, "/historicalCandles");
        throw new KiteError(
          json.message ?? `Failed to fetch historical data (HTTP ${status}).`,
          status || 500,
        );
      }
      return json.data.candles;
    });
  }

  /**
   * Historical daily candles WITH open interest (oi=1) for one instrument.
   * Returns the day's close price and closing open interest per trading day.
   * `from`/`to` are "yyyy-mm-dd". Requires the historical-data subscription.
   */
  async getHistoricalOi(
    token: number,
    from: string,
    to: string,
    prio: HistoricalPriority = "interactive",
  ): Promise<{ date: string; close: number; oi: number }[]> {
    const url =
      `${KITE_API_ROOT}/instruments/historical/${token}/day` +
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&oi=1`;
    const candles = await this.historicalCandles(url, prio);
    return candles.map((c) => ({
      date: String(c[0] ?? "").slice(0, 10),
      close: Number(c[4] ?? 0),
      oi: Number(c[6] ?? 0),
    }));
  }

  /**
   * Historical daily candles with full OHLCV + OI data for one instrument.
   * Kite candle format: [timestamp, open, high, low, close, volume, oi].
   * `from`/`to` are "yyyy-mm-dd". Requires the historical-data subscription.
   */
  async getHistoricalFull(
    token: number,
    from: string,
    to: string,
    interval = "day",
    prio: HistoricalPriority = "interactive",
  ): Promise<HistoricalCandle[]> {
    const url =
      `${KITE_API_ROOT}/instruments/historical/${token}/${interval}` +
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&oi=1`;
    const candles = await this.historicalCandles(url, prio);
    return candles.map((c) => ({
      date: String(c[0] ?? "").slice(0, 10),
      open: Number(c[1] ?? 0),
      high: Number(c[2] ?? 0),
      low: Number(c[3] ?? 0),
      close: Number(c[4] ?? 0),
      volume: Number(c[5] ?? 0),
      oi: Number(c[6] ?? 0),
    }));
  }

  /**
   * Historical candles at any interval (e.g. "60minute" for hourly).
   * Returns the full timestamp + close price per candle.
   */
  async getHistorical(
    token: number,
    from: string,
    to: string,
    interval: string,
    prio: HistoricalPriority = "interactive",
  ): Promise<{ t: string; close: number }[]> {
    const url =
      `${KITE_API_ROOT}/instruments/historical/${token}/${interval}` +
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const candles = await this.historicalCandles(url, prio);
    return candles.map((c) => ({
      t: String(c[0] ?? ""),
      close: Number(c[4] ?? 0),
    }));
  }

  /**
   * Historical candles at any interval, keeping the FULL candle timestamp AND
   * open interest (oi=1). Unlike getHistoricalOi/getHistoricalFull (which slice
   * the timestamp down to the day), this preserves minute-resolution time so we
   * can reconstruct intraday OI series across days for the analytics frames.
   * Kite candle format: [timestamp, open, high, low, close, volume, oi].
   */
  async getHistoricalOiSeries(
    token: number,
    from: string,
    to: string,
    interval: string,
    prio: HistoricalPriority = "interactive",
  ): Promise<{ t: string; close: number; oi: number }[]> {
    const url =
      `${KITE_API_ROOT}/instruments/historical/${token}/${interval}` +
      `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&oi=1`;
    const candles = await this.historicalCandles(url, prio);
    return candles.map((c) => ({
      t: String(c[0] ?? ""),
      close: Number(c[4] ?? 0),
      oi: Number(c[6] ?? 0),
    }));
  }

  /**
   *
   * The instruments master is a static daily file. We try WITHOUT an access
   * token first (so you can get the stock list with no login). If Zerodha
   * rejects the unauthenticated request and we do have a session, we retry
   * with the Authorization header.
   */
  async getInstruments(exchange?: string): Promise<Instrument[]> {
    const url = exchange
      ? `${KITE_API_ROOT}/instruments/${encodeURIComponent(exchange)}`
      : `${KITE_API_ROOT}/instruments`;

    // Attempt 1: no access token (works for the public instruments dump).
    let res = await fetch(url, { headers: { "X-Kite-Version": "3" } });

    // Attempt 2: if blocked and we have a session, retry authenticated.
    if (!res.ok && this.accessToken) {
      res = await fetch(url, { headers: this.authHeader() });
    }

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        /*
         * DO NOT CLEAR THE SESSION FROM THIS ENDPOINT.
         *
         * This used to call `clearSession()`, which was defensible while the only caller was a
         * browser-initiated `/api/quotes`. It is no longer: the box engine's universe pass now reads
         * this endpoint on a timer, and `marketData().isAuthenticated()` for Zerodha is exactly
         * `getAccessToken() !== null`. So one 403 here would drop the in-memory token, every
         * subsequent universe pass would return early at its authentication guard, and the deployment
         * would sit unauthenticated until a human signed in again — an unattended PM2 process
         * logged out by a transient broker response.
         *
         * The instruments dump is also the WEAKEST possible evidence about a token: attempt 1 is
         * deliberately unauthenticated because the dump is public, so a 403 here frequently says
         * something about the endpoint or an edge/WAF rather than about the credential. Genuine token
         * rejection is detected where it is unambiguous — an authenticated trading/quote call, and the
         * market-data socket's policy close codes — both of which still clear the session.
         *
         * The error is still thrown, and now carries the response body so the real cause is visible.
         */
        throw new KiteError(
          `Zerodha refused the instruments list (HTTP ${res.status}). The instruments dump is ` +
            `normally public, so this is more often an endpoint or gateway refusal than an expired ` +
            `token — the session is deliberately NOT cleared here. If it persists, verify the ` +
            `session and re-authenticate. Response: ${text.slice(0, 200)}`,
          res.status,
        );
      }
      throw new KiteError(
        `Failed to fetch instruments (HTTP ${res.status}): ${text.slice(0, 200)}`,
        res.status || 500,
      );
    }

    const csv = await res.text();
    return parseInstrumentsCsv(csv);
  }
}

/** Parse the Kite instruments CSV into typed rows. */
export function parseInstrumentsCsv(csv: string): Instrument[] {
  const lines = csv.trim().split("\n");
  if (lines.length <= 1) return [];

  const header = splitCsvLine(lines[0]!);
  const idx = (key: string) => header.indexOf(key);

  const iToken = idx("instrument_token");
  const eToken = idx("exchange_token");
  const tSymbol = idx("tradingsymbol");
  const name = idx("name");
  const lastPrice = idx("last_price");
  const expiry = idx("expiry");
  const strike = idx("strike");
  const tickSize = idx("tick_size");
  const lotSize = idx("lot_size");
  const iType = idx("instrument_type");
  const segment = idx("segment");
  const exchange = idx("exchange");

  const rows: Instrument[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = splitCsvLine(line);
    rows.push({
      instrument_token: Number(c[iToken] ?? 0),
      exchange_token: Number(c[eToken] ?? 0),
      tradingsymbol: c[tSymbol] ?? "",
      name: c[name] ?? "",
      last_price: Number(c[lastPrice] ?? 0),
      expiry: c[expiry] ?? "",
      strike: Number(c[strike] ?? 0),
      tick_size: Number(c[tickSize] ?? 0),
      lot_size: Number(c[lotSize] ?? 0),
      instrument_type: c[iType] ?? "",
      segment: c[segment] ?? "",
      exchange: c[exchange] ?? "",
    });
  }
  return rows;
}

/** Split a single CSV line, honouring simple double-quote quoting. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
