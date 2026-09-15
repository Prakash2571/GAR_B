/**
 * The single shared DhanHQ v2 market feed.
 *
 * ONE SOCKET, FANNED OUT — deliberately mirroring the existing Kite `TickerHub`.
 * Dhan allows many instruments per connection, so a socket per underlying (or worse,
 * per trade) would burn connections for nothing and make the connection limit a
 * latent outage. Every consumer — the Box quote store, SSE clients, analytics —
 * attaches to this one instance.
 *
 * PARTIAL PACKETS MUST BE MERGED, NOT PUBLISHED RAW
 * Dhan's packet types are partial by design: a Ticker carries only an LTP, an OI
 * packet only open interest. Publishing each in isolation would repeatedly hand
 * consumers a "quote" whose bid/ask were zero. So the feed keeps the last known
 * FULL state per instrument and merges each packet into it, emitting a complete
 * tick. The decoder stays pure and never invents fields; assembling state is this
 * layer's job.
 *
 * `exchange_ts` IS ALWAYS ABSENT — see toTick().
 */

import { decodeDhanFeed, DHAN_FEED_CODE, type DhanFeedPacket } from "./feedDecoder.js";
import { DHAN_CODE_BY_SEGMENT, type DhanExchangeSegment } from "./segments.js";
import type { DepthLevel, Tick } from "../../ticker.js";

const DHAN_FEED_ROOT = "wss://api-feed.dhan.co";

/** Dhan upstream request codes. */
const REQUEST_CODE = {
  /** Ticker: LTP + LTT only. */
  SUBSCRIBE_TICKER: 15,
  /** Quote: LTP, volume, OHLC — no depth. */
  SUBSCRIBE_QUOTE: 17,
  /** Full: quote + OI + 5-level depth. What Box needs. */
  SUBSCRIBE_FULL: 21,
  UNSUBSCRIBE_FULL: 22,
  DISCONNECT: 12,
} as const;

/**
 * Instruments per subscribe message.
 *
 * Dhan caps one message at 100 instruments, so the token set is chunked. Exceeding
 * it does not error usefully — the socket simply drops the request — which would
 * present as a subset of strikes silently never ticking.
 */
const SUBSCRIBE_BATCH = 100;

/** An instrument as the feed identifies it. */
export interface DhanFeedInstrument {
  segment: DhanExchangeSegment;
  securityId: number;
}

export interface DhanFeedOptions {
  accessToken: () => string | null;
  clientId: () => string;
  /** Called with every merged tick batch. */
  onTicks: (ticks: Tick[]) => void;
  /** Connection state changes, so consumers can invalidate their books. */
  onConnection?: (connected: boolean) => void;
  /** Fatal/auth failures: the session is unusable and must be re-established. */
  onSessionLost?: (reason: string) => void;
  /**
   * A TRANSPORT-LIVENESS frame arrived that carried no usable book.
   *
   * Dhan's feed sends non-tick frames (market-status packets, informational text frames, and
   * packets whose code carries no ladder). They prove the socket is alive and prove NOTHING about
   * any instrument's depth. Forwarded on a dedicated callback — deliberately separate from
   * `onTicks` — so it is impossible to wire this into anything that refreshes book freshness.
   */
  onHeartbeat?: () => void;
  /** Resolves an internal token back to the Dhan (segment, securityId) pair. */
  resolve: (token: number) => DhanFeedInstrument | null;
  /**
   * Depth mode. `5` uses the FULL packet, which is what the Box scanner is sized
   * for. 20/200-level depth is a separate Dhan architecture with far tighter
   * instrument limits and is not suitable for thousands of strikes.
   */
  depthLevel?: 5 | 20 | 200;
}

/** Accumulated per-instrument state, so a partial packet yields a complete tick. */
interface FeedState {
  token: number;
  last_price: number;
  close_price: number;
  oi: number;
  volume: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  receivedAt: number;
}

export class DhanFeed {
  private ws: WebSocket | null = null;
  private connected = false;
  /** Internal tokens the feed should be streaming. */
  private wanted = new Set<number>();
  /** Tokens actually confirmed onto the current socket. */
  private subscribed = new Set<number>();
  private state = new Map<number, FeedState>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private disposed = false;
  private lastTickAt = 0;
  /**
   * Bumped on every (re)connection.
   *
   * Consumers use it to discard books gathered on a previous socket: after a
   * reconnect the old depth is not merely stale, it is from a different session and
   * must not be treated as executable.
   */
  private generation = 0;

  constructor(private opts: DhanFeedOptions) {}

  isConnected(): boolean {
    return this.connected;
  }

  subscribedCount(): number {
    return this.subscribed.size;
  }

  /**
   * Tokens the feed has been ASKED for, as opposed to confirmed onto the socket.
   *
   * Reported separately because `wanted > 0 && subscribed === 0` is a specific,
   * diagnosable failure — the subscribe frame never went out or was rejected — and is
   * indistinguishable from "nothing is subscribed" if only one number is exposed.
   */
  wantedCount(): number {
    return this.wanted.size;
  }

  /** Epoch ms of the newest tick, or null when nothing has arrived. */
  lastTickAtMs(): number | null {
    return this.lastTickAt === 0 ? null : this.lastTickAt;
  }

  feedGeneration(): number {
    return this.generation;
  }

  /** Age (ms) of the newest tick, or null when nothing has arrived. */
  feedAgeMs(): number | null {
    return this.lastTickAt === 0 ? null : Date.now() - this.lastTickAt;
  }

  /** Subscribe additional internal tokens (idempotent). */
  subscribeTokens(tokens: number[]): void {
    const fresh = tokens.filter((t) => !this.wanted.has(t));
    for (const t of fresh) this.wanted.add(t);
    if (fresh.length === 0) return;
    // One line per subscription CHANGE (never per tick). This is the trace that shows
    // whether browser demand actually reached the socket, which is precisely what was
    // impossible to tell while the board was silently rendering "-".
    console.log(
      `[DhanFeed] subscribe request: fresh=${fresh.length} wanted=${this.wanted.size} ` +
        `subscribed=${this.subscribed.size} socketConnected=${this.connected}`,
    );
    this.ensureSocket();
    if (this.connected) this.sendSubscribe(fresh);
    else console.log(`[DhanFeed] socket not open yet; ${this.wanted.size} token(s) queued`);
  }

  /** Unsubscribe internal tokens and DROP their books. */
  unsubscribeTokens(tokens: number[]): void {
    const drop = tokens.filter((t) => this.wanted.has(t));
    if (drop.length === 0) return;
    for (const t of drop) {
      this.wanted.delete(t);
      this.subscribed.delete(t);
      // Forget the book too. Keeping it would let an unsubscribed instrument keep
      // answering quote reads with a book nothing is updating any more.
      this.state.delete(t);
    }
    if (this.connected) this.sendUnsubscribe(drop);
  }

  /**
   * Open the socket if it is not already open.
   *
   * A missing token is not an error here — it means Dhan is simply not connected
   * yet, and the caller (the registry) decides whether that is a problem.
   */
  ensureSocket(): void {
    if (this.disposed || this.ws) return;
    const token = this.opts.accessToken();
    const clientId = this.opts.clientId();
    if (!token || !clientId) return;

    const url =
      `${DHAN_FEED_ROOT}?version=2&token=${encodeURIComponent(token)}` +
      `&clientId=${encodeURIComponent(clientId)}&authType=2`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.scheduleReconnect(`socket construction failed: ${String(err)}`);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    // Every handler is generation-guarded so a superseded socket can never emit
    // into the live book — the same discipline the Kite hub uses.
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.generation++;
      // Retained normalization state belongs to the previous socket generation.
      // A partial packet on this socket must never republish the old ladder.
      this.state.clear();
      this.lastTickAt = 0;
      // Re-subscribe everything: a new socket carries no prior subscriptions.
      this.subscribed.clear();
      if (this.wanted.size > 0) this.sendSubscribe([...this.wanted]);
      this.opts.onConnection?.(true);
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      const data = ev.data;
      // Dhan's market feed is binary. A text frame is informational only — but it IS inbound
      // traffic, so it counts as transport liveness (and nothing more).
      if (!(data instanceof ArrayBuffer)) {
        this.opts.onHeartbeat?.();
        return;
      }
      this.handleFrame(data);
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      // `onclose` always follows, so recovery is driven from there to avoid
      // scheduling two reconnects for one failure.
    };

    // Typed structurally: the backend's lib is esnext-only, so the DOM CloseEvent
    // type is unavailable even though the runtime (undici) provides the object.
    ws.onclose = (ev: { code?: number }) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.subscribed.clear();
      this.state.clear();
      this.lastTickAt = 0;
      this.opts.onConnection?.(false);
      // 1008/4401-style auth rejections will never succeed on retry, so surface
      // them as a lost session instead of reconnecting forever.
      const closeCode = ev.code ?? 0;
      if (isAuthClose(closeCode)) {
        this.opts.onSessionLost?.(
          `Dhan feed rejected the session (close code ${closeCode}) — the access token is invalid or expired.`,
        );
        return;
      }
      this.scheduleReconnect(`socket closed (code ${closeCode})`);
    };
  }

  private handleFrame(buffer: ArrayBuffer): void {
    const { packets, errors } = decodeDhanFeed(buffer);
    for (const message of errors) {
      // Never silent: a steady trickle means the wire format moved.
      console.warn(`[Dhan feed] ${message}`);
    }
    if (packets.length === 0) return;

    const ticks: Tick[] = [];
    const now = Date.now();
    for (const packet of packets) {
      if (packet.code === DHAN_FEED_CODE.DISCONNECT) {
        console.warn(`[Dhan feed] server requested disconnect (code ${packet.disconnect_code ?? 0}).`);
        continue;
      }
      if (packet.code === DHAN_FEED_CODE.MARKET_STATUS) continue;
      const token = this.tokenFor(packet);
      if (token === null) continue;
      this.subscribed.add(token);
      const merged = this.merge(token, packet, now);
      // Provenance is derived from THIS decoded packet, never from the merged
      // state whose ladders intentionally remain available to UI consumers.
      const depthUpdated = packet.bids !== undefined || packet.asks !== undefined;
      ticks.push(toTick(merged, depthUpdated));
    }
    if (ticks.length === 0) {
      // The frame decoded, but produced no tick — a market-status packet, a server DISCONNECT
      // notice, or packets we could not attribute to a wanted token. Inbound traffic proves the
      // TRANSPORT is alive; it must never be allowed to refresh a book's freshness, which is why
      // this is the heartbeat callback and not `onTicks([])`.
      this.opts.onHeartbeat?.();
      return;
    }
    // FIRST tick only. It is the single most valuable log line here (it proves the
    // whole chain end to end), and logging every tick would bury everything else.
    if (this.lastTickAt === 0) {
      console.log(
        `[DhanFeed] firstTick internalToken=${ticks[0]!.token} ltp=${ticks[0]!.last_price} ` +
          `batch=${ticks.length} wanted=${this.wanted.size} subscribed=${this.subscribed.size}`,
      );
    }
    this.lastTickAt = now;
    this.opts.onTicks(ticks);
  }

  /**
   * Map a packet back to the internal token.
   *
   * Dhan identifies an instrument by (segment, securityId). We only ever subscribe
   * tokens we resolved ourselves, so the reverse lookup walks the wanted set — and
   * a packet we cannot attribute is dropped rather than guessed at, because
   * attributing a price to the wrong instrument is the worst available outcome.
   */
  private tokenFor(packet: DhanFeedPacket): number | null {
    if (packet.segment === null) return null;
    const wantCode = DHAN_CODE_BY_SEGMENT[packet.segment];
    for (const token of this.wanted) {
      const inst = this.opts.resolve(token);
      if (!inst) continue;
      if (inst.securityId === packet.securityId && DHAN_CODE_BY_SEGMENT[inst.segment] === wantCode) {
        return token;
      }
    }
    return null;
  }

  /** Merge a partial packet into the instrument's accumulated book. */
  private merge(token: number, packet: DhanFeedPacket, now: number): FeedState {
    const prior = this.state.get(token);
    const next: FeedState = prior ?? {
      token,
      last_price: 0,
      close_price: 0,
      oi: 0,
      volume: 0,
      bids: [],
      asks: [],
      receivedAt: now,
    };
    if (packet.last_price !== undefined) next.last_price = packet.last_price;
    if (packet.close !== undefined) next.close_price = packet.close;
    if (packet.prev_close !== undefined && next.close_price === 0) next.close_price = packet.prev_close;
    if (packet.oi !== undefined) next.oi = packet.oi;
    if (packet.prev_oi !== undefined && next.oi === 0) next.oi = packet.prev_oi;
    if (packet.volume !== undefined) next.volume = packet.volume;
    // Depth only ever arrives on a FULL packet. An empty ladder there is a real
    // "no liquidity" observation and must overwrite, not be ignored.
    if (packet.bids !== undefined) next.bids = packet.bids;
    if (packet.asks !== undefined) next.asks = packet.asks;
    next.receivedAt = now;
    this.state.set(token, next);
    return next;
  }

  private sendSubscribe(tokens: number[]): void {
    const code =
      this.opts.depthLevel === 20
        ? REQUEST_CODE.SUBSCRIBE_FULL
        : REQUEST_CODE.SUBSCRIBE_FULL;
    this.sendInstrumentRequest(code, tokens);
  }

  private sendUnsubscribe(tokens: number[]): void {
    this.sendInstrumentRequest(REQUEST_CODE.UNSUBSCRIBE_FULL, tokens);
  }

  /** Chunked instrument request: Dhan accepts at most 100 per message. */
  private sendInstrumentRequest(requestCode: number, tokens: number[]): void {
    const ws = this.ws;
    if (!ws || !this.connected) return;
    const list = tokens
      .map((token) => {
        const inst = this.opts.resolve(token);
        if (!inst) return null;
        return { ExchangeSegment: inst.segment, SecurityId: String(inst.securityId) };
      })
      .filter((x): x is { ExchangeSegment: DhanExchangeSegment; SecurityId: string } => x !== null);

    // Unresolvable tokens are a real failure mode (universe not loaded, or a token
    // from the other broker), and silently sending a shorter list hides it.
    if (list.length < tokens.length) {
      console.warn(
        `[DhanFeed] ${tokens.length - list.length} of ${tokens.length} token(s) could not be ` +
          `resolved to a Dhan (segment, securityId) and were NOT sent upstream.`,
      );
    }

    let failedBatches = 0;
    for (let i = 0; i < list.length; i += SUBSCRIBE_BATCH) {
      const batch = list.slice(i, i + SUBSCRIBE_BATCH);
      // Dhan's per-message instrument cap is a WS protocol limit, entirely separate
      // from any HTTP chunking the browser does.
      console.log(
        `[DhanFeed] sending ${requestCode === REQUEST_CODE.UNSUBSCRIBE_FULL ? "unsubscribe" : "subscribe"} ` +
          `batch=${batch.length} (${i + batch.length}/${list.length})`,
      );
      try {
        ws.send(
          JSON.stringify({
            RequestCode: requestCode,
            InstrumentCount: batch.length,
            InstrumentList: batch,
          }),
        );
      } catch (err) {
        /*
         * CONTINUE, DO NOT RETURN.
         *
         * This used to `return`, which abandoned every REMAINING chunk. With the Box universe at
         * ~2,200 tokens that is 22 chunks, so one transient send failure on chunk 3 silently left
         * ~1,900 instruments unsubscribed — and because `subscribed` is only populated from
         * inbound packets, the lane then looked "connected" while most of the universe never
         * ticked. Failing one chunk is not a reason to abandon the other twenty.
         */
        failedBatches++;
        console.warn(
          `[Dhan feed] failed to send request ${requestCode} for batch ` +
            `${i / SUBSCRIBE_BATCH + 1} (${batch.length} instrument(s)):`,
          err,
        );
      }
    }
    if (failedBatches > 0) {
      // Surfaced, not swallowed: the caller's `wanted` set still contains these tokens, so the
      // next reconnect resubscribes them — but an operator must be able to see that the CURRENT
      // socket is streaming less than it was asked for.
      console.warn(
        `[Dhan feed] ${failedBatches} subscription batch(es) failed to send on this socket; ` +
          `the affected instruments are NOT streaming until the next resubscribe.`,
      );
    }
  }

  /**
   * Reconnect with capped exponential backoff.
   *
   * Capped because an unbounded retry storm against a broker is its own outage, and
   * bounded-but-forever because a transient network blip must self-heal without an
   * operator pressing anything.
   */
  private scheduleReconnect(reason: string): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(6, this.reconnectAttempts - 1));
    console.warn(`[Dhan feed] ${reason}; reconnecting in ${delay}ms.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * Stop the feed and DISCARD every book.
   *
   * Called on broker switch and on session loss. Dropping `state` is the point: a
   * Zerodha session must never be able to see books Dhan produced, and vice versa.
   */
  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    this.subscribed.clear();
    this.wanted.clear();
    this.state.clear();
    this.lastTickAt = 0;
    if (ws) {
      try {
        ws.send(JSON.stringify({ RequestCode: REQUEST_CODE.DISCONNECT }));
      } catch {
        /* the socket is going away anyway */
      }
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.opts.onConnection?.(false);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}

/**
 * Normalize accumulated Dhan state into Calspread's existing `Tick`.
 *
 * `exchange_ts` IS DELIBERATELY OMITTED.
 *
 * Dhan's FULL packet carries a Last Trade Time, which is when the last TRADE
 * printed — NOT when the order book was published. For an illiquid option those can
 * differ by minutes. The Box engine uses `exchange_ts` for its cross-leg temporal
 * coherence check, which asks "were these four books a coherent cross-sectional
 * snapshot?". Feeding it a trade time would make four legs whose books are actually
 * in step look wildly skewed, or worse, make skewed books look aligned. Omitting it
 * makes the engine fall back to local receive time, which is honest and already
 * supported. Faking a book timestamp here would silently corrupt an executability
 * decision, so it is not done.
 */
export function toTick(state: {
  token: number;
  last_price: number;
  close_price: number;
  oi: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
}, depthUpdated = true): Tick {
  return {
    token: state.token,
    last_price: state.last_price,
    close_price: state.close_price,
    oi: state.oi,
    bid: state.bids[0]?.price ?? 0,
    ask: state.asks[0]?.price ?? 0,
    bids: state.bids,
    asks: state.asks,
    depth_updated: depthUpdated,
  };
}

/** Close codes that mean "this token will never work", so retrying is pointless. */
function isAuthClose(code: number): boolean {
  return code === 1008 || code === 4001 || code === 4401 || code === 4403;
}
