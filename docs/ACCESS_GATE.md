# The GTS Algo Research access gate

A single **site passcode** gates the whole application. This document is the
contract for how that gate works, what it protects, and — just as importantly —
what it deliberately does NOT do.

## Threat model in one line

A direct API request without a valid session **must** receive `401`. A frontend
overlay is decoration, never security. Every guarantee below is enforced in
server code and covered by a test in `tests/access/`.

## What is protected

`requireOperator` (see `src/access/middleware.ts`) protects, with **no**
exceptions:

- every `/api/box/*` endpoint (via `src/box/routes.ts`)
- the Box SSE stream `GET /api/box/stream`
- `GET /api/runtime/status`
- `GET /api/export/status`
- every `/api/broker/*` endpoint (`status`, `switch-blockers`, `select`)

## What is public

Only these, and nothing else:

- `GET /api/health` — an unauthenticated liveness/readiness probe carrying no
  sensitive data (200 `ready:true` only when boot is complete; 503 `ready:false`
  while starting, failed or shutting down). Note: while the process is not `ready`,
  the single readiness gate refuses `POST /api/access/verify` and
  `POST /api/access/logout` with 503 — entering the site passcode is a mutation and
  cannot succeed until startup completes.
- `POST /api/access/verify` — the passcode check itself (rate-limited)
- `GET /api/access/status` — "am I already signed in?", so the passcode page
  does not 401-loop; it reveals only whether a live session exists
- the static assets needed to render the passcode page

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/access/verify` | public, rate-limited | check passcode, mint session + CSRF |
| GET | `/api/access/status` | public | is there a live session? returns the CSRF token if so |
| POST | `/api/access/logout` | session + CSRF + Origin | revoke the session row, clear cookies |

## The passcode check

- The presented passcode is compared against `SITE_ACCESS_SECRET` in **constant
  time**: both sides are reduced to a fixed-width sha256 digest and compared with
  `crypto.timingSafeEqual`, so neither the presented value's length nor its
  content leaks through timing.
- **FAIL CLOSED.** If `SITE_ACCESS_SECRET` is unset or blank, `verifyPasscode`
  returns `false` unconditionally and every protected route `401`s. An unset
  secret NEVER means "no passcode required".
- `POST /api/access/verify` is rate-limited to **10 attempts per 5 minutes per
  IP**; the 11th is refused with `429`. The invalid-passcode error is generic and
  identical whether the passcode was wrong or the secret is unset — the response
  never distinguishes the two.

## The session

- On a correct passcode the server mints a **256-bit CSPRNG** session token
  (`crypto.randomBytes(32)`, base64url) and a matching CSRF token.
- PostgreSQL stores **only the sha256** of each token, never the raw value. The
  token is high-entropy random, so sha256 is used purely as a fast fixed-width
  lookup index — not as a password hash (see `migrations/007_access_sessions.sql`
  for the full rationale).
- Sessions have a **hard expiry** (`SITE_SESSION_TTL_HOURS`, default 24). There is
  no sliding renewal, so a stolen cookie has a bounded life. Expired or revoked
  rows are treated as absent on use and removed by a **bounded periodic sweep**
  (`startSessionSweeper`, each tick `LIMIT`-bounded).

## Cookies

| Cookie | HttpOnly | Secure | SameSite | Path | Purpose |
| --- | --- | --- | --- | --- | --- |
| `SESSION_COOKIE_NAME` | **yes** | prod: yes | Strict | `/` | the bearer credential; JS can never read it |
| `<SESSION_COOKIE_NAME>_csrf` | **no** | prod: yes | Strict | `/` | JS-readable so the SPA can recover the token after a reload and echo it in the `x-csrf-token` header; never accepted as proof itself |

`Secure` is always set in production. It is omitted **only** in non-production
over http (`config.isProduction === false`) so local development works; this is
the single, explicit, commented exception in `src/access/cookies.ts`. Production
is the only value that tightens, never relaxes.

## CSRF + Origin (mutating requests)

Every `POST/PUT/PATCH/DELETE` behind `requireOperator` must satisfy ALL of:

1. a valid **HttpOnly session cookie** (a live session), and
2. an **Origin** header that exactly matches `CSRF_ALLOWED_ORIGIN`
   (scheme+host+port). A missing Origin is refused, and
3. a **non-empty `x-csrf-token` HEADER** whose sha256 matches the session-bound
   digest, compared in constant time. A present-but-empty/whitespace header is
   rejected exactly like a missing one.

**The header is the only accepted proof.** The JS-readable `<name>_csrf` cookie is
NEVER accepted as a substitute for the header. Its sole purpose is to let the SPA
recover the token after a page reload; it is a convenience, not a credential. A
cross-site form POST makes the browser attach our cookies automatically, so a
cookie-as-header fallback would silently defeat the whole scheme — which is why the
server reads the token from the header and nothing else. The CSRF header defeats a
cross-site POST because the attacker's page cannot READ our non-HttpOnly CSRF
cookie to forge the header; the Origin check is a second, independent guard.

`logout` enforces the same header + Origin discipline inline **when there is a live
session** (it is not behind `requireOperator`). When there is NO live session
(expired/revoked/unknown) it clears the cookies and returns 200
`{authenticated:false}` **without** requiring a header: there is no session state
to protect, and forcing a header would strand a browser holding a dead cookie. This
asymmetry does not weaken CSRF protection, because the header only ever guards a
live session's state — with no live session there is nothing to guard.

## SSE

`GET /api/box/stream` authenticates from the **secure, same-origin session
cookie** via `requireOperator`. A session token supplied in the **query string is
never accepted** — `getOperatorRole(req)` reads only the validated session the
middleware attached, never a header or query token. This is structural, not a
check that could be bypassed.

## CORS

Hand-rolled (no `cors` dependency) in `corsMiddleware`. Exact-origin with
credentials: `Access-Control-Allow-Origin` is echoed as `config.frontendUrl` only
when the request Origin matches, alongside `Access-Control-Allow-Credentials:
true`. It is **never** `*` — a wildcard with credentials is both illegal and a
data-leak. A foreign origin receives no ACAO header at all.

## Roles

`getOperatorRole` returns `"full"` for a valid session and `null` otherwise. The
type keeps the predecessor codebase's two-role shape (`"full" | "trade" | null`) so
`src/box/routes.ts` ports with a one-line import change, but the passcode gate
only ever mints `"full"`.

## The line the passcode does NOT cross

Entering the site passcode grants the FULL Box **control** surface. It **arms
nothing**. Live trading still requires, entirely independently:

- `BOX_EXECUTION_MODE=live` **and**
- `BOX_LIVE_TRADING_ENABLED=true` **and**
- the active broker's own deployment gate, and
- an explicit runtime arm.

The `tests/access/` suite asserts a successful login never calls the
live-trading enable path.

## Error shape

All API errors are JSON `{ "error": <message>, "code": <stable-code> }` via
`sendApiError` / `ApiError` and the terminal `errorHandler`. No response ever
contains a stack trace, SQL text, a credential or a broker/session token; the
bounded, secret-free form is logged server-side only.

## Environment

| Variable | Meaning |
| --- | --- |
| `SITE_ACCESS_SECRET` | the site passcode; unset ⇒ fail closed |
| `SITE_SESSION_TTL_HOURS` | session lifetime (default 24) |
| `SESSION_COOKIE_NAME` | session cookie name (CSRF cookie is `<name>_csrf`) |
| `CSRF_ALLOWED_ORIGIN` | required Origin on mutating requests (defaults to `FRONTEND_URL`) |
| `FRONTEND_URL` | the single exact CORS origin |

`SITE_ACCESS_SECRET` is deliberately distinct from every broker/token secret
(`KITE_TOKEN_BROKER_PASSCODE`, `DHAN_TOKEN_BROKER_PASSCODE`, the external CalSpread
`TOKEN_ROUTE_SECRET`, `KITE_API_SECRET`, any broker access token) and is never
reused for them.
