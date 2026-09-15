/**
 * IN-APP BROKER LOGIN — the OAuth/consent flows, the callback's proof of initiation,
 * and the token-exposure gate.
 *
 * Proves, against the REAL compiled modules in dist/:
 *   • the Zerodha checksum is exactly sha256(api_key + request_token + api_secret), and
 *     the api SECRET never appears in the login URL or the exchange body;
 *   • both auth clients refuse a 3xx instead of following it, require https by default,
 *     and reject a malformed/absent credential BEFORE touching the network;
 *   • the Dhan consent flow works over real HTTP, in BOTH of Dhan's naming variants,
 *     purely by configuration, with the secret only ever a request header;
 *   • the pending-login store makes a callback single-use, TTL-bounded and
 *     nonce-checked — and that the two brokers' logins never interfere;
 *   • token exposure is off by default, refuses weak keys, and compares the shared
 *     secret without short-circuiting on content;
 *   • the post-login redirect always targets the CONFIGURED frontend origin.
 *
 * HERMETIC BY CONSTRUCTION. Every network call in this file goes to a loopback server
 * started here, via the injectable `fetchImpl`/`endpoints` seams. Nothing reaches a real
 * broker, which is what the CI egress guard requires. Live hostnames are asserted
 * STRUCTURALLY (hostname parts) rather than as literals, because `.github/ci/no-live-hostnames.sh`
 * forbids those literals in tests — and rightly so.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

import {
  buildZerodhaLoginUrl,
  exchangeZerodhaRequestToken,
  parseZerodhaLoginTime,
  readZerodhaCredentials,
  zerodhaAuthEndpointsFromEnv,
  zerodhaChecksum,
  ZerodhaAuthError,
} from "../../dist/brokers/zerodha/auth.js";
import {
  consumeDhanConsent,
  dhanAuthEndpointsFromEnv,
  generateDhanConsent,
  isDhanTokenExpired,
  parseExpiry,
} from "../../dist/brokers/dhan/auth.js";
import {
  DEFAULT_PENDING_LOGIN_TTL_MS,
  mintLoginNonce,
  nonceMatches,
  PendingLoginStore,
} from "../../dist/brokerAuth/pendingLogins.js";
import {
  MIN_TOKEN_EXPOSURE_KEY_LENGTH,
  TOKEN_ACCESS_HEADER,
  tokenAccessKeyMatches,
  tokenExposureConfigFromEnv,
  tokenExposureEnabled,
} from "../../dist/tokenExposureRoutes.js";
import { loginResultRedirect } from "../../dist/brokerAuthRoutes.js";

/* ------------------------------- test scaffolding ------------------------------ */

const ZCREDS = { apiKey: "APIKEY123", apiSecret: "SECRET789", redirectUrl: "" };
const DCREDS = {
  clientId: "1100112233",
  apiKey: "APPID",
  apiSecret: "APPSECRET",
  redirectUrl: "",
  postbackUrl: "",
};

/** A loopback stand-in for both brokers' auth hosts. Records every request it sees. */
async function startAuthHost() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    res.setHeader("content-type", "application/json");
    switch (url.pathname) {
      /* --- Zerodha --- */
      case "/session/token": {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          seen[seen.length - 1].body = body;
          res.end(JSON.stringify({
            status: "success",
            data: {
              access_token: "Z-ACCESS-TOKEN", user_id: "AB1234", user_name: "Test Trader",
              email: "t@example.com", api_key: "APIKEY123", login_time: "2026-09-15 09:20:00",
            },
          }));
        });
        return;
      }

      /* --- Dhan: the "app" variant --- */
      case "/app/generate-consent":
        res.end(JSON.stringify({ consentAppId: "CONSENT-123", consentStatus: "GENERATED" }));
        return;
      case "/app/consumeApp-consent":
        res.end(JSON.stringify({
          dhanClientId: "1100112233", dhanClientName: "Test Trader", dhanClientUcc: "UCC99",
          givenPowerOfAttorney: true, accessToken: "D-ACCESS-TOKEN", expiryTime: 1789500000000,
        }));
        return;

      /* --- Dhan: the "partner" variant, which spells the id differently --- */
      case "/partner/generate-consent":
        res.end(JSON.stringify({ consentId: "PARTNER-CONSENT-9" }));
        return;

      /* --- Dhan failure shapes --- */
      case "/app/unauthorized":
        res.statusCode = 401;
        res.end(JSON.stringify({ errorMessage: "Invalid app credentials" }));
        return;
      case "/app/no-consent-id":
        res.end(JSON.stringify({ someOtherField: true }));
        return;
      default:
        res.statusCode = 404;
        res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  return { server, root, seen };
}

const host = await startAuthHost();
after(() => host.server.close());

/** Loopback endpoints for the Zerodha exchange. `requireHttps:false` is the test opt-out. */
const zEndpoints = (apiRoot = host.root) => ({ loginUrl: `${host.root}/connect/login`, apiRoot });
/** Loopback endpoints for the Dhan consent flow, defaulting to the "app" variant. */
const dEndpoints = (over = {}) =>
  dhanAuthEndpointsFromEnv({
    authRoot: host.root,
    consentLoginUrl: `${host.root}/login/consentApp-login`,
    ...over,
  });

const lastRequestTo = (path) => [...host.seen].reverse().find((r) => r.path === path);

/* ================================ Zerodha ==================================== */

test("the Zerodha login checksum is exactly sha256(api_key + request_token + api_secret)", () => {
  const expected = createHash("sha256").update("APIKEY123reqtok456SECRET789").digest("hex");
  assert.equal(zerodhaChecksum("APIKEY123", "reqtok456", "SECRET789"), expected);
  // A different secret must produce a different checksum — the whole security property.
  assert.notEqual(zerodhaChecksum("APIKEY123", "reqtok456", "OTHER"), expected);
});

test("the Zerodha consent URL carries the api key and the state nonce, and NEVER the secret", () => {
  const url = buildZerodhaLoginUrl(ZCREDS, { state: "NONCE-abc", endpoints: zEndpoints() });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("v"), "3");
  assert.equal(parsed.searchParams.get("api_key"), "APIKEY123");
  // Kite appends `redirect_params` verbatim to the REGISTERED redirect URL, so the
  // nonce must survive as a query string of its own.
  assert.equal(parsed.searchParams.get("redirect_params"), "state=NONCE-abc");
  assert.ok(!url.includes("SECRET789"), "the api secret must never enter the login URL");

  // Without a nonce there is no redirect_params at all (nothing to round-trip).
  assert.ok(!buildZerodhaLoginUrl(ZCREDS, { endpoints: zEndpoints() }).includes("redirect_params"));
});

test("the Zerodha request-token exchange posts the checksum and returns the session", async () => {
  const session = await exchangeZerodhaRequestToken(ZCREDS, "reqtok456", {
    endpoints: zEndpoints(),
    requireHttps: false,
  });
  assert.equal(session.accessToken, "Z-ACCESS-TOKEN");
  assert.equal(session.userId, "AB1234");
  assert.equal(session.userName, "Test Trader");
  assert.equal(session.apiKey, "APIKEY123");
  // "2026-09-15 09:20:00" IST is 03:50:00Z — the fixed +05:30 offset, applied explicitly.
  assert.equal(new Date(session.loginTimeMs).toISOString(), "2026-09-15T03:50:00.000Z");

  const req = lastRequestTo("/session/token");
  assert.equal(req.method, "POST");
  assert.equal(req.headers["x-kite-version"], "3");
  const expected = createHash("sha256").update("APIKEY123reqtok456SECRET789").digest("hex");
  assert.ok(req.body.includes(`checksum=${expected}`), "the checksum must be in the form body");
  assert.ok(req.body.includes("request_token=reqtok456"));
  assert.ok(!req.body.includes("SECRET789"), "the api secret must never be transmitted");
});

test("a Zerodha exchange rejection surfaces the broker's reason, not a generic failure", async () => {
  // A used/expired request token is the common real failure, and the operator needs to
  // read WHY. Driven through the injectable fetch so the exact status/body is pinned.
  await assert.rejects(
    exchangeZerodhaRequestToken(ZCREDS, "stale", {
      endpoints: zEndpoints(),
      requireHttps: false,
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: "error", message: "Token is invalid or has expired." }), {
          status: 403,
        }),
    }),
    (err) =>
      err instanceof ZerodhaAuthError &&
      err.code === "REJECTED" &&
      err.status === 403 &&
      err.message === "Token is invalid or has expired.",
  );
});

test("the Zerodha exchange refuses a redirect instead of replaying the request token", async () => {
  await assert.rejects(
    exchangeZerodhaRequestToken(ZCREDS, "reqtok456", {
      endpoints: zEndpoints(),
      requireHttps: false,
      // Following this would carry the checksum and request token to another host.
      fetchImpl: async () =>
        new Response("", { status: 302, headers: { location: "https://elsewhere.example/steal" } }),
    }),
    (err) => err instanceof ZerodhaAuthError && err.code === "REDIRECT",
  );
});

test("the Zerodha exchange refuses http by default and an empty request token without a network call", async () => {
  await assert.rejects(
    exchangeZerodhaRequestToken(ZCREDS, "reqtok456", { endpoints: zEndpoints() }),
    (err) => err instanceof ZerodhaAuthError && err.code === "CONFIG",
  );

  let called = false;
  await assert.rejects(
    exchangeZerodhaRequestToken(ZCREDS, "   ", {
      endpoints: zEndpoints(),
      requireHttps: false,
      fetchImpl: async () => { called = true; return new Response("{}"); },
    }),
    (err) => err instanceof ZerodhaAuthError && err.code === "MALFORMED",
  );
  assert.equal(called, false, "an empty request token must be refused before any fetch");
});

test("a Zerodha success envelope without an access token is MALFORMED, not a session", async () => {
  await assert.rejects(
    exchangeZerodhaRequestToken(ZCREDS, "reqtok456", {
      endpoints: zEndpoints(),
      requireHttps: false,
      fetchImpl: async () => new Response(JSON.stringify({ status: "success", data: { user_id: "AB1234" } }), { status: 200 }),
    }),
    (err) => err instanceof ZerodhaAuthError && err.code === "MALFORMED",
  );
});

test("Kite's login_time is read as IST wall-clock, and anything unparseable is null", () => {
  assert.equal(new Date(parseZerodhaLoginTime("2026-09-15 09:20:00")).toISOString(), "2026-09-15T03:50:00.000Z");
  assert.equal(new Date(parseZerodhaLoginTime("2026-09-15T09:20:00")).toISOString(), "2026-09-15T03:50:00.000Z");
  assert.equal(parseZerodhaLoginTime("not a time"), null);
  assert.equal(parseZerodhaLoginTime(""), null);
  assert.equal(parseZerodhaLoginTime(undefined), null);
  assert.equal(parseZerodhaLoginTime(12345), null);
});

test("Zerodha credentials are reported missing by NAME rather than throwing", () => {
  const saved = { k: process.env.KITE_API_KEY, s: process.env.KITE_API_SECRET };
  try {
    delete process.env.KITE_API_KEY;
    delete process.env.KITE_API_SECRET;
    const missing = readZerodhaCredentials();
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /KITE_API_KEY/);
    assert.match(missing.reason, /KITE_API_SECRET/);

    process.env.KITE_API_KEY = "k";
    process.env.KITE_API_SECRET = "s";
    const present = readZerodhaCredentials();
    assert.equal(present.ok, true);
    assert.equal(present.creds.apiKey, "k");
  } finally {
    if (saved.k === undefined) delete process.env.KITE_API_KEY; else process.env.KITE_API_KEY = saved.k;
    if (saved.s === undefined) delete process.env.KITE_API_SECRET; else process.env.KITE_API_SECRET = saved.s;
  }
});

test("the default Zerodha endpoints point at Zerodha, and a trailing slash cannot double the path", () => {
  const saved = { l: process.env.KITE_LOGIN_URL, r: process.env.KITE_API_ROOT };
  try {
    delete process.env.KITE_LOGIN_URL;
    delete process.env.KITE_API_ROOT;
    const ep = zerodhaAuthEndpointsFromEnv();
    // Asserted structurally: the literal hostnames are banned in tests/ by
    // .github/ci/no-live-hostnames.sh, so compare the parts instead.
    const login = new URL(ep.loginUrl);
    assert.equal(login.protocol, "https:");
    assert.deepEqual(login.hostname.split("."), ["kite", "zerodha", "com"]);
    const api = new URL(ep.apiRoot);
    assert.equal(api.protocol, "https:");
    assert.deepEqual(api.hostname.split("."), ["api", "kite", "trade"]);

    process.env.KITE_API_ROOT = "https://api.example.com/";
    assert.equal(zerodhaAuthEndpointsFromEnv().apiRoot, "https://api.example.com");
  } finally {
    if (saved.l === undefined) delete process.env.KITE_LOGIN_URL; else process.env.KITE_LOGIN_URL = saved.l;
    if (saved.r === undefined) delete process.env.KITE_API_ROOT; else process.env.KITE_API_ROOT = saved.r;
  }
});

/* ================================== Dhan ===================================== */

test("the Dhan consent flow completes over real HTTP with the secret only ever a header", async () => {
  const consent = await generateDhanConsent(DCREDS, { endpoints: dEndpoints(), requireHttps: false });
  assert.equal(consent.consentAppId, "CONSENT-123");
  assert.equal(new URL(consent.loginUrl).searchParams.get("consentAppId"), "CONSENT-123");

  const gen = lastRequestTo("/app/generate-consent");
  assert.equal(gen.method, "POST");
  assert.equal(gen.query.client_id, "1100112233");
  assert.equal(gen.headers.app_id, "APPID");
  assert.equal(gen.headers.app_secret, "APPSECRET");
  assert.ok(
    !JSON.stringify(gen.query).includes("APPSECRET"),
    "the app secret must never appear in the query string",
  );

  const session = await consumeDhanConsent(DCREDS, "TOKENID-abc", { endpoints: dEndpoints(), requireHttps: false });
  assert.equal(session.accessToken, "D-ACCESS-TOKEN");
  assert.equal(session.dhanClientId, "1100112233");
  assert.equal(session.dhanClientUcc, "UCC99");
  assert.equal(session.givenPowerOfAttorney, true);
  assert.equal(session.expiryTime, 1789500000000);
  assert.equal(lastRequestTo("/app/consumeApp-consent").query.tokenId, "TOKENID-abc");
});

test("Dhan's partner naming variant works purely by configuration", async () => {
  const consent = await generateDhanConsent(DCREDS, {
    endpoints: dEndpoints({
      generatePath: "/partner/generate-consent",
      consentIdParam: "consentId",
      idHeader: "partner_id",
      secretHeader: "partner_secret",
      consentLoginUrl: `${host.root}/consent-login`,
    }),
    requireHttps: false,
  });
  // The OTHER spelling of the consent id is accepted, so a deployment on the partner
  // flow does not see "Dhan returned no consent id" and mistake it for a real failure.
  assert.equal(consent.consentAppId, "PARTNER-CONSENT-9");
  assert.equal(new URL(consent.loginUrl).searchParams.get("consentId"), "PARTNER-CONSENT-9");

  const gen = lastRequestTo("/partner/generate-consent");
  assert.equal(gen.headers.partner_id, "APPID");
  assert.equal(gen.headers.partner_secret, "APPSECRET");
  assert.equal(gen.headers.app_id, undefined, "the app_* headers must not also be sent");
});

test("a Dhan 401 is an auth error, and a consent response with no id names the variant knobs", async () => {
  await assert.rejects(
    generateDhanConsent(DCREDS, {
      endpoints: dEndpoints({ generatePath: "/app/unauthorized" }),
      requireHttps: false,
    }),
    (err) => err.name === "DhanAuthError" && err.status === 401,
  );

  await assert.rejects(
    generateDhanConsent(DCREDS, {
      endpoints: dEndpoints({ generatePath: "/app/no-consent-id" }),
      requireHttps: false,
    }),
    (err) => err.code === "MALFORMED" && /DHAN_CONSENT_GENERATE_PATH/.test(err.message),
  );
});

test("the Dhan consent calls refuse http by default, a 3xx, and an empty tokenId", async () => {
  await assert.rejects(
    generateDhanConsent(DCREDS, { endpoints: dEndpoints() }),
    (err) => err.code === "CONFIG",
  );

  await assert.rejects(
    generateDhanConsent(DCREDS, {
      endpoints: dEndpoints(),
      requireHttps: false,
      fetchImpl: async () => new Response("", { status: 302, headers: { location: "https://elsewhere.example/" } }),
    }),
    (err) => err.code === "REDIRECT",
  );

  let called = false;
  await assert.rejects(
    consumeDhanConsent(DCREDS, "   ", {
      endpoints: dEndpoints(),
      requireHttps: false,
      fetchImpl: async () => { called = true; return new Response("{}"); },
    }),
    (err) => err.code === "MALFORMED",
  );
  assert.equal(called, false, "an empty tokenId must be refused before any fetch");
});

test("a Dhan consent session without an access token is refused", async () => {
  await assert.rejects(
    consumeDhanConsent(DCREDS, "TOKENID-abc", {
      endpoints: dEndpoints(),
      requireHttps: false,
      fetchImpl: async () => new Response(JSON.stringify({ dhanClientId: "X" }), { status: 200 }),
    }),
    (err) => err.code === "MALFORMED",
  );
});

test("the default Dhan consent endpoints are the documented app variant", () => {
  const names = [
    "DHAN_AUTH_ROOT", "DHAN_CONSENT_GENERATE_PATH", "DHAN_CONSENT_CONSUME_PATH",
    "DHAN_CONSENT_LOGIN_URL", "DHAN_CONSENT_ID_PARAM", "DHAN_AUTH_ID_HEADER", "DHAN_AUTH_SECRET_HEADER",
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) delete process.env[n];
    const ep = dhanAuthEndpointsFromEnv();
    // Structural assertion again — the literal host is banned in tests/.
    const root = new URL(ep.authRoot);
    assert.equal(root.protocol, "https:");
    assert.deepEqual(root.hostname.split("."), ["auth", "dhan", "co"]);
    assert.equal(ep.generatePath, "/app/generate-consent");
    assert.equal(ep.consumePath, "/app/consumeApp-consent");
    assert.equal(ep.consentIdParam, "consentAppId");
    assert.equal(ep.idHeader, "app_id");
    assert.equal(ep.secretHeader, "app_secret");
    assert.equal(new URL(ep.consentLoginUrl).pathname, "/login/consentApp-login");
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
});

test("Dhan expiry semantics are unchanged: unknown is NOT expired", () => {
  assert.equal(parseExpiry(1789500000), 1789500000000, "epoch seconds are scaled to ms");
  assert.equal(parseExpiry(1789500000000), 1789500000000, "epoch ms are kept");
  assert.equal(parseExpiry("nonsense"), null);
  assert.equal(isDhanTokenExpired(null), false, "an UNKNOWN expiry must never read as expired");
  assert.equal(isDhanTokenExpired(1), true);
  assert.equal(isDhanTokenExpired(Date.now() + 60_000), false);
});

/* ========================= the callback's proof of initiation ================= */

test("a login nonce is a 256-bit url-safe value, compared without short-circuiting", () => {
  const a = mintLoginNonce();
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(a, "base64url").length, 32);
  assert.notEqual(a, mintLoginNonce());

  assert.equal(nonceMatches("abc", "abc"), true);
  assert.equal(nonceMatches("abc", "abd"), false);
  assert.equal(nonceMatches("ab", "abc"), false, "a length mismatch is a mismatch, not a throw");
  assert.equal(nonceMatches("", ""), false, "an empty expected nonce can never match");
});

test("an UNSOLICITED callback is refused for both brokers", () => {
  const store = new PendingLoginStore();
  assert.deepEqual(store.consume("zerodha", "anything", { requireNonce: true }), {
    ok: false, reason: "no_pending_login",
  });
  assert.deepEqual(store.consume("dhan", null, { requireNonce: false }), {
    ok: false, reason: "no_pending_login",
  });
});

test("a claimed login is SINGLE-USE, so a replayed callback does nothing", () => {
  const store = new PendingLoginStore();
  const entry = store.start("zerodha", { startedBy: "full" });
  assert.equal(store.consume("zerodha", entry.nonce, { requireNonce: true }).ok, true);
  assert.deepEqual(store.consume("zerodha", entry.nonce, { requireNonce: true }), {
    ok: false, reason: "no_pending_login",
  });
});

test("a failed nonce check still consumes the initiation, so it cannot be retried", () => {
  const store = new PendingLoginStore();
  const entry = store.start("zerodha", { startedBy: "full" });
  const wrong = "x".repeat(entry.nonce.length);
  assert.deepEqual(store.consume("zerodha", wrong, { requireNonce: true }), {
    ok: false, reason: "state_mismatch",
  });
  assert.deepEqual(store.consume("zerodha", entry.nonce, { requireNonce: true }), {
    ok: false, reason: "no_pending_login",
  });
});

test("omitting `state` cannot downgrade the nonce requirement", () => {
  const store = new PendingLoginStore();
  store.start("zerodha", { startedBy: "full" });
  // `requireNonce` is decided by the ROUTE from the broker, never by what the caller
  // happened to send — otherwise dropping `state` would bypass the check entirely.
  assert.deepEqual(store.consume("zerodha", null, { requireNonce: true }), {
    ok: false, reason: "state_missing",
  });
});

test("a lapsed login is refused even when the nonce is correct", () => {
  let now = 1_000_000;
  const store = new PendingLoginStore({ ttlMs: 600_000, now: () => now });
  const entry = store.start("zerodha", { startedBy: "full" });
  now += 600_001;
  // Reported as EXPIRED specifically, so the operator is told the attempt lapsed rather
  // than that it never happened. Consumed here WITHOUT a prior isPending() read, because
  // that read sweeps the entry (see the next test).
  assert.deepEqual(store.consume("zerodha", entry.nonce, { requireNonce: true }), {
    ok: false, reason: "login_expired",
  });
  assert.equal(DEFAULT_PENDING_LOGIN_TTL_MS, 600_000);
});

test("isPending() sweeps a lapsed entry, so nothing can claim it afterwards", () => {
  let now = 1_000_000;
  const store = new PendingLoginStore({ ttlMs: 600_000, now: () => now });
  const entry = store.start("dhan", { startedBy: "full" });
  assert.equal(store.isPending("dhan"), true);
  now += 600_001;
  assert.equal(store.isPending("dhan"), false, "a lapsed login must not read as in flight");
  // The sweep already removed it, so the claim finds nothing at all. Either way it is a
  // refusal — the point is that a lapsed entry is never claimable.
  assert.deepEqual(store.consume("dhan", entry.nonce, { requireNonce: false }), {
    ok: false, reason: "no_pending_login",
  });
});

test("starting a second login for a broker supersedes the first", () => {
  const store = new PendingLoginStore();
  const first = store.start("zerodha", { startedBy: "full" });
  const second = store.start("zerodha", { startedBy: "full" });
  assert.notEqual(first.nonce, second.nonce);
  // The stale nonce is refused; the current one works.
  assert.equal(store.consume("zerodha", first.nonce, { requireNonce: true }).ok, false);
  const store2 = new PendingLoginStore();
  store2.start("zerodha", { startedBy: "full" });
  const latest = store2.start("zerodha", { startedBy: "full" });
  assert.equal(store2.consume("zerodha", latest.nonce, { requireNonce: true }).ok, true);
});

test("THE ISOLATION PROPERTY: the two brokers' logins never interfere", () => {
  const store = new PendingLoginStore();
  const z = store.start("zerodha", { startedBy: "full" });
  const d = store.start("dhan", { startedBy: "full", consentId: "CONSENT-1" });

  // Both in flight simultaneously — the whole point of dual-broker login.
  assert.equal(store.isPending("zerodha"), true);
  assert.equal(store.isPending("dhan"), true);

  // Completing Dhan leaves Zerodha untouched and still claimable.
  const claimedDhan = store.consume("dhan", null, { requireNonce: false });
  assert.equal(claimedDhan.ok, true);
  assert.equal(claimedDhan.pending.consentId, "CONSENT-1");
  assert.equal(store.isPending("zerodha"), true);
  assert.equal(store.consume("zerodha", z.nonce, { requireNonce: true }).ok, true);

  // And clearing one broker never clears the other.
  const store2 = new PendingLoginStore();
  store2.start("zerodha", { startedBy: "full" });
  const dhan2 = store2.start("dhan", { startedBy: "full" });
  store2.clear("zerodha");
  assert.equal(store2.isPending("zerodha"), false);
  assert.equal(store2.isPending("dhan"), true);
  assert.equal(store2.consume("dhan", null, { requireNonce: false }).ok, true);
  assert.ok(dhan2.nonce.length > 0);
});

/* ============================== token exposure =============================== */

test("token exposure is OFF unless a sufficiently long key is configured", () => {
  assert.equal(MIN_TOKEN_EXPOSURE_KEY_LENGTH, 32);
  assert.equal(TOKEN_ACCESS_HEADER, "x-token-access-key");
  assert.equal(tokenExposureEnabled({ accessKey: "" }), false, "unset must fail closed");
  assert.equal(tokenExposureEnabled({ accessKey: "letmein" }), false);
  assert.equal(tokenExposureEnabled({ accessKey: "x".repeat(31) }), false, "a weak key is refused, not honoured");
  assert.equal(tokenExposureEnabled({ accessKey: "x".repeat(32) }), true);
});

test("the token access key is compared in full, never by prefix", () => {
  const key = "K".repeat(40);
  assert.equal(tokenAccessKeyMatches(key, key), true);
  assert.equal(tokenAccessKeyMatches(`${"K".repeat(39)}X`, key), false);
  assert.equal(tokenAccessKeyMatches("K".repeat(39), key), false, "a correct prefix must not pass");
  assert.equal(tokenAccessKeyMatches("K".repeat(41), key), false);
  assert.equal(tokenAccessKeyMatches("", key), false);
  assert.equal(tokenAccessKeyMatches("", ""), false, "an unset key must never match anything");
});

test("the token exposure key is read from the environment and trimmed", () => {
  assert.deepEqual(tokenExposureConfigFromEnv({}), { accessKey: "" });
  assert.deepEqual(tokenExposureConfigFromEnv({ TOKEN_EXPOSURE_KEY: "   " }), { accessKey: "" });
  assert.deepEqual(tokenExposureConfigFromEnv({ TOKEN_EXPOSURE_KEY: "  abc  " }), { accessKey: "abc" });
});

/* ============================ the post-login redirect ======================== */

test("the post-login redirect always targets the CONFIGURED frontend origin", () => {
  const ok = new URL(loginResultRedirect("https://app.example.com", "zerodha", { ok: true }));
  assert.equal(ok.origin, "https://app.example.com");
  assert.equal(ok.pathname, "/box", "the callback must land on an EXISTING frontend route");
  assert.equal(ok.searchParams.get("broker_login"), "zerodha");
  assert.equal(ok.searchParams.get("status"), "connected");
  assert.equal(ok.searchParams.get("reason"), null, "a success carries no reason");

  const failed = new URL(
    loginResultRedirect("https://app.example.com", "dhan", { ok: false, reason: "state_mismatch" }),
  );
  assert.equal(failed.searchParams.get("broker_login"), "dhan");
  assert.equal(failed.searchParams.get("status"), "failed");
  assert.equal(failed.searchParams.get("reason"), "state_mismatch");

  // A configured origin with a trailing slash must not produce "//box".
  assert.equal(new URL(loginResultRedirect("https://app.example.com/", "dhan", { ok: true })).pathname, "/box");
});
