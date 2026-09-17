/**
 * BrokerTokenAcquisitionService — the daily, per-broker token acquisition loop.
 *
 * WHAT IT DOES
 * Each trading morning at BROKER_TOKEN_POLL_START (09:00 IST) it asks the external CalSpread
 * provider for a Zerodha token and a Dhan token, INDEPENDENTLY. Each broker has its
 * own state machine, its own timer and its own in-flight guard, so:
 *   - the two requests can run concurrently but never overwrite each other;
 *   - one slow or failing provider never blocks or discards the other's token;
 *   - success stops polling ONLY for that broker, for that IST day.
 *
 * SCHEDULING (no uptime drift)
 * Before 09:00 IST it schedules the first attempt for 09:00. If the process starts
 * AFTER 09:00 and a broker lacks a valid token for the current IST day, it fetches
 * IMMEDIATELY. All delays are computed from the current IST wall time via
 * `istClock`, so a process up for days still fires at 09:00, not 09:00-plus-uptime.
 *
 * WHAT SUCCESS TRIGGERS (via INJECTED callbacks, never a direct engine import)
 * On a validated token the service persists it (encrypted) and calls the callbacks
 * the boot wiring supplied. For Zerodha, `onZerodhaReady` installs the key+token
 * into the Kite client, loads the universe, and — ONLY IF Zerodha is the ACTIVE
 * broker — starts the single Box WebSocket, resubscribes, invalidates stale books
 * and lets scanner readiness follow fresh depth. This module imports NONE of the
 * engine; it only calls what it was handed.
 *
 * WHAT IT NEVER DOES
 * Token acquisition, storage and market data NEVER arm live trading. There is no
 * path here that flips a live gate or constructs a mutation-capable adapter.
 */

import {
  fetchBrokerToken,
  type BrokerKind,
  type FetchLike,
  type TokenFetchResult,
  type TokenProviderConfig,
} from "./tokenProviderClient.js";
import { istDayKey, msUntilNextDailyTime, isAtOrAfterIstTime, type IstClock } from "./istClock.js";

/** Per-broker acquisition state, surfaced in the runtime status object. */
export type TokenState = "waiting" | "polling" | "ready" | "invalid" | "configuration_error";

/** The status of one broker, safe to publish (no token, no passcode ever). */
export interface BrokerTokenStatus {
  broker: BrokerKind;
  state: TokenState;
  istDay: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  /** Short, redacted error. Never a token, passcode or full response body. */
  lastError: string | null;
  feedConnected: boolean;
  wantedTokenCount: number;
  subscribedTokenCount: number;
  lastAuthoritativeDepthAgeMs: number | null;
  reconnectCount: number;
}

/** Feed/health facts the service reads for the status object (read-only). */
export interface BrokerFeedProbe {
  feedConnected: (broker: BrokerKind) => boolean;
  wantedTokenCount: (broker: BrokerKind) => number;
  subscribedTokenCount: (broker: BrokerKind) => number;
  lastAuthoritativeDepthAgeMs: (broker: BrokerKind) => number | null;
  reconnectCount: (broker: BrokerKind) => number;
}

/**
 * The side effects the boot wiring supplies. NONE of these are implemented here —
 * this keeps the engine out of this module and makes the "only the active broker's
 * WebSocket opens" rule enforceable by the caller.
 */
export interface TokenAcquisitionCallbacks {
  /** Install api_key + access_token into the local Kite client. */
  installZerodhaToken: (apiKey: string, accessToken: string) => void | Promise<void>;
  /** Install the Dhan access token (+ optional expiry) into the Dhan client. */
  installDhanToken: (clientId: string, accessToken: string, expiresAtMs: number | null) => void | Promise<void>;
  /**
   * True when `broker` is the currently ACTIVE broker. The service starts a feed
   * ONLY for the active broker; the standby broker holds a valid token but opens
   * no socket.
   */
  isActiveBroker: (broker: BrokerKind) => boolean;
  /**
   * Bring the active broker's runtime up after a fresh token: load/refresh the
   * instrument universe, start the single Box WebSocket, resubscribe the Box token
   * set, invalidate pre-token/stale books. Never arms trading.
   */
  onActiveBrokerReady: (broker: BrokerKind) => void | Promise<void>;
  /**
   * The broker rejected the token or its feed reported terminal auth failure:
   * close the socket, invalidate executable books, block new entry, PRESERVE
   * open-position/recovery state. Never touches the other broker.
   */
  onBrokerAuthFailure: (broker: BrokerKind, reason: string) => void | Promise<void>;
}

export interface BrokerProviderConfigs {
  zerodha: TokenProviderConfig;
  dhan: TokenProviderConfig;
}

export interface BrokerTokenServiceOptions {
  clock: IstClock;
  configs: BrokerProviderConfigs;
  callbacks: TokenAcquisitionCallbacks;
  feedProbe: BrokerFeedProbe;
  /** BROKER_TOKEN_POLL_START, e.g. "09:00". */
  pollStart: string;
  /** BROKER_TOKEN_POLL_INTERVAL_MS. */
  pollIntervalMs: number;
  /** Injected persistence — the encrypted session store. */
  persist: {
    saveZerodha: (r: { apiKey: string; accessToken: string; loginDate: string }) => Promise<void>;
    saveDhan: (r: {
      clientId: string;
      accessToken: string;
      loginDate: string;
      expiresAtMs: number | null;
    }) => Promise<void>;
    /** True when a broker already has a valid stored token for `istDay`. */
    hasValidToken: (broker: BrokerKind, istDay: string) => Promise<boolean>;
    invalidate: (broker: BrokerKind, reason: string) => Promise<void>;
  };
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** 503 bounded-backoff base (ms). Defaults to pollIntervalMs. */
  blockerBackoffMs?: number;
}

interface BrokerRuntime {
  broker: BrokerKind;
  state: TokenState;
  istDay: string;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  /** The IST day a valid token was last acquired for. Stops same-day polling. */
  readyForDay: string | null;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Consecutive 503 blockers, for bounded backoff. */
  blockerStreak: number;
}

/**
 * The delay `arm()` falls back to when it is handed a non-finite one. Deliberately a whole
 * minute: a caller that cannot compute a retry delay is in an unknown state, and the safe
 * response to an unknown state is to wait, not to retry as fast as the event loop allows.
 */
const ARM_FALLBACK_DELAY_MS = 60_000;

export class BrokerTokenAcquisitionService {
  private readonly opts: BrokerTokenServiceOptions;
  private readonly runtimes: Record<BrokerKind, BrokerRuntime>;
  private started = false;
  private stopped = false;

  constructor(opts: BrokerTokenServiceOptions) {
    this.opts = opts;
    this.runtimes = {
      zerodha: this.freshRuntime("zerodha"),
      dhan: this.freshRuntime("dhan"),
    };
  }

  private freshRuntime(broker: BrokerKind): BrokerRuntime {
    return {
      broker,
      state: "waiting",
      istDay: istDayKey(this.opts.clock.now()),
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      readyForDay: null,
      inFlight: false,
      timer: null,
      blockerStreak: 0,
    };
  }

  /**
   * Start both brokers' schedules. If it is already at/after the poll-start time
   * today and a broker lacks a valid token for the current IST day, that broker
   * fetches immediately; otherwise the first attempt is scheduled for the poll
   * start. The two brokers are scheduled independently.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    await Promise.all([this.scheduleBroker("zerodha"), this.scheduleBroker("dhan")]);
  }

  /** Clear both timers and stop. Safe to call more than once. */
  stop(): void {
    this.stopped = true;
    for (const broker of ["zerodha", "dhan"] as const) {
      const rt = this.runtimes[broker];
      if (rt.timer) {
        clearTimeout(rt.timer);
        rt.timer = null;
      }
    }
  }

  /** The publishable status for GET /api/runtime/status. Never leaks a secret. */
  status(): { zerodha: BrokerTokenStatus; dhan: BrokerTokenStatus } {
    return {
      zerodha: this.statusFor("zerodha"),
      dhan: this.statusFor("dhan"),
    };
  }

  private statusFor(broker: BrokerKind): BrokerTokenStatus {
    const rt = this.runtimes[broker];
    const probe = this.opts.feedProbe;
    return {
      broker,
      state: rt.state,
      istDay: istDayKey(this.opts.clock.now()),
      lastAttemptAt: rt.lastAttemptAt,
      lastSuccessAt: rt.lastSuccessAt,
      lastError: rt.lastError,
      feedConnected: probe.feedConnected(broker),
      wantedTokenCount: probe.wantedTokenCount(broker),
      subscribedTokenCount: probe.subscribedTokenCount(broker),
      lastAuthoritativeDepthAgeMs: probe.lastAuthoritativeDepthAgeMs(broker),
      reconnectCount: probe.reconnectCount(broker),
    };
  }

  private async scheduleBroker(broker: BrokerKind): Promise<void> {
    if (this.stopped) return;
    const rt = this.runtimes[broker];
    const now = this.opts.clock.now();
    const today = istDayKey(now);
    rt.istDay = today;

    // Already have a valid token for today (e.g. restored on restart)? Do not poll.
    //
    // A FAILED read is NOT the same answer as "no token". This was
    // `.catch(() => false)`, which meant a PostgreSQL outage or an undecryptable stored
    // credential looked like "nothing stored yet" and sent the service off to acquire a
    // REPLACEMENT token from the provider. Now the bounded reason is recorded in the
    // per-broker status and the existing retry schedule re-asks, so the authority gets
    // a chance to come back before a perfectly good credential is superseded.
    let hasValid: boolean;
    try {
      hasValid = await this.opts.persist.hasValidToken(broker, today);
    } catch (err) {
      rt.state = "polling";
      rt.lastError = `stored token read failed: ${
        err instanceof Error ? err.message.slice(0, 100) : "unknown"
      }`;
      console.warn(
        `[Token] ${broker} stored-token check failed — NOT acquiring a replacement; ` +
          "retrying on the existing schedule.",
      );
      this.armRetry(broker, this.opts.pollIntervalMs);
      return;
    }
    if (hasValid) {
      rt.state = "ready";
      rt.readyForDay = today;
      return;
    }

    if (isAtOrAfterIstTime(now, this.opts.pollStart)) {
      // Past 09:00 and no valid token for today → fetch immediately.
      rt.state = "polling";
      void this.attempt(broker);
    } else {
      // Before 09:00 → schedule the first attempt for the poll start. No polling yet.
      rt.state = "waiting";
      const delay = msUntilNextDailyTime(now, this.opts.pollStart);
      this.arm(broker, delay, () => {
        this.runtimes[broker].state = "polling";
        void this.attempt(broker);
      });
    }
  }

  private arm(broker: BrokerKind, delayMs: number, fn: () => void): void {
    if (this.stopped) return;
    const rt = this.runtimes[broker];
    if (rt.timer) clearTimeout(rt.timer);
    /*
     * `Math.max(0, NaN)` is `NaN`, and `setTimeout(fn, NaN)` fires on the next tick — so a
     * non-finite delay does not merely schedule early, it converts this retry schedule into an
     * unbounded request loop against the token provider. Clamping the LOW end is therefore not
     * enough; the delay has to be proven finite first, and a caller that cannot say when to
     * retry is answered with the conservative floor rather than "immediately".
     */
    const requested = Number.isFinite(delayMs) ? delayMs : ARM_FALLBACK_DELAY_MS;
    rt.timer = setTimeout(
      () => {
        rt.timer = null;
        if (!this.stopped) fn();
      },
      Math.max(0, requested),
    );
    // Do not keep the event loop alive purely for a poll timer.
    if (typeof rt.timer === "object" && rt.timer && "unref" in rt.timer) {
      (rt.timer as { unref: () => void }).unref();
    }
  }

  /** One acquisition attempt for one broker. At most one in flight per broker. */
  private async attempt(broker: BrokerKind): Promise<void> {
    /**
     * TOP-LEVEL GUARD — a broker must never be stranded without a reschedule.
     *
     * Every call site is `void this.attempt(broker)`, so a rejection escaping this method
     * becomes an unhandled rejection: the process survives (there is a process-level guard)
     * but this broker's timer is never re-armed. It would then sit at `polling` for the rest
     * of the trading day, with no token, no error visible in the status object, and no
     * further attempt — the worst possible failure mode for a once-a-day acquisition.
     *
     * The reachable paths are already individually guarded (`fetchBrokerToken` has its own
     * try/finally, `installAndPersist` is wrapped by the `ready` case, the callbacks are
     * `.catch`-ed, and the result switch is exhaustive). This is defence against a
     * programming error or a throwing clock rather than a known bug — but the cost of being
     * wrong is a silent lost trading day, so it is guarded the same way the projector loop
     * and the engine's fatal guard are.
     */
    try {
      await this.attemptInner(broker);
    } catch (err) {
      const rt = this.runtimes[broker];
      rt.inFlight = false;
      rt.state = "polling";
      rt.lastError = `unexpected acquisition error: ${
        err instanceof Error ? err.message.slice(0, 120) : "unknown"
      }`;
      console.warn(`[Token] ${broker} acquisition threw unexpectedly — rescheduling.`);
      this.armRetry(broker, this.opts.pollIntervalMs);
    }
  }

  private async attemptInner(broker: BrokerKind): Promise<void> {
    if (this.stopped) return;
    const rt = this.runtimes[broker];

    // SINGLE IN-FLIGHT GUARD. If a request is already running for this broker, do
    // not start a second — the two would race to write the same row.
    if (rt.inFlight) return;

    const now = this.opts.clock.now();
    const today = istDayKey(now);

    // A day roll while polling resets the "ready for day" latch.
    if (rt.readyForDay && rt.readyForDay !== today) rt.readyForDay = null;

    // Already satisfied for today → stop.
    if (rt.readyForDay === today) {
      rt.state = "ready";
      return;
    }

    rt.inFlight = true;
    rt.lastAttemptAt = now;
    let result: TokenFetchResult;
    try {
      result = await fetchBrokerToken(broker, this.opts.configs[broker], now, this.opts.fetchImpl);
    } catch (err) {
      result = { kind: "retry", reason: err instanceof Error ? err.message.slice(0, 120) : "unexpected error" };
    } finally {
      rt.inFlight = false;
    }

    await this.handleResult(broker, result);
  }

  private async handleResult(broker: BrokerKind, result: TokenFetchResult): Promise<void> {
    const rt = this.runtimes[broker];
    const today = istDayKey(this.opts.clock.now());

    switch (result.kind) {
      case "ready": {
        rt.blockerStreak = 0;
        try {
          await this.installAndPersist(broker, result.payload);
          rt.state = "ready";
          rt.readyForDay = today;
          rt.lastSuccessAt = this.opts.clock.now();
          rt.lastError = null;
          // Success STOPS polling for THIS broker only. The other broker's timer is
          // untouched, so a Zerodha success cannot stop Dhan polling or vice versa.
          if (rt.timer) {
            clearTimeout(rt.timer);
            rt.timer = null;
          }
        } catch (err) {
          // Persist/install failed — treat as transient and keep polling.
          rt.state = "polling";
          rt.lastError = err instanceof Error ? err.message.slice(0, 120) : "install/persist failed";
          this.armRetry(broker, this.opts.pollIntervalMs);
        }
        return;
      }
      case "retry": {
        rt.blockerStreak = 0;
        rt.state = "polling";
        rt.lastError = result.reason;
        // 409 / network / 5xx → retry after exactly the configured interval, without
        // overlapping (the in-flight guard ensures no overlap).
        this.armRetry(broker, this.opts.pollIntervalMs);
        return;
      }
      case "blocker": {
        // 503 → bounded exponential backoff, capped, still visible as a blocker.
        rt.state = "polling";
        rt.lastError = result.reason;
        rt.blockerStreak = Math.min(rt.blockerStreak + 1, 6);
        const base = this.opts.blockerBackoffMs ?? this.opts.pollIntervalMs;
        const delay = Math.min(base * 2 ** (rt.blockerStreak - 1), base * 32);
        this.armRetry(broker, delay);
        return;
      }
      case "configuration_error": {
        // 401/403 → STOP the one-minute hammering for this broker and expose a fatal
        // configuration blocker. The other broker is unaffected.
        rt.state = "configuration_error";
        rt.lastError = result.reason;
        if (rt.timer) {
          clearTimeout(rt.timer);
          rt.timer = null;
        }
        await Promise.resolve(this.opts.callbacks.onBrokerAuthFailure(broker, result.reason)).catch(() => undefined);
        return;
      }
      case "security_error": {
        // Identity mismatch / malformed body → do NOT install. Treat as invalid;
        // stop hammering (it will not fix itself minute to minute) but keep the
        // other broker running.
        rt.state = "invalid";
        rt.lastError = result.reason;
        if (rt.timer) {
          clearTimeout(rt.timer);
          rt.timer = null;
        }
        return;
      }
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  private armRetry(broker: BrokerKind, delayMs: number): void {
    this.arm(broker, delayMs, () => void this.attempt(broker));
  }

  /**
   * Persist the validated token (encrypted) and fire the injected side effects.
   * The active-broker gate lives in the callback: `onActiveBrokerReady` is called
   * only when the caller says this broker is active, so the standby broker's socket
   * never opens here.
   */
  private async installAndPersist(broker: BrokerKind, payload: import("./tokenProviderClient.js").TokenPayload): Promise<void> {
    if (payload.broker === "zerodha") {
      await this.opts.persist.saveZerodha({
        apiKey: payload.apiKey,
        accessToken: payload.accessToken,
        loginDate: payload.loginDate,
      });
      await this.opts.callbacks.installZerodhaToken(payload.apiKey, payload.accessToken);
    } else {
      await this.opts.persist.saveDhan({
        clientId: payload.clientId,
        accessToken: payload.accessToken,
        loginDate: payload.loginDate,
        expiresAtMs: payload.expiresAtMs,
      });
      await this.opts.callbacks.installDhanToken(payload.clientId, payload.accessToken, payload.expiresAtMs);
    }

    // Start the feed ONLY for the ACTIVE broker. Both tokens may be acquired, but
    // only one WebSocket per process, and only the active broker's.
    if (this.opts.callbacks.isActiveBroker(broker)) {
      await this.opts.callbacks.onActiveBrokerReady(broker);
    }
  }

  /**
   * React to a terminal broker/feed authentication failure discovered OUTSIDE the
   * acquisition loop (e.g. the WebSocket reported it). Invalidates the stored token,
   * fires the protective callback, and resumes acquisition safely for that broker
   * only.
   */
  async onExternalAuthFailure(broker: BrokerKind, reason: string): Promise<void> {
    const rt = this.runtimes[broker];
    rt.state = "invalid";
    rt.readyForDay = null;
    rt.lastError = reason.slice(0, 120);
    await this.opts.persist.invalidate(broker, reason).catch(() => undefined);
    await Promise.resolve(this.opts.callbacks.onBrokerAuthFailure(broker, reason)).catch(() => undefined);
    if (!this.stopped) {
      rt.state = "polling";
      this.armRetry(broker, this.opts.pollIntervalMs);
    }
  }
}
