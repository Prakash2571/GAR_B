/**
 * REST SESSION DEATH MUST ESCALATE THE SAME WAY WEBSOCKET SESSION DEATH DOES.
 *
 * THE DEFECT. Every authenticated read in `KiteClient` ended with a bare
 * `if (status === 401 || status === 403) this.clearSession()`, which clears IN-PROCESS state and
 * nothing else. The WebSocket death path in `index.ts` does FOUR things for the same event:
 *
 *   1. clears the in-memory token
 *   2. forgets the session METADATA on the broker manager
 *   3. invalidates the ENCRYPTED ROW in `broker_sessions`
 *   4. tells the engine to drop its cached books
 *
 * The REST path did one of the four. So a token killed mid-session — the operator signs in to
 * kite.zerodha.com or the Kite mobile app, and Kite permits only ONE active access_token per api_key
 * — left a stored row still carrying TODAY's `login_date` and the matching api key. Any restart
 * (deploy, OOM kill, systemd) re-adopted that corpse, and `adoptStoredKiteSession` validated only
 * "same IST day" and "same api key" — neither of which is a liveness check. The status surface then
 * reported `authenticated: true`, `data_ready: true` and `trading_ready: true`, the Box engine armed,
 * and every leg POST 403'd. On a four-leg box that is a partially filled spread which can neither be
 * completed nor cancelled, with the dashboard claiming health throughout.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { KiteClient, KiteError } from "../../dist/kite.js";

/** A KiteClient whose fetch is replaced, with the auth-failure escalations recorded. */
function client({ status = 403, body = { status: "error", message: "Invalid `api_key` or `access_token`." } } = {}) {
  const escalations = [];
  const k = new KiteClient({ apiKey: "ak" });
  k.installProvidedToken("ak", "dead-token", "AB1234");
  k.setAuthFailureHandler((info) => escalations.push(info));

  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  return { k, escalations, restore: () => { globalThis.fetch = saved; } };
}

test("a 403 on an authenticated REST read clears the token AND escalates", async () => {
  const { k, escalations, restore } = client({ status: 403 });
  try {
    assert.equal(k.getAccessToken(), "dead-token", "fixture: a session is installed");
    await assert.rejects(() => k.getProfile());

    assert.equal(k.getAccessToken(), null, "the in-memory token is dropped");
    assert.equal(k.getSessionAccount(), null, "and the account goes with it");
    assert.equal(
      escalations.length, 1,
      "the handler MUST fire — without it the encrypted broker_sessions row keeps today's " +
        "login_date and a restart re-adopts a dead token reporting trading_ready",
    );
    assert.equal(escalations[0].status, 403);
    assert.equal(escalations[0].endpoint, "/user/profile", "the endpoint is named for diagnosis");
  } finally {
    restore();
  }
});

test("a 401 escalates identically to a 403", async () => {
  const { k, escalations, restore } = client({ status: 401 });
  try {
    await assert.rejects(() => k.getProfile());
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].status, 401);
  } finally {
    restore();
  }
});

test("a NON-auth failure neither clears the session nor escalates", async () => {
  /*
   * The distinction that keeps this fix from becoming a new bug. A 500, a timeout or a DNS failure
   * proves NOTHING about the credential. Treating one as session death would invalidate a perfectly
   * good stored session over a transient broker outage and force a manual sign-in — and would do it
   * at the worst moment, since a boot with unresolved overnight exposure is exactly when the session
   * is needed to reconcile.
   */
  for (const status of [500, 502, 503, 429]) {
    const { k, escalations, restore } = client({ status, body: { status: "error", message: "upstream" } });
    try {
      await assert.rejects(() => k.getProfile());
      assert.equal(k.getAccessToken(), "dead-token", `HTTP ${status} must keep the session`);
      assert.deepEqual(escalations, [], `HTTP ${status} must not escalate`);
    } finally {
      restore();
    }
  }
});

test("escalation is skipped when there was no session to lose", async () => {
  /*
   * `authHeader()` throws a 401 KiteError of its own when no token is installed. That is not session
   * death, and escalating it would invalidate a stored row that a CONCURRENT login may be in the
   * middle of writing.
   */
  const escalations = [];
  const k = new KiteClient({ apiKey: "ak" });
  k.setAuthFailureHandler((info) => escalations.push(info));

  await assert.rejects(() => k.getProfile(), (err) => {
    assert.ok(err instanceof KiteError);
    assert.equal(err.status, 401, "no token installed is reported locally as a 401");
    return true;
  });
  assert.deepEqual(escalations, [], "nothing was lost, so nothing is invalidated");
});

test("a throwing escalation handler cannot replace the broker error the caller sees", async () => {
  // The handler runs inside a REST error path that is already handling a broker failure. A
  // durable-store fault while invalidating a session must not mask it.
  const saved = globalThis.fetch;
  const k = new KiteClient({ apiKey: "ak" });
  k.installProvidedToken("ak", "dead-token", "AB1234");
  k.setAuthFailureHandler(() => { throw new Error("postgres is down"); });
  globalThis.fetch = async () => ({
    status: 403,
    ok: false,
    headers: new Map(),
    json: async () => ({ status: "error", message: "Invalid `api_key` or `access_token`." }),
    text: async () => "",
  });
  try {
    await assert.rejects(() => k.getProfile(), (err) => {
      assert.ok(err instanceof KiteError, "the BROKER error surfaces, not the handler's");
      assert.equal(err.status, 403);
      assert.doesNotMatch(String(err.message), /postgres/i);
      return true;
    });
    assert.equal(k.getAccessToken(), null, "and the token is still cleared — that part cannot fail");
  } finally {
    globalThis.fetch = saved;
  }
});

test("every authenticated endpoint escalates, not just the profile", async () => {
  /*
   * There were TEN 401/403 sites and the fix had to reach all of them, so this walks the real methods
   * rather than trusting that one representative call proves the rest. A site left on a bare
   * clearSession() is invisible until a restart re-adopts a dead token.
   */
  const calls = [
    ["/user/profile", (k) => k.getProfile()],
    ["/user/margins/equity", (k) => k.getFunds()],
    ["/quote/ohlc", (k) => k.getQuoteOhlc(["NSE:INFY"])],
    ["/quote", (k) => k.getQuoteFull(["NSE:INFY"])],
    ["/margins/basket", (k) => k.getBasketMargin([])],
    // A non-empty order list is required: `getOrderCharges([])` correctly short-circuits to `[]`
    // before any HTTP call, so an empty array would exercise nothing.
    ["/charges/orders", (k) => k.getOrderCharges([{
      order_id: "x",
      exchange: "NFO",
      tradingsymbol: "NIFTY26SEP24500CE",
      transaction_type: "BUY",
      variety: "regular",
      product: "NRML",
      order_type: "LIMIT",
      quantity: 75,
      average_price: 100,
    }])],
  ];
  for (const [endpoint, call] of calls) {
    const { k, escalations, restore } = client({ status: 403 });
    try {
      await call(k).catch(() => {});
      assert.equal(
        escalations.length, 1,
        `${endpoint} must escalate a 403 — got ${escalations.length} escalation(s)`,
      );
      assert.equal(escalations[0].endpoint, endpoint);
    } finally {
      restore();
    }
  }
});
