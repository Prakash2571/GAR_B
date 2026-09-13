# Broker token acquisition, storage and the active-broker record

This backend never performs its own broker OAuth. Both access tokens are fetched from
the external CalSpread token provider, validated hard, encrypted with AES-256-GCM and stored in PostgreSQL. Only
one broker is ever *active*; the other may hold a valid standby token but opens no
socket. This document is the contract for the modules under `src/tokens/*`,
`src/brokerState/*`, migrations `005`–`006` and the ported `ActiveBrokerManager`.

## Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `APP_TIMEZONE` | Must be `Asia/Kolkata`; every day/time decision is an IST decision | `Asia/Kolkata` |
| `KITE_TOKEN_BROKER_URL` | External CalSpread Zerodha token route | `https://calspread.online/api/kite/token` |
| `KITE_TOKEN_BROKER_PASSCODE` | Passcode for the Zerodha route (own variable) | — |
| `KITE_API_KEY_EXPECTED` | If set, the returned `api_key` must equal it | — |
| `DHAN_TOKEN_URL` | External CalSpread Dhan token route | `https://calspread.online/api/dhan/token` |
| `DHAN_TOKEN_BROKER_PASSCODE` | Passcode for the Dhan route (own variable) | — |
| `DHAN_CLIENT_ID_EXPECTED` | If set, the returned `client_id` must equal it | — |
| `BROKER_TOKEN_POLL_START` | IST time to begin each morning's acquisition | `09:00` |
| `BROKER_TOKEN_POLL_INTERVAL_MS` | Retry interval per broker | `60000` |
| `BROKER_TOKEN_REQUEST_TIMEOUT_MS` | Per-request timeout | `10000` |
| `BROKER_TOKEN_ENCRYPTION_KEY` | 32 bytes as 64-char hex or base64 | — |
| `DEFAULT_ACTIVE_BROKER` | Preferred broker on a fresh deployment | `zerodha` |
| `AUTO_FALLBACK_TO_DHAN` | Auto-start Dhan entry when Zerodha is down and flat | `false` |

The **two passcodes are separate variables**. The operator may set the same value
for both, but the code never assumes they are equal and never copies one into the
other. `SITE_ACCESS_SECRET` is never reused as a broker passcode.

## Outgoing HTTP (`tokenProviderClient.ts`)

- Passcode is sent in the **`x-token-passcode` header**, never the query string.
- A redirect to another host is refused; HTTPS is required outside tests.
- The request is timeout-bounded and the response body capped at 64 KiB.
- **Never logged:** either passcode, either raw access token, Authorization
  headers, ciphertext, IV, auth tag, or a full provider response body.

### Validation per broker

**Zerodha** success `{ authenticated, api_key, access_token, login_date }`:
`authenticated === true`; non-empty `api_key` and `access_token`; `login_date`
**equals the current IST day**; `api_key === KITE_API_KEY_EXPECTED` when configured.

**Dhan** success `{ authenticated, client_id, access_token, expires_at, login_date }`:
`authenticated === true`; non-empty `client_id` and `access_token`; `login_date` a
valid IST date (need **not** be today when an explicit future `expires_at` is
present); `client_id === DHAN_CLIENT_ID_EXPECTED` when configured; `expires_at` is a
valid **future** epoch-ms **or** `null`. A past `expires_at` is rejected. `null`
expiry means **unknown** — validated operationally and retired on an auth rejection;
it never means permanently valid.

### HTTP disposition

| Status | Result | Behaviour |
| --- | --- | --- |
| 200 + valid | `ready` | encrypt, store, install |
| 409 | `retry` | no upstream session yet; retry next interval |
| network / 5xx | `retry` | transient; retry without overlapping |
| 401 / 403 | `configuration_error` | passcode/config wrong; **stop hammering** that broker |
| 503 | `blocker` | route not configured; retry with bounded backoff |
| malformed JSON / identity mismatch / redirect | `security_error` | never install |

## Scheduling (`istClock.ts`, `brokerTokenService.ts`)

- Uses the same fixed **+5:30** arithmetic as `boxSupport.istDayKey`, so a day
  boundary means one thing everywhere. The clock is injectable for tests.
- Before 09:00 IST the first attempt is scheduled for 09:00. If the process starts
  after 09:00 and a broker lacks a valid token for the current IST day, it fetches
  immediately.
- Delays are computed from the current IST wall time, so scheduling does not drift
  with process uptime.

### Independent per-broker state machines

At most **one in-flight request per broker**; the two cannot overwrite each other;
one slow provider never blocks the other; success stops polling **only** that
broker for that IST day; timers are cleared on shutdown. Token acquisition, token
storage and market data **never** arm live trading.

On Zerodha success the injected callbacks install the key+token into the Kite
client, load the universe, and — **only if Zerodha is the active broker** — start
the single Box WebSocket, resubscribe, invalidate stale books and let scanner
readiness follow fresh authoritative depth. The engine is never imported here.

### Runtime status

`GET /api/runtime/status` exposes, per broker: `state`
(`waiting | polling | ready | invalid | configuration_error`), current IST day,
last attempt/success times, a **redacted** error, feed-connected state,
wanted/subscribed token counts, last authoritative depth age, reconnect count. It
**never** contains an access token or a passcode.

## At-rest encryption (`migrations/005`, `tokenCrypto.ts`, `brokerSessions.ts`)

`broker_sessions` is keyed by `broker` (`zerodha` | `dhan`), one row each, strictly
separate. Columns: `encrypted_access_token`, `encryption_iv`,
`encryption_auth_tag`, `credential_version`, `broker_identity`,
`api_key_or_client_id`, `login_date`, `expires_at`, `acquired_at`,
`last_validated_at`, `source_url_hash`, `status`, `invalidated_at`,
`invalidation_reason`, `updated_at` (all timestamps `timestamptz`).

- AES-256-GCM with `BROKER_TOKEN_ENCRYPTION_KEY` (exactly 32 bytes; base64 or
  64-char hex, else a clear error). A **fresh random IV on every write**.
- The non-secret metadata (`broker`, `credential_version`, `api_key_or_client_id`,
  `login_date`) is authenticated as **AAD**, so tampering with it fails decryption.
- Decryption happens **only** inside `brokerSessions.ts`. Encrypted fields are never
  returned through an API, never copied to MongoDB, never placed in the outbox,
  never exposed to the frontend (the outbox writer's deny list enforces this).
- If a stored session exists but the key is missing/invalid, load **throws** — it
  never silently returns "no session" and never returns a wrong token.
- `brokerSessions.ts` exports `loadDhanSession`, `saveDhanSession`,
  `clearDhanSession`, `loadActiveBroker`, `saveActiveBroker` (plus the Zerodha
  equivalents) with the predecessor codebase's signatures, so `ActiveBrokerManager` is ported by
  changing a single import line from `../db.js` to
  `../brokerState/brokerSessions.js`.

### Key rotation

`npm run rotate:broker-token-key` (`src/scripts/rotateBrokerTokenKey.ts`) reads the
old and new keys from `BROKER_TOKEN_OLD_KEY` / `BROKER_TOKEN_NEW_KEY` (never the
command line), decrypts and re-encrypts every active session inside **one**
PostgreSQL transaction, prints no token material, supports `--dry-run`, and rolls
back completely on failure.

## Durable active broker (`migrations/006`)

`active_broker` is a single row carrying the active broker and a **monotonic
`generation`** sourced from `active_broker_generation_seq`.
`saveActiveBroker(broker, selectedBy)` advances the generation atomically and
returns the new value; `loadActiveBroker()` returns `{ broker, generation }`. The
generation never repeats and is monotonic across restarts, because durable
instrument reservations are stamped with it and refuse to authorise a submission
when it no longer matches. Switching brokers does **not** reset daily risk.

## Single-active-broker invariant and the guarded switch

Exactly one active broker context, or none. Only the active broker's Box WebSocket
may connect; the inactive broker stays in standby with no scanner, no strategy
subscriptions, no speculative order adapter and no live opportunity publication.
Zerodha tokens are never mixed with Dhan instruments, nor depth/orders/charges/
margins/order-ids/generations across brokers.

Live execution requires `BOX_EXECUTION_MODE=live` **and**
`BOX_LIVE_TRADING_ENABLED=true` **and** the selected broker's own gate
(`ZERODHA_LIVE_TRADING_ENABLED` or `DHAN_LIVE_TRADING_ENABLED`). Defaults:
`BOX_EXECUTION_MODE=paper_latency` and all three booleans false. Only the active
broker may construct a mutation-capable adapter, and adapter-construction failure
never falls back to the other broker.

`ActiveBrokerManager.switchBroker` preserves the guarded sequence: disable new
entry, stop scanner discovery, quiesce entry pipelines, refuse if exposure/
uncertainty remains, stop the outgoing feed, clear its subscriptions, invalidate
all books and quote generations, clear process-owned reservations, atomically
advance `active_broker` + generation in PostgreSQL, load the incoming universe,
build the incoming charge/margin providers, start the incoming feed, resubscribe
the strike window, wait for fresh depth, publish, and keep scanner discovery
**stopped** until explicitly restarted.

### Morning default

Prefer Zerodha at/after 09:00 IST, but never blindly reset merely because the date
changed. Automatic Zerodha selection is allowed only when there is no Dhan exposure
or unresolved ownership of any kind (open/partial/recovery/residual positions,
working/ambiguous/nonterminal orders or intents, in-flight execution, in-progress
reconciliation, an owned session cycle awaiting completion), Zerodha has a valid
token and its runtime prerequisites are satisfied — all computed by the
`ExposureProbe`. Any Dhan exposure keeps Dhan active, preserves its execution
adapter for reduction/reconciliation, and records the blocked default. If Zerodha
is unavailable but Dhan is valid and the system is flat, Dhan is reported
`ready — standby` and entry does **not** auto-start unless
`AUTO_FALLBACK_TO_DHAN=true`.

## Tests

`tests/tokens/**` and `tests/switch/**` run with `node:test`, a fake clock and a
local mock HTTP server on `127.0.0.1` (never contacting calspread.online), against
PostgreSQL at `DATABASE_URL`. They **fail loudly** without PostgreSQL rather than
skipping.
