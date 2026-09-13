/**
 * Access-gate end-to-end tests. A real Express app on an ephemeral port, driven
 * with fetch, against a real PostgreSQL. FAILS LOUDLY without PostgreSQL.
 *
 * Covers every case the task requires:
 *  - unset SITE_ACCESS_SECRET fails closed (verify fails, protected routes 401)
 *  - wrong passcode -> generic error
 *  - correct passcode -> HttpOnly + SameSite=Strict cookie + a CSRF token
 *  - protected route without cookie -> 401; with a valid cookie -> 200
 *  - SSE without a cookie -> 401; a session token in the query string is NOT accepted
 *  - mutating request without the CSRF header -> refused
 *  - mutating request with a foreign Origin -> refused
 *  - CORS never answers `*` when credentials are allowed
 *  - logout revokes the row and clears the cookie so the old cookie 401s
 *  - expired session is rejected and swept
 *  - rate limiter allows 10 verify attempts / 5 min / IP and refuses the 11th
 *  - a successful login does NOT arm live trading
 *  - error responses contain no stack trace and no SQL
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cookieHeader, createDbSchema, parseSetCookies, startApp, verify } from "./helpers.mjs";

const SECRET = "correct-horse-battery-staple";
const COOKIE = "gts_session";
const CSRF_COOKIE = "gts_session_csrf";
const ORIGIN = "http://localhost:5173";

let db;
before(async () => {
  db = await createDbSchema("access_main");
});
after(async () => {
  if (db) await db.drop();
});

/* ----------------------------- fail closed ------------------------------- */

test("unset SITE_ACCESS_SECRET fails closed: verify fails and protected routes 401", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: undefined } });
  try {
    // Even presenting a blank or any passcode must fail — unset != "no passcode".
    const v = await verify(app.origin, "");
    assert.equal(v.res.status, 401);
    const v2 = await verify(app.origin, "anything");
    assert.equal(v2.res.status, 401);

    const protectedRes = await fetch(`${app.origin}/api/box/status`);
    assert.equal(protectedRes.status, 401);
    const runtimeRes = await fetch(`${app.origin}/api/runtime/status`);
    assert.equal(runtimeRes.status, 401);
  } finally {
    await app.close();
  }
});

/* ----------------------------- wrong passcode ---------------------------- */

test("wrong passcode returns a generic error indistinguishable from unset", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const wrong = await verify(app.origin, "not-the-passcode");
    assert.equal(wrong.res.status, 401);
    assert.equal(wrong.body.code, "invalid_passcode");
    // The message must not reveal whether the secret is set or what was wrong.
    assert.match(wrong.body.error, /invalid passcode/i);
    assert.ok(!/unset|configured|not set/i.test(wrong.body.error));
  } finally {
    await app.close();
  }
});

/* ------------------------- correct passcode + cookie --------------------- */

test("correct passcode sets HttpOnly+SameSite=Strict cookie and returns a CSRF token", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    assert.equal(v.res.status, 200);
    assert.equal(v.body.authenticated, true);
    assert.equal(v.body.role, "full");
    assert.ok(typeof v.body.csrf_token === "string" && v.body.csrf_token.length >= 32);

    const sess = v.cookies[COOKIE];
    assert.ok(sess, "session cookie present");
    assert.ok(sess.attrs.httponly, "session cookie is HttpOnly");
    assert.equal(String(sess.attrs.samesite).toLowerCase(), "strict");
    assert.equal(sess.attrs.path, "/");

    // CSRF cookie must be present and readable by JS (NOT HttpOnly).
    const csrf = v.cookies[CSRF_COOKIE];
    assert.ok(csrf, "csrf cookie present");
    assert.ok(!csrf.attrs.httponly, "csrf cookie is NOT HttpOnly (JS-readable)");
    assert.equal(String(csrf.attrs.samesite).toLowerCase(), "strict");
  } finally {
    await app.close();
  }
});

/* --------------------- protected route with/without cookie --------------- */

test("protected route: no cookie -> 401, valid cookie -> 200", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const noCookie = await fetch(`${app.origin}/api/box/status`);
    assert.equal(noCookie.status, 401);

    const v = await verify(app.origin, SECRET);
    const cookie = cookieHeader({ [COOKIE]: v.cookies[COOKIE].value });
    const ok = await fetch(`${app.origin}/api/box/status`, { headers: { cookie } });
    assert.equal(ok.status, 200);
  } finally {
    await app.close();
  }
});

/* --------------------------------- SSE ----------------------------------- */

test("SSE: no cookie -> 401, and a session token in the query string is NOT accepted", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const noCookie = await fetch(`${app.origin}/api/box/stream`);
    assert.equal(noCookie.status, 401);

    const v = await verify(app.origin, SECRET);
    const token = v.cookies[COOKIE].value;

    // Passing the real session token in the query string must NOT authenticate.
    const viaQuery = await fetch(
      `${app.origin}/api/box/stream?x-admin-token=${encodeURIComponent(token)}&token=${encodeURIComponent(token)}`,
    );
    assert.equal(viaQuery.status, 401, "query-string token must be rejected");

    // The same token in the cookie DOES authenticate.
    const viaCookie = await fetch(`${app.origin}/api/box/stream`, {
      headers: { cookie: cookieHeader({ [COOKIE]: token }) },
    });
    assert.equal(viaCookie.status, 200);
    await viaCookie.body?.cancel?.();
  } finally {
    await app.close();
  }
});

/* ------------------------------ CSRF + Origin ---------------------------- */

test("mutating request without CSRF header is refused; foreign Origin is refused", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    const token = v.cookies[COOKIE].value;
    const csrf = v.body.csrf_token;
    const cookie = cookieHeader({ [COOKIE]: token });

    // Correct Origin but NO CSRF header -> 403.
    const noCsrf = await fetch(`${app.origin}/api/box/start`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).code, "csrf_failed");

    // Correct CSRF but FOREIGN Origin -> 403.
    const badOrigin = await fetch(`${app.origin}/api/box/start`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.json()).code, "bad_origin");

    // Correct Origin AND correct CSRF -> 200.
    const good = await fetch(`${app.origin}/api/box/start`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(good.status, 200);
  } finally {
    await app.close();
  }
});

/* ---------------------------------- CORS --------------------------------- */

test("CORS never answers `*` when credentials are allowed", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    // Preflight from the allowed origin.
    const pre = await fetch(`${app.origin}/api/box/status`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "GET" },
    });
    const acao = pre.headers.get("access-control-allow-origin");
    const acac = pre.headers.get("access-control-allow-credentials");
    assert.notEqual(acao, "*", "ACAO must never be * with credentials");
    if (acac === "true") {
      assert.equal(acao, ORIGIN, "with credentials, ACAO must be the exact origin");
    }

    // A foreign origin must not be echoed and must not get credentials.
    const foreign = await fetch(`${app.origin}/api/box/status`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    const facao = foreign.headers.get("access-control-allow-origin");
    assert.ok(facao === null || facao === ORIGIN, "foreign origin is never echoed");
    assert.notEqual(facao, "*");
  } finally {
    await app.close();
  }
});

/* --------------------------------- logout -------------------------------- */

test("logout revokes the row and clears the cookie so the old cookie 401s", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    const token = v.cookies[COOKIE].value;
    const csrf = v.body.csrf_token;
    const cookie = cookieHeader({ [COOKIE]: token, [CSRF_COOKIE]: csrf });

    // Confirm the session works first.
    const before = await fetch(`${app.origin}/api/box/status`, { headers: { cookie } });
    assert.equal(before.status, 200);

    const out = await fetch(`${app.origin}/api/access/logout`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "x-csrf-token": csrf },
    });
    assert.equal(out.status, 200);
    // Cookies cleared (Max-Age=0).
    const cleared = parseSetCookies(out);
    assert.ok(cleared[COOKIE], "logout clears the session cookie");
    assert.equal(cleared[COOKIE].attrs["max-age"], "0");

    // Replaying the old cookie now 401s — the row was revoked.
    const afterLogout = await fetch(`${app.origin}/api/box/status`, { headers: { cookie } });
    assert.equal(afterLogout.status, 401);
  } finally {
    await app.close();
  }
});

/* --------------------------- expiry + sweep ------------------------------ */

test("an expired session is rejected on use and swept from storage", async () => {
  // TTL of 0 hours could round to 0ms; config requires >0, so use the store
  // directly to mint an already-expired row, then assert rejection + sweep.
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const store = app.sessionStore;
    // Mint with a negative TTL so expires_at is in the past.
    const minted = await store.mintSession(
      { siteAccessSecret: SECRET, ttlHours: -1 },
      { ip: "1.2.3.4", userAgent: "test", role: "full" },
    );
    const cookie = cookieHeader({ [COOKIE]: minted.sessionToken });

    // Rejected on use.
    const res = await fetch(`${app.origin}/api/box/status`, { headers: { cookie } });
    assert.equal(res.status, 401);

    // validateSession returns null for the expired row.
    assert.equal(await store.validateSession(minted.sessionToken), null);

    // Sweep removes it.
    const removed = await store.sweepExpiredSessions();
    assert.ok(removed >= 1, "sweep deletes the expired row");
  } finally {
    await app.close();
  }
});

/* ------------------------------ rate limit ------------------------------- */

test("rate limiter allows 10 verify attempts per 5 min per IP and refuses the 11th", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    // A fixed forwarded IP so every attempt shares one bucket.
    const ip = "203.0.113.7";
    const headers = { "content-type": "application/json", "x-forwarded-for": ip };
    let last;
    for (let i = 1; i <= 10; i++) {
      last = await fetch(`${app.origin}/api/access/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({ passcode: "wrong" }),
      });
      assert.notEqual(last.status, 429, `attempt ${i} must not be rate limited`);
    }
    const eleventh = await fetch(`${app.origin}/api/access/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ passcode: "wrong" }),
    });
    assert.equal(eleventh.status, 429, "the 11th attempt is refused");
  } finally {
    await app.close();
  }
});

/* --------------------------- arms nothing -------------------------------- */

test("a successful login does not arm live trading", async () => {
  const liveGate = { calls: [], enable() { this.calls.push("enable"); } };
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET }, liveGate });
  try {
    const v = await verify(app.origin, SECRET);
    assert.equal(v.res.status, 200);
    // The verify path never touches the live-trading gate.
    assert.deepEqual(app.liveGate.calls, [], "live gate must never be enabled by login");
  } finally {
    await app.close();
  }
});

/* --------------------------- error shape --------------------------------- */

test("error responses contain no stack trace and no SQL", async () => {
  const app = await startApp(db.databaseUrl, { env: { SITE_ACCESS_SECRET: SECRET } });
  try {
    const v = await verify(app.origin, SECRET);
    const cookie = cookieHeader({ [COOKIE]: v.cookies[COOKIE].value });
    const res = await fetch(`${app.origin}/api/boom`, { headers: { cookie } });
    assert.equal(res.status, 500);
    const body = await res.json();
    const text = JSON.stringify(body);
    assert.ok(!/\bat\s+Object\./.test(text), "no stack frames");
    assert.ok(!/SELECT|FROM|WHERE|token_hash/i.test(text), "no SQL text");
    assert.equal(body.code, "internal_error");
  } finally {
    await app.close();
  }
});
