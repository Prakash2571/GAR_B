/**
 * ONE Zerodha (Kite) market-data socket, scoped to ONE lane.
 *
 * WHY THIS EXISTS
 * The Kite socket lifecycle used to live inside `TickerHub`, tangled together with the
 * shared quote caches and the SSE fan-out. That was fine while there was exactly one
 * connection, and became the blocker the moment a second lane was needed: there was no
 * Zerodha feed object to instantiate twice. This is that object — the socket, its
 * subscription set, and its reconnect policy, and nothing else. `TickerHub` keeps the
 * caches and the browser fan-out; the Box lane owns a second instance of this and
 * feeds its own quote store.
 *
 * IT ALSO ADDS RECONNECT, WHICH KITE DID NOT HAVE
 * The old hub's `onClose` merely nulled the handle: the socket came back only if
 * something later happened to call `subscribeTokens`. So a mid-session network blip
 * could silently leave the feed dead until the next strike-window move. Both lanes now
 * reconnect on a capped exponential backoff and resubscribe their OWN wanted set on
 * open, which is the behaviour the Dhan feed already had.
 *
 * SUBSCRIPTION STATE IS PER-LANE AND PRIVATE
 * `wanted` is what this lane has been asked for; `subscribed` is what it has actually
 * confirmed on the wire. They differ during a reconnect, and both are reported, because
 * "wanted 2800 / subscribed 0" is a completely different incident from "wanted 2800 /
 * subscribed 2800". Crucially, one lane can never unsubscribe another lane's token:
 * there is no shared set to get it wrong with.
 */

import { connectTicker, type Tick, type TickerHandle } from "../../ticker.js";
import { TickRateCounter, type LaneFeedStats, type MarketDataLane } from "../marketDataLane.js";

/** Backoff bounds. Same shape as the Dhan feed's, so the two lanes behave alike. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

/**
 * Close codes that mean "this credential will never work", so retrying is pointless.
 *
 * Deliberately the SAME set the Dhan feed uses (`dhan/feed.ts` `isAuthClose`), so the two lanes
 * classify a policy rejection identically and a reader does not have to hold two rules in mind.
 * 1008 is the RFC 6455 policy-violation code; 4001/4401/4403 are the application-level rejections
 * the brokers use for a bad or expired token.
 */
function isAuthClose(code: number): boolean {
  return code === 1008 || code === 4001 || code === 4401 || code === 4403;
}

export interface ZerodhaFeedOptions {
  lane: MarketDataLane;
  /** Read fresh on every connect: a reconnect must use the CURRENT access token. */
  credentials: () => { apiKey: string; accessToken: string | null };
  onTicks: (ticks: Tick[]) => void;
  onConnectionChange?: (connected: boolean) => void;
  /**
   * A transport heartbeat (Kite's 1-byte keep-alive) arrived on this lane.
   *
   * Forwarded so the market-data health machine can tell "quiet but alive" from "dead". Proves
   * TRANSPORT liveness only — never book freshness. Guarded on socket identity and generation
   * exactly like `onTicks`, so a superseded socket's keep-alive cannot make a dead lane look live.
   */
  onHeartbeat?: () => void;
  /**
   * Kite order updates ride THIS SAME quote socket as TEXT frames (binary = ticks, text =
   * order/error/message postbacks) per the v3 docs. There is NO separate Zerodha order socket:
   * a single API key may hold at most 3 WebSocket connections, so opening a dedicated order
   * socket would consume the last slot and protect against nothing — a dropped connection drops
   * both the ticks and the postbacks on it anyway. When a consumer supplies this callback the
   * text frames are forwarded to it; absent ⇒ text frames are ignored exactly as before.
   */
  onTextFrame?: (raw: string) => void;
  /** Kite rejected the feed (dead or expired token). Not a reconnectable condition. */
  onDead?: (message: string) => void;
  /**
   * A reconnectable transport fault occurred. Diagnostics only — recovery is already scheduled.
   *
   * Exists so a network blip is VISIBLE without being fatal. Before this, the only way the lane
   * could report trouble was `onDead`, which drives the health machine to the terminal
   * AUTH_EXPIRED state, so "the network hiccuped" and "your token is dead" were reported as the
   * same thing and both were unrecoverable.
   */
  onTransportFault?: (message: string) => void;
  /** The broker generation this feed belongs to, so stale ticks are identifiable. */
  generation: () => number;
  now?: () => number;
}

export class ZerodhaFeed {
  readonly lane: MarketDataLane;

  private handle: TickerHandle | null = null;
  private wanted = new Set<number>();
  private subscribed = new Set<number>();
  private connected = false;
  private disposed = false;
  private reconnectAttempts = 0;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickAt: number | null = null;
  private lastHeartbeatAt: number | null = null;
  private rate = new TickRateCounter();
  /** The generation this socket was opened under, captured at open. */
  private socketGeneration: number;
  /** Whether this lane has EVER completed a handshake (across reconnects). */
  private everOpened = false;
  /** Consecutive attempts that closed without ever opening. Reset by any successful open. */
  private consecutiveFailedOpens = 0;
  /** The most recent transport error message, for a reported diagnosis. */
  private lastFault: string | null = null;
  /**
   * How many times a socket may close WITHOUT ever opening before the token is declared dead.
   *
   * Kite refuses a bad access token at the HTTP upgrade, which arrives as an ordinary abnormal
   * close (1006) — indistinguishable on one sample from a transient network failure. A handful of
   * attempts distinguishes them: a valid token connects on the first try.
   */
  private static readonly MAX_FAILED_OPENS = 5;

  constructor(private readonly opts: ZerodhaFeedOptions) {
    this.lane = opts.lane;
    this.socketGeneration = opts.generation();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Open the socket if credentials allow it. Idempotent. */
  ensureSocket(): void {
    if (this.disposed || this.handle) return;
    const { apiKey, accessToken } = this.opts.credentials();
    if (!accessToken) return;

    this.socketGeneration = this.opts.generation();
    let handle: TickerHandle;
    handle = connectTicker({
      apiKey,
      accessToken,
      tokens: [...this.wanted],
      // Every callback is guarded on socket identity, so a late event from a
      // superseded generation cannot touch current state.
      onTick: (ticks) => {
        if (this.handle !== handle || this.disposed) return;
        // GENERATION GUARD. A socket opened under an older broker generation must not
        // publish into the new one's stores: the token namespaces differ, so an
        // integer that means one contract on Zerodha means another on Dhan.
        if (this.socketGeneration !== this.opts.generation()) return;
        this.lastTickAt = this.now();
        this.rate.mark(ticks.length, this.lastTickAt);
        this.opts.onTicks(ticks);
      },
      // Kite order postbacks arrive as TEXT frames on THIS quote socket (see onTextFrame doc
      // above). Guarded on socket identity and generation exactly like onTick, so a superseded
      // socket's late postback can never reach the current order-stream consumer.
      ...(this.opts.onTextFrame
        ? {
            onTextFrame: (raw: string) => {
              if (this.handle !== handle || this.disposed) return;
              if (this.socketGeneration !== this.opts.generation()) return;
              this.opts.onTextFrame?.(raw);
            },
          }
        : {}),
      // Kite's 1-byte keep-alive. Transport liveness only; never a book update.
      onHeartbeat: () => {
        if (this.handle !== handle || this.disposed) return;
        if (this.socketGeneration !== this.opts.generation()) return;
        this.lastHeartbeatAt = this.now();
        this.opts.onHeartbeat?.();
      },
      onOpen: () => {
        if (this.handle !== handle || this.disposed) return;
        this.reconnectAttempts = 0;
        this.everOpened = true;
        this.consecutiveFailedOpens = 0;
        // Resubscribe THIS LANE's wanted set. `connectTicker` already sent the
        // constructor list, so only record what is now live.
        this.subscribed = new Set(this.wanted);
        this.setConnected(true);
      },
      /*
       * A TRANSPORT ERROR IS NOT A DEAD TOKEN.
       *
       * This used to call `onDead(message)` and `teardown()`. Both halves were wrong, and together
       * they made the Zerodha box lane die permanently on the first network hiccup of the session:
       *
       *   1. `ws.onerror` fires for ANY abnormal condition and carries no code — DNS failure, TCP
       *      reset, TLS failure, an idle timeout. It is not evidence about the credential. But
       *      `onDead` drives the market-data machine to AUTH_EXPIRED, which is documented as
       *      TERMINAL: no data event can revive it. So one blip permanently reported an expired
       *      session — and, because that blocker's scope is `both`, also reported exposure
       *      management as blocked.
       *   2. `teardown()` nulls `this.handle`, and `onClose` begins with
       *      `if (this.handle !== handle) return`. So the close that always follows an error
       *      returned early and `scheduleReconnect()` was NEVER reached. The lane had no socket, no
       *      pending reconnect, and nothing that could ever create one — for the life of the
       *      process.
       *
       * Recovery is now driven from `onClose` (which always follows and does carry a code), exactly
       * as the Dhan feed already did. Here we only record and report.
       */
      onError: (message) => {
        if (this.handle !== handle || this.disposed) return;
        this.lastFault = message;
        this.opts.onTransportFault?.(message);
      },
      onClose: ({ code, everOpened }) => {
        if (this.handle !== handle || this.disposed) return;
        this.handle = null;
        this.subscribed.clear();
        this.setConnected(false);

        // A POLICY close means the credential will never work; retrying it just spins.
        if (isAuthClose(code)) {
          this.opts.onDead?.(
            `Kite feed rejected the session (close code ${code}) — the access token is invalid or expired.`,
          );
          return;
        }

        /*
         * A socket that has NEVER completed a handshake is the ambiguous case, because Kite rejects
         * a bad access token by refusing the HTTP upgrade, which surfaces as an ordinary abnormal
         * close (1006) rather than a policy code. Retrying forever against a dead token would spin
         * silently; declaring the token dead on the first 1006 would kill the lane over a transient
         * DNS failure. So we retry a BOUNDED number of times and only then report a lost session —
         * a valid token normally connects on the first attempt, so repeated failure to ever open is
         * genuine evidence, whereas a single failure is not.
         */
        if (!everOpened && !this.everOpened) {
          this.consecutiveFailedOpens++;
          if (this.consecutiveFailedOpens >= ZerodhaFeed.MAX_FAILED_OPENS) {
            this.opts.onDead?.(
              `Kite feed could not establish a session in ${this.consecutiveFailedOpens} attempts ` +
                `(last close code ${code}${this.lastFault ? `, last error: ${this.lastFault}` : ""}). ` +
                `The access token is most likely invalid or expired; sign in again to replace it.`,
            );
            return;
          }
        }

        this.scheduleReconnect();
      },
    });
    this.handle = handle;
  }

  /** Declare this lane's ENTIRE token set. Diffs against what is already live. */
  setTokens(tokens: number[]): void {
    const want = new Set(tokens.filter((t) => Number.isFinite(t) && t > 0));
    const toAdd: number[] = [];
    const toDrop: number[] = [];
    for (const token of want) if (!this.wanted.has(token)) toAdd.push(token);
    for (const token of this.wanted) if (!want.has(token)) toDrop.push(token);
    this.wanted = want;

    if (!this.handle) {
      // Nothing live yet: the set is remembered and sent on open.
      if (want.size > 0) this.ensureSocket();
      return;
    }
    // Unsubscribe first, so a set that both adds and drops cannot momentarily exceed
    // the per-connection instrument allowance.
    if (toDrop.length > 0) {
      this.handle.unsubscribe(toDrop);
      for (const token of toDrop) this.subscribed.delete(token);
    }
    if (toAdd.length > 0) {
      this.handle.subscribe(toAdd);
      for (const token of toAdd) this.subscribed.add(token);
    }
  }

  subscribeTokens(tokens: number[]): void {
    if (tokens.length === 0) return;
    const fresh = tokens.filter((t) => Number.isFinite(t) && t > 0 && !this.wanted.has(t));
    for (const token of fresh) this.wanted.add(token);
    if (!this.handle) {
      this.ensureSocket();
      return;
    }
    if (fresh.length > 0) {
      this.handle.subscribe(fresh);
      for (const token of fresh) this.subscribed.add(token);
    }
  }

  unsubscribeTokens(tokens: number[]): void {
    const drop = tokens.filter((t) => this.wanted.has(t));
    if (drop.length === 0) return;
    for (const token of drop) {
      this.wanted.delete(token);
      this.subscribed.delete(token);
    }
    this.handle?.unsubscribe(drop);
  }

  isConnected(): boolean {
    return this.connected;
  }

  wantedCount(): number {
    return this.wanted.size;
  }

  subscribedCount(): number {
    return this.subscribed.size;
  }

  stats(): LaneFeedStats {
    const now = this.now();
    return {
      lane: this.lane,
      connected: this.connected,
      subscribedTokens: this.subscribed.size,
      wantedTokens: this.wanted.size,
      ticksPerSecond: this.rate.perSecond(now),
      lastTickAgeMs: this.lastTickAt === null ? null : Math.max(0, now - this.lastTickAt),
      lastHeartbeatAgeMs:
        this.lastHeartbeatAt === null ? null : Math.max(0, now - this.lastHeartbeatAt),
      reconnects: this.reconnects,
      generation: this.socketGeneration,
    };
  }

  /**
   * Tear the lane down and forget its subscriptions.
   *
   * Called on a broker switch and at shutdown. The token set MUST go: these are
   * Zerodha instrument tokens, and they are meaningless — worse, actively misleading —
   * to Dhan.
   */
  stop(): void {
    this.disposed = true;
    this.teardown();
    this.wanted.clear();
    this.rate.reset();
    this.lastTickAt = null;
    this.lastHeartbeatAt = null;
    // A new broker/session starts with no history: retaining `everOpened` would let a lane that
    // once connected under a PREVIOUS session skip the bounded never-opened detection entirely.
    this.everOpened = false;
    this.consecutiveFailedOpens = 0;
    this.lastFault = null;
  }

  private teardown(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const handle = this.handle;
    this.handle = null;
    this.subscribed.clear();
    handle?.close();
    this.setConnected(false);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.opts.onConnectionChange?.(connected);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    if (this.wanted.size === 0) return; // nothing to stream: do not hold a socket open
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.ensureSocket();
    }, delay);
    // Never let a reconnect timer keep the process alive on shutdown.
    this.reconnectTimer.unref?.();
  }
}
