# Broker order-update stream documentation — verified facts

**Verification date: 2026-09-09.** Fetched directly from the vendors' current published
documentation on that date. Every claim below is either quoted from those pages or explicitly
marked `NOT DOCUMENTED`. Nothing here is inferred from library source or blog posts.

Sources:

- Zerodha Kite Connect v3 — WebSocket streaming: <https://kite.trade/docs/connect/v3/websocket/>
- Zerodha Kite Connect v3 — Postbacks / WebHooks: <https://kite.trade/docs/connect/v3/postbacks/>
- DhanHQ v2 — Live Order Update: <https://dhanhq.co/docs/v2/order-update/>

---

## 1. Zerodha — order updates ride the MARKET-DATA socket

**Endpoint.** `wss://ws.kite.trade?api_key=<key>&access_token=<token>`. Authentication is by
query parameter at handshake; there is no separate in-band login frame.

**Connection limits (documented).**

- Up to **3000 instruments** subscribed per connection.
- **A single API key may hold at most 3 WebSocket connections.**

> Consequence for GTS Algo Research: order updates need **no additional socket**. Zerodha multiplexes
> order postbacks onto the same connection as the binary ticks. We already open one connection
> for the futures lane and one for the box lane; the third stays free. Adding a dedicated
> order socket for Zerodha would consume the last slot and protect against nothing, because a
> dropped connection drops both the ticks and the postbacks on it anyway.

**Frame typing — the load-bearing rule.** Quoted: *"Always check the type of an incoming
WebSocket messages. Market data is always binary and Postbacks and other updates are always
text."* So: binary → tick decoder, text → order/message/error handler. Never the reverse.

**Heartbeat.** Quoted: *"If there is no data to be streamed over an open WebSocket connection,
the API will send a 1 byte 'heartbeat' every couple seconds to keep the connection alive."*

> This is a TRANSPORT heartbeat only. It proves the socket is alive; it proves nothing about
> whether any instrument's book is fresh. The two must be tracked as separate facts.

**Text frame envelope.** `{"type": "...", "data": ...}` with these documented types:

| `type` | `data` |
| --- | --- |
| `order` | full order Postback payload (object) |
| `error` | error string |
| `message` | broker message/alert string |

**Who the events belong to.** Quoted from the Postbacks page: *"For individual developers,
Postbacks over WebSocket is recommended, where, orders placed for a particular user anywhere,
for instance, web, mobile, or desktop platforms, are sent."*

> Therefore the stream is **account-wide**, not app-wide. An order this process never placed
> will appear on it. Ownership attribution is mandatory, never optional.

**Order postback payload — fields we rely on.**

| Field | Type | Documented meaning |
| --- | --- | --- |
| `order_id` | string | unique order id |
| `exchange_order_id` | null \| string | *"Orders that don't reach the exchange have null ids"* |
| `status` | null \| string | *"The possible values are COMPLETE, REJECTED, CANCELLED, and UPDATE"* |
| `status_message`, `status_message_raw` | null \| string | human / raw OMS reason |
| `filled_quantity` | int64 | quantity filled (CUMULATIVE) |
| `unfilled_quantity`, `pending_quantity`, `cancelled_quantity` | int64 | remainder breakdown |
| `quantity` | int64 | quantity ordered |
| `average_price` | float64 | *"Average price at which the order was executed (only for COMPLETE orders)"* |
| `tag` | null \| string | *"optional tag ... (alphanumeric, max 20 chars)"* |
| `user_id` | string | *"ID of the user for whom the order was placed"* |
| `order_timestamp` | string | *"registered by the API"* |
| `exchange_update_timestamp` | string | *"at which an order's state changed at the exchange"* |
| `exchange_timestamp` | string | *"registered by the exchange. Orders that don't reach the exchange have null timestamps"* |

Two consequences we encode:

1. `status: "UPDATE"` is *"triggered when an open order is modified or when there's a partial
   fill"*. It is **not** terminal and **not** proof of a fill. Quantity comes from
   `filled_quantity`, never from the label.
2. `average_price` is documented as populated *only for COMPLETE*. A priced fill therefore
   cannot be demanded on partial updates; missing price must degrade accounting quality
   without erasing the confirmed quantity.

**Ownership keys available.** `tag` (max 20 chars, our stable strategy key) and `order_id`,
validated against `user_id`. This matches `OrderOwnershipKey` exactly.

**Checksum.** The `checksum` field and its SHA-256 verification are specified for the **HTTP
postback webhook**, whose purpose is to authenticate an unauthenticated inbound POST. The
WebSocket carries the same payload inside an already-authenticated session, so no checksum
validation is required on this path. We do not require one.

**Timestamp precision.** Every documented order timestamp is `"YYYY-MM-DD HH:MM:SS"` — **whole
seconds**, IST, with no zone suffix. In the binary quote packet the exchange timestamp is an
`int32` at bytes 60–64, also whole seconds.

> Consequence: a sub-second exchange-time freshness threshold is meaningless against Zerodha
> data and would reject perfectly valid quotes. Exchange-time checks must be coarse; sub-second
> discipline belongs to receive/processing clocks only.

**Sequence numbers.** `NOT DOCUMENTED`. Kite publishes no per-postback sequence number and no
exchange sequence number. Deduplication must therefore rest on cumulative monotonicity plus a
composite event identity (`order_id` + update timestamp + filled quantity). We must not invent
a sequence from a local counter and present it as exchange ordering.

**Reconnect / replay.** `NOT DOCUMENTED`. Kite does not promise replay of postbacks missed
while disconnected. A reconnect therefore obliges REST reconciliation; a gap must never be
read as "no fills happened".

---

## 2. Dhan — a dedicated order-update socket

**Endpoint.** `wss://api-order-update.dhan.co` (distinct from the market feed
`wss://api-feed.dhan.co`).

**Authorisation.** An explicit in-band login frame is required after the socket opens:

```json
{ "LoginReq": { "MsgCode": 42, "ClientId": "<clientId>", "Token": "<JWT access token>" },
  "UserType": "SELF" }
```

`MsgCode` is documented as `42` for order updates. `UserType` is `SELF` for individual
accounts (`PARTNER` + `Secret` exists for partner platforms; GTS Algo Research is `SELF`).

**Auth acknowledgement.** `NOT DOCUMENTED` — the docs specify no success frame. A rejected
authorisation is observable only as a close/error. Consequently the consumer must not treat
"socket open" as "authorised and delivering"; readiness has to be corroborated by an actual
event or by REST reconciliation, and a close shortly after login must be treated as a possible
auth failure rather than a transient network drop.

**Connection limit for THIS socket.** `NOT DOCUMENTED`. The order-update page states no
per-user cap. We must not assert one, and must not open redundant order sockets on the
assumption that headroom exists.

**Message envelope.** `{"Data": { ... }, "Type": "order_alert"}`.

**Who the events belong to.** Quoted: *"Once you connect to the WebSocket and authorise, all
order updates in your acount will get reflected real time via the stream"* — and, for
individuals, *"order updates for all orders placed via your account, irrespective of the
platform via which it was placed."*

> Account-wide again. Attribution by `CorrelationId` + `ClientId` is mandatory.

**Order alert fields we rely on.**

| Field | Type | Documented meaning |
| --- | --- | --- |
| `Status` | enum string | `TRANSIT` `PENDING` `REJECTED` `CANCELLED` `TRADED` `EXPIRED` |
| `Quantity` | int | total order quantity placed |
| `TradedQty` | int | *"Actual quantity executed on exchange"* (CUMULATIVE) |
| `RemainingQuantity` | int | quantity pending execution |
| `TradedPrice` | float | price of a trade of the order |
| `AvgTradedPrice` | float | *"Average trade price of an order (this will be different from Traded Price in case of partial execution)"* |
| `CorrelationId` | string | *"The user/partner generated id for tracking back"*, **max 30 chars** |
| `ClientId` | string | the Dhan account |
| `OrderNo` | string | Dhan order id |
| `ExchOrderNo` | string | exchange order id |
| `TxnType` | enum | `B` buy / `S` sell |
| `Source` | string | *"`P` for API Orders"* |
| `ReasonDescription` | string | *"Order rejection reason"* |
| `OrderDateTime` | string | *"Time at which the order is received by Dhan"* |
| `ExchOrderTime` | string | *"Time at which order is placed on Exchange"* |
| `LastUpdatedTime` | string | *"Last update time of any order modification or trade"* |
| `SecurityId` | string | exchange instrument id |
| `LegNo` | int | `1` entry, `2` stop-loss, `3` target |

Consequences we encode:

1. `Status: "TRADED"` is a **label**, not a quantity. `TradedQty` is the only quantity
   evidence. A `TRADED` alert whose `TradedQty` is absent is *insufficient evidence*, not a
   zero fill and not a complete fill — exactly the defect class in item 1B.
2. `CANCELLED` without a quantity field is likewise not a confirmed zero.
3. `AvgTradedPrice` may legitimately lag or be absent on partials; confirmed `TradedQty`
   establishes exposure regardless, while missing price must block fabricated P&L.
4. `Source` distinguishes API-placed orders, but is **not** sufficient for ownership — other
   API tooling on the same account also reports `P`. `CorrelationId` is the ownership key.

**Ownership keys available.** `CorrelationId` (≤30 chars) and `OrderNo`, validated against
`ClientId`. Matches `OrderOwnershipKey`.

**Timestamp precision.** `"YYYY-MM-DD HH:MM:SS"` — whole seconds, IST, no zone suffix. Same
coarse-threshold consequence as Zerodha.

**Sequence numbers.** `NOT DOCUMENTED`. No per-event sequence token is published. Dedup rests
on cumulative monotonicity plus composite identity (`OrderNo` + `LastUpdatedTime` +
`TradedQty`).

**Reconnect / replay.** `NOT DOCUMENTED`. No replay promise. Reconnect ⇒ mandatory REST
reconciliation before the stream is trusted again.

**Market feed, for contrast (already relied on elsewhere).** `wss://api-feed.dhan.co`, and
`LastTradeTime` in the feed is exactly that — the time of the last trade. It is **not** the
order-book publication time and must never be used as one.

---

## 3. What this documentation does NOT give us

Stated plainly so no downstream doc overclaims:

- **No exchange sequence numbers** from either broker on any path we use. We can detect
  cumulative-quantity regressions and duplicate event identities; we cannot prove exchange
  ordering. Any ordering claim beyond that is unsupported.
- **No replay guarantee** after a disconnect from either broker. Every reconnect owes a REST
  reconciliation.
- **No auth-success frame** from Dhan's order socket, and no documented order-socket
  connection cap.
- **No sub-second exchange timestamps** anywhere in the documented order or quote payloads.
- **No promise of losslessness.** Both streams are best-effort delivery of account-wide
  events; REST remains the authority of record.
