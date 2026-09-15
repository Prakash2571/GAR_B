/**
 * Minimal Kite Connect v3 WebSocket ("ticker") client.
 *
 * Docs: https://kite.trade/docs/connect/v3/websocket/
 *
 * Uses the global `WebSocket` available in Node 21+ (undici). Connects to
 * wss://ws.kite.trade, subscribes to instrument tokens in "quote" mode, parses
 * the binary tick packets, and hands decoded ticks to a callback.
 */

const WS_ROOT = "wss://ws.kite.trade";

export interface DepthLevel {
  price: number;
  qty: number;
  orders: number;
}

export interface Tick {
  token: number;
  last_price: number;
  close_price: number;
  oi: number; // open interest (F&O only; 0 for spot/index)
  bid: number; // best bid (0 if unavailable)
  ask: number; // best ask (0 if unavailable)
  bids?: DepthLevel[]; // up to 5 levels (full mode only)
  asks?: DepthLevel[];
  /**
   * True only when THIS wire packet carried an authoritative executable depth
   * snapshot. False means any ladders on the normalized tick are retained state
   * for display/analytics only. Optional for legacy/custom producers; the Box
   * store then infers authority only from explicitly supplied ladder properties.
   */
  depth_updated?: boolean;
  /**
   * Exchange timestamp in epoch MILLISECONDS, present on "full" packets only.
   *
   * Kite sends it as a 32-bit Unix SECOND, so the resolution is one second — it
   * is enough to estimate how far behind the exchange we are, but never
   * millisecond-accurate. 0/absent when the packet did not carry one (e.g. LTP
   * packets, or an index's shorter layout).
   */
  exchange_ts?: number;
}

export interface TickerHandle {
  close: () => void;
  /** Subscribe to additional instrument tokens on the existing socket. */
  subscribe: (tokens: number[]) => void;
  /**
   * Stop streaming the given tokens on the existing socket.
   *
   * Needed by consumers whose token set MOVES rather than only grows (the box
   * scanner re-centres its strike windows as the underlying drifts). Without it
   * every abandoned strike would stay subscribed for the life of the connection
   * and eventually exhaust Zerodha's per-connection instrument limit.
   */
  unsubscribe: (tokens: number[]) => void;
}

interface ConnectOptions {
  apiKey: string;
  accessToken: string;
  tokens: number[];
  onTick: (ticks: Tick[]) => void;
  onOpen?: () => void;
  onError?: (message: string) => void;
  /**
   * The socket closed.
   *
   * The CLOSE CODE and whether the socket ever completed a handshake are both reported, because
   * the caller's recovery decision genuinely depends on them and it used to be made blind. A
   * policy close (1008/4401/…) means the credential is dead and retrying is pointless; a 1006
   * after a healthy session is an ordinary network blip that MUST be retried. Previously `onClose`
   * carried no arguments and `onError` was treated as terminal, so a blip and a dead token were
   * indistinguishable — and both permanently killed the lane.
   */
  onClose?: (info: { code: number; everOpened: boolean }) => void;
  /**
   * A TRANSPORT HEARTBEAT arrived (Kite's 1-byte keep-alive).
   *
   * Kite sends a single zero-length/1-byte binary frame to keep the connection alive when no
   * instrument has ticked. `parseBinary` correctly yields no ticks for it, and `onTick` is only
   * invoked for a non-empty batch, so before this callback existed the frame was observed by
   * nothing at all: a quiet-but-perfectly-alive socket was indistinguishable from a dead one, and
   * the market-data machine's `onHeartbeat` had no production caller anywhere.
   *
   * This proves TRANSPORT LIVENESS ONLY. It is deliberately a separate callback from `onTick` so
   * that it is impossible to wire it into anything that refreshes a book's freshness.
   */
  onHeartbeat?: () => void;
  /**
   * Kite streams ORDER UPDATES as TEXT frames on THIS SAME quote socket — shaped
   * `{ "type": "order"|"error"|"message", "data": … }` per the current v3 docs
   * (verified 2026-09-09, https://kite.trade/docs/connect/v3/websocket/). They used to be
   * silently discarded here (the fast fill path was on the wire and thrown away). When a
   * consumer supplies this callback, every text frame is forwarded verbatim for the order-
   * update layer to parse. Absent ⇒ the historical behaviour (ignore text) is preserved, so
   * this is inert unless a caller opts in.
   */
  onTextFrame?: (raw: string) => void;
}

export function connectTicker(opts: ConnectOptions): TickerHandle {
  const url =
    `${WS_ROOT}?api_key=${encodeURIComponent(opts.apiKey)}` +
    `&access_token=${encodeURIComponent(opts.accessToken)}`;

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let isOpen = false;
  /**
   * Whether a handshake ever completed on THIS socket.
   *
   * Distinct from `isOpen`, which is the CURRENT state. The caller's reconnect policy needs the
   * historical fact: a socket that never opened and then closed points at the credential or the
   * endpoint, whereas one that opened, streamed and then closed points at the network.
   */
  let everOpened = false;
  // Tokens requested before the socket finished opening are queued here and
  // flushed on open.
  let pendingTokens: number[] = [...opts.tokens];

  function sendSubscribe(tokens: number[]) {
    if (tokens.length === 0) return;
    try {
      ws.send(JSON.stringify({ a: "subscribe", v: tokens }));
      // "full" mode includes the day's close price AND open interest (oi) — and, critically, the
      // five-level bid/ask ladder the Box engine needs for an EXECUTABLE book. Full depth is
      // requested unconditionally and in every execution mode: paper prices against the same
      // ladder live would, which is the only way paper can shadow live honestly.
      ws.send(JSON.stringify({ a: "mode", v: ["full", tokens] }));
    } catch (err) {
      // The socket died mid-send. Do NOT throw into the WebSocket callback: `onclose` will follow
      // and the lane resubscribes its whole wanted set on the next open, so these tokens are not
      // lost. Reported because a silent failure here looks exactly like a subscription the broker
      // ignored.
      opts.onError?.(`Kite subscribe send failed: ${String(err)}`);
    }
  }

  ws.onopen = () => {
    isOpen = true;
    everOpened = true;
    sendSubscribe(pendingTokens);
    pendingTokens = [];
    opts.onOpen?.();
  };

  ws.onmessage = (ev: MessageEvent) => {
    const data = ev.data;
    // Text frames are Kite POSTBACKS — order updates, errors and broker messages
    // (https://kite.trade/docs/connect/v3/websocket/#postbacks-and-non-binary-updates,
    // verified 2026-09-09). Historically discarded here, which threw away the fast fill
    // path. Now forwarded to any registered order-update consumer; binary frames remain
    // market-data ticks. Forwarding is guarded so a throwing consumer cannot kill the feed.
    if (typeof data === "string") {
      if (opts.onTextFrame) {
        try {
          opts.onTextFrame(data);
        } catch {
          // An order-update parse/handler fault must NEVER break the market-data socket.
        }
      }
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    // KEEP-ALIVE. Kite sends a 0/1-byte binary frame when nothing has ticked. It carries no
    // packets, so it is transport liveness and NOTHING else — never a book update.
    if (data.byteLength < 2) {
      opts.onHeartbeat?.();
      return;
    }
    const ticks = parseBinary(data);
    if (ticks.length) opts.onTick(ticks);
  };

  // NOT terminal. `onerror` carries no code and fires for every abnormal condition — DNS failure,
  // TCP reset, TLS error, an idle-timeout reset — so it cannot distinguish a dead token from a
  // blip. It is reported for diagnostics and recovery is driven from `onclose`, which always
  // follows and does carry a code. (Treating this as proof of credential death is what used to
  // kill the Zerodha box lane permanently on the first network hiccup.)
  ws.onerror = () => opts.onError?.("Kite WebSocket error.");
  ws.onclose = (ev: { code?: number } = {}) => {
    // Mark the socket unusable BEFORE notifying, so a handler that synchronously calls
    // subscribe()/unsubscribe() queues the tokens instead of sending on a closed socket.
    isOpen = false;
    opts.onClose?.({ code: ev?.code ?? 0, everOpened });
  };

  return {
    close: () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
    subscribe: (tokens: number[]) => {
      if (isOpen) {
        sendSubscribe(tokens);
      } else {
        pendingTokens.push(...tokens);
      }
    },
    unsubscribe: (tokens: number[]) => {
      if (tokens.length === 0) return;
      if (isOpen) {
        try {
          ws.send(JSON.stringify({ a: "unsubscribe", v: tokens }));
        } catch {
          // Socket went away mid-send; the tokens die with the connection.
        }
      } else {
        // Never opened (or already closed): just drop them from the queue so
        // they are not subscribed once it does open.
        const drop = new Set(tokens);
        pendingTokens = pendingTokens.filter((t) => !drop.has(t));
      }
    },
  };
}

/**
 * Parse a Kite binary tick message.
 * Layout (big-endian): [int16 numberOfPackets][ for each: int16 length, bytes ].
 * Within a packet: int32 instrument_token, int32 last_price, ... int32 close.
 * Prices for NSE/NFO are in paise → divide by 100.
 */
export function parseBinary(buf: ArrayBuffer): Tick[] {
  const dv = new DataView(buf);
  if (dv.byteLength < 2) return []; // heartbeat (single byte) or empty

  const numPackets = dv.getInt16(0, false);
  let offset = 2;
  const ticks: Tick[] = [];

  for (let p = 0; p < numPackets; p++) {
    if (offset + 2 > dv.byteLength) break;
    const len = dv.getInt16(offset, false);
    offset += 2;
    if (offset + len > dv.byteLength) break;

    // Token MUST be read as UNSIGNED: NFO futures tokens exceed 2^31, and a
    // signed read would make them negative and never match the subscribed token.
    const token = dv.getUint32(offset, false);
    const divisor = priceDivisor(token);
    const lastPrice = dv.getUint32(offset + 4, false) / divisor;

    // "quote"/"full" packets (>= 44 bytes) carry the close price at offset 40.
    let closePrice = 0;
    if (len >= 44) {
      closePrice = dv.getUint32(offset + 40, false) / divisor;
    }

    // "full" packets (>= 184 bytes) carry open interest at offset 48 (a count,
    // not a price, so it is NOT divided) plus 5-level market depth from offset
    // 64: 5 bid packets then 5 ask packets, each 12 bytes (qty, price, ...).
    // Best bid price = offset 68, best ask price = offset 128.
    let oi = 0;
    let bid = 0;
    let ask = 0;
    let exchangeTs = 0;
    const bids: DepthLevel[] = [];
    const asks: DepthLevel[] = [];
    if (len >= 184) {
      oi = dv.getUint32(offset + 48, false);
      // Exchange timestamp at offset 60: a Unix SECOND, so second-resolution.
      // Multiplied to ms here so consumers work in one unit; 0 is treated as
      // "absent" by everything downstream.
      const exSec = dv.getUint32(offset + 60, false);
      if (exSec > 0) exchangeTs = exSec * 1000;
      // Market depth: 5 bid packets (offset 64), then 5 ask packets (offset
      // 124). Each is 12 bytes: qty(4), price(4), orders(2), padding(2).
      for (let i = 0; i < 5; i++) {
        const bOff = offset + 64 + i * 12;
        const bPrice = dv.getUint32(bOff + 4, false) / divisor;
        if (bPrice > 0) bids.push({ price: bPrice, qty: dv.getUint32(bOff, false), orders: dv.getUint16(bOff + 8, false) });
        const aOff = offset + 124 + i * 12;
        const aPrice = dv.getUint32(aOff + 4, false) / divisor;
        if (aPrice > 0) asks.push({ price: aPrice, qty: dv.getUint32(aOff, false), orders: dv.getUint16(aOff + 8, false) });
      }
      bid = bids[0]?.price ?? 0;
      ask = asks[0]?.price ?? 0;
    }

    ticks.push({
      token,
      last_price: lastPrice,
      close_price: closePrice,
      oi,
      bid,
      ask,
      bids,
      asks,
      depth_updated: len >= 184,
      exchange_ts: exchangeTs,
    });
    offset += len;
  }

  return ticks;
}

/**
 * Price divisor by segment, derived from the instrument token's low 8 bits.
 * NSE/NFO (and most segments) use 100. Currency segments differ; we only
 * stream NSE equities + NFO futures here, so 100 is correct.
 */
function priceDivisor(token: number): number {
  const segment = token & 0xff;
  // 3 = CDS (currency) → 10^7 ; 7 = BCD → 10^4 ; everything else → 100.
  if (segment === 3) return 10000000;
  if (segment === 7) return 10000;
  return 100;
}
