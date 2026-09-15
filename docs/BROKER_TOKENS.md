# Broker token acquisition, storage and the active-broker record

Access tokens reach this backend by exactly **one of two mutually exclusive
mechanisms**, selected by `BROKER_LOGIN_MODE`:

| Mode | How a token is obtained |
| --- | --- |
| `in_app` (**default**) | The operator signs in to the broker **from this deployment**. This backend runs the OAuth/consent flow itself and mints the token. |
| `provider` | The token is fetched from the external CalSpread token route using a shared passcode (the historical behaviour). |

They never run at the same time: a poller racing an interactive login is a way to
overwrite a session the operator just established, so in `in_app` mode the poller is
not started at all.

Either way the token is validated hard, encrypted with AES-256-GCM and stored in
PostgreSQL, one row per broker. **Both brokers may hold a valid session at the same
time.** Only one broker is ever *active*; the other holds a standby token and opens
no socket. Signing in to a broker never makes it active, and switching the active
broker never touches the other broker's token.

This document is the contract for `src/tokens/*`, `src/brokerState/*`,
`src/brokers/zerodha/auth.ts`, `src/brokers/dhan/auth.ts`, `src/brokerAuth/*`,
`src/brokerAuthRoutes.ts`, `src/tokenExposureRoutes.ts`, migrations `005`–`006` and
`ActiveBrokerManager`.

## The in-app login flow (`BROKER_LOGIN_MODE=in_app`)

Both brokers follow the same three-step shape. Steps 1 and 3 are server-side; only
step 2 happens in the operator's browser.

```
  1. POST /api/broker/{broker}/login/start     (operator session + CSRF required)
        -> { broker, login_url, expires_at }
     A single-use nonce is recorded in the pending-login store.

  2. The BROWSER visits login_url and authenticates at the broker (password + 2FA).
     The broker redirects to the URL REGISTERED ON THE BROKER APP, which must be
        https://<api-host>/api/broker/{broker}/callback

  3. GET /api/broker/{broker}/callback
     The pending-login entry is claimed (single-use), the one-time code is exchanged
     for an access token server-side, the token is sealed into PostgreSQL and
     installed, then the browser is redirected to
        {FRONTEND_URL}/box?broker_login={broker}&status=connected
     or ...&status=failed&reason=<stable code>
```

### Per broker

| | Zerodha (Kite Connect v3) | Dhan (v2 consent) |
| --- | --- | --- |
| Consent URL | `kite.zerodha.com/connect/login?v=3&api_key=…&redirect_params=state%3D<nonce>` | `POST {authRoot}/app/generate-consent` → consent id → browser visits the login URL |
| Redirect carries | `request_token` (+ our echoed `state`) | `tokenId` |
| Exchange | `POST api.kite.trade/session/token` with `checksum = sha256(api_key + request_token + api_secret)` | `GET {authRoot}/app/consumeApp-consent?tokenId=…` with the id/secret headers |
| Token expiry | **Day-scoped.** Dies at the IST day boundary; no stated instant, and one is never invented. | **Explicit `expiryTime`.** `null` means UNKNOWN — validated by use, never treated as immortal or expired. |
| CSRF proof on callback | `state` nonce matched in constant time | existence + TTL + single-use only (Dhan round-trips nothing of ours) |

**The redirect URL must be registered on the broker app and must point at this
backend's callback.** Both brokers ignore any redirect target we send and always use
their registered copy, so a mismatch is the most common cause of a login that never
completes.

### Why the Dhan consent endpoints are configurable

Dhan has shipped this flow under two naming schemes — an "app" variant
(`/app/generate-consent`, `/app/consumeApp-consent`, `app_id`/`app_secret`,
`consentAppId`) and a "partner" variant (`/partner/…`, `partner_id`/`partner_secret`,
`consentId`) — and which one a given set of credentials speaks depends on how the app
was registered. Hardcoding one would 404 for half of all deployments and look like a
credential problem. Every path, parameter and header name is therefore an environment
variable defaulting to the "app" variant. `generateDhanConsent` accepts **both**
consent-id spellings for the same reason.

### Security properties of the login path

- The app **secret** (`KITE_API_SECRET`, `DHAN_API_SECRET`) is only ever used inside
  this process — as a checksum input or a request header. It is never a query
  parameter, never logged, never returned by any API.
- Both auth clients require **https** outside tests, refuse to follow **any 3xx**
  (which would replay the credential to another host), bound headers *and* body with
  a single `AbortController`, and cap the response body at 64 KiB.
- The callback is authenticated by the **pending-login store**, not the session
  cookie (which is `SameSite=Strict` and therefore absent on a cross-site redirect).
  Entries are single-use and expire in 10 minutes.
- **Several operators may sign in at the same time.** Entries are keyed by nonce, not by
  broker, so two people clicking "Connect Zerodha" within the TTL each complete on their own
  nonce (bounded at 8 live entries per broker, oldest evicted). This is a shared console:
  anyone with the passcode is a legitimate operator, and concurrent sign-ins are ordinary.
- A sign-in is **not tied to the browser that started it**: the callback needs no cookie, so a
  redirect can legitimately land in a different browser than the one that clicked Connect.
- Failure reasons reflected into the redirect URL are **stable codes from our own
  code**, never broker prose.
- The callback refuses while the process is not `ready`.

## Token exposure for sibling services

Two routes let **other servers** borrow the token this deployment minted, so only one
place ever runs a broker login:

```
GET /api/tokens/zerodha     header  x-token-access-key: <TOKEN_EXPOSURE_KEY>
GET /api/tokens/dhan        header  x-token-access-key: <TOKEN_EXPOSURE_KEY>

200 { broker, access_token, identity, login_date, expires_at, active, fetched_at }
```

`identity` is the value the token must be **paired** with: the Kite `api_key` for
Zerodha (`Authorization: token <identity>:<access_token>`), the Dhan client id for
Dhan (`client-id: <identity>`, `access-token: <access_token>`).

A token is returned **only when currently usable**:

- Zerodha's `login_date` must be today's IST day (Kite sessions die at the day boundary);
- Dhan's stated expiry must not have passed (a `null` expiry is UNKNOWN, and accepted);
- the `identity` must be non-empty — Zerodha authenticates with the PAIR
  `api_key:access_token`, so a token with no api key to pair it with is unusable and is
  reported as such rather than served. The configured `KITE_API_KEY` is used as a fallback
  before giving up.

Otherwise `409` with a reason (`token_unavailable_no_session`, `…_session_expired`,
`…_session_stale_day`, `…_no_identity`) so a polling caller backs off instead of caching a
dead credential.

**Signing out here does not revoke at the broker.** It stops this deployment serving the
token; a sibling service that already fetched it keeps a working credential until the broker
itself expires it. Rotate at the broker if a token must be treated as compromised.

**These are the only two routes in this backend that return a plaintext access
token.** That is a deliberate, bounded exception to the invariant stated below, and it
is fenced accordingly:

- **Off by default** — `TOKEN_EXPOSURE_KEY` unset ⇒ `503` everywhere. Opt-in only.
- A key shorter than **32 characters** is refused as misconfiguration, not honoured.
- Header-only credential, compared in **constant time**; never a query string.
- Rate limited to **30 req/min per IP**; read-only; never logged; `no-store`.
- Not under `/api/broker/*`, so that prefix's no-token invariant stays literally true.
- Not the site passcode, so a leaked machine credential is independently revocable.
- **Serve over TLS and restrict at the network layer.** The body is a live credential.

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
| `BROKER_LOGIN_MODE` | `in_app` (this backend runs the login) or `provider` (external token route) | `in_app` |
| `KITE_API_KEY` | Kite app api key. Public; in the consent URL and the auth header | — |
| `KITE_API_SECRET` | Kite app **secret**. Checksum input only; never transmitted | — |
| `KITE_REDIRECT_URL` | The callback registered on the Kite app. Informational | — |
| `KITE_LOGIN_URL` | Consent URL override (tests / host change) | `https://kite.zerodha.com/connect/login` |
| `KITE_API_ROOT` | Exchange root override | `https://api.kite.trade` |
| `DHAN_API_KEY` | Dhan app id. Sent as the id header on consent calls | — |
| `DHAN_API_SECRET` | Dhan app **secret**. Sent as the secret header only | — |
| `DHAN_REDIRECT_URL` | The callback registered on the Dhan app. Informational | — |
| `DHAN_POSTBACK_URL` | Order postback URL on the Dhan app. Unused by the login | — |
| `DHAN_AUTH_ROOT` | Dhan auth host | `https://auth.dhan.co` |
| `DHAN_CONSENT_GENERATE_PATH` | Consent-generation path | `/app/generate-consent` |
| `DHAN_CONSENT_CONSUME_PATH` | Consent-consumption path | `/app/consumeApp-consent` |
| `DHAN_CONSENT_LOGIN_URL` | Browser login URL | `{DHAN_AUTH_ROOT}/login/consentApp-login` |
| `DHAN_CONSENT_ID_PARAM` | Query parameter carrying the consent id | `consentAppId` |
| `DHAN_AUTH_ID_HEADER` | Header carrying the app/partner id | `app_id` |
| `DHAN_AUTH_SECRET_HEADER` | Header carrying the app/partner secret | `app_secret` |
| `TOKEN_EXPOSURE_KEY` | Enables `/api/tokens/*`. Min 32 chars. Unset ⇒ disabled | — |

The `KITE_TOKEN_*` / `DHAN_TOKEN_*` / `BROKER_TOKEN_POLL_*` variables are read **only
when `BROKER_LOGIN_MODE=provider`**.

The **two passcodes are separate variables**. The operator may set the same value
for both, but the code never assumes they are equal and never copies one into the
other. `SITE_ACCESS_SECRET` is never reused as a broker passcode.

## Outgoing HTTP (`tokenProviderClient.ts`) — `BROKER_LOGIN_MODE=provider` only

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

## Signing out

`POST /api/broker/{broker}/logout` drops ONE broker's session: the in-memory token, the
durable row, and — when that broker is the ACTIVE one — both of its market-data lanes and its
books. The other broker's session, feed and subscriptions are untouched.

It is **refused with `409 logout_refused`** when the broker being signed out is active and
still owns exposure or in-flight work, using the same blocker list as
`POST /api/broker/select`. See `docs/SAFETY_INVARIANTS.md`.

A failed durable clear is reported as a per-broker login problem rather than swallowed: the
row would still be `active`, so the token-exposure endpoint would keep serving a credential the
operator believes they have dropped.

## Re-authenticating replaces the sockets, not just the token

Both `completeZerodhaLogin` and `completeDhanLogin` **stop and drop that broker's market-data
lanes** before replaying the subscription tables, and only when that broker is the active one.

This is load-bearing rather than tidy-up. Neither transport re-authenticates a connection it
already holds — `TickerHub.ensureSocket` reads credentials only when it has no handle, and both
feed classes subscribe only tokens they are not already subscribed to — so without dropping the
sockets first, a re-authentication would leave them bound to the **superseded** token while the
runtime reported the feed healthy. When the broker later retired that token, the box lane's
auth-death path tears down without scheduling a reconnect, so the lane would stay dead until the
next strike-window diff.
