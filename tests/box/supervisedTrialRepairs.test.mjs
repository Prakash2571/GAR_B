/**
 * SUPERVISED-TRIAL REPAIRS — regressions for the six code defects found reviewing 7653e26.
 *
 * Every assertion describes DESIRED behaviour and FAILS on 7653e26.
 *
 *   R1 — WHOLE-ATTEMPT RESERVATION DOUBLE COUNT. A valid 4 x 75 = 300 box was REFUSED against a
 *   gross cap of 300, because each leg's envelope check added the full four-leg claim ON TOP OF the
 *   sibling legs already reserved by `submit()`. The attempt rejected itself with its own
 *   reservation. At cap 400 it was worse: two legs were admitted and leg 3 refused, so a hedge could
 *   POST and FILL and then need unwinding — the exact outcome the envelope exists to prevent.
 *
 *   R2 — CANCELLATION REPORTED SUCCESS WITHOUT CANCELLING. A durable OPEN intent absent from the
 *   adapter's session map produced `{ok:true, eligible:1, cancelled:[], failures:[]}` with zero
 *   broker calls: the panic button said it worked while exposure stayed live.
 *
 *   R3 — STREAM WAITER DEAFENED BY A PARTIAL. A partial fill during a pending REST read won the race,
 *   was found nonterminal, and the listener was torn down — so a later COMPLETE had nothing to wake.
 *
 *   R4 — LENIENT SAFETY-LIMIT PARSING. "one", "-1" and "0.2" all became 0, which means UNLIMITED.
 *
 *   R6 — SESSION STATE CONTRADICTED ENTRY PERMISSION. ARMED and session_attempt_budget_exhausted in
 *   the same payload.
 *
 * (R5, the trusted client IP, is an HTTP-level concern and lives in tests/access/trustedClientIp.test.mjs.)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { deriveSessionState } from "../../dist/box/tradingSession.js";
import { trustedClientIp, isTrustedProxyAddress } from "../../dist/clientIp.js";

/* ══════════════════════════════ R1 — whole-attempt envelope ══════════════════════════════ */

const { BoxOrderManager } = await import("../../dist/box/orderManager.js");

const LIMITS = (o = {}) => ({
  maxOpenLegQuantity: 1_000,
  maxGrossOpenLegQuantity: 400,
  maxOpenBoxes: 1,
  maxResidualLegs: 4,
  maxConcurrentExecutions: 4,
  entrySubmitConcurrency: 1,
  dailyLossLimit: 0,
  rejectLimit: 100,
  consecutiveFailureLimit: 100,
  reconcileIntervalMs: 60_000,
  feedReconnectWarmupMs: 0,
  ...o,
});

/**
 * A REAL manager over mocked broker boundaries, reconciled so entry is genuinely permitted.
 *
 * The point of R1 is composed behaviour — four `submit()` calls for one attempt — so the reservations
 * are created the way production creates them rather than by a test-only hook.
 */
function makeStack({ gross = 400, perLeg = 1_000, concurrency = 1 } = {}) {
  let now = 10_000;
  const posted = [];
  const orders = new Map();
  const adapter = {
    mode: "live",
    broker: "zerodha",
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 1_000 }),
    prepareOrder: (req) => ({ ...req, tag: req.tag ?? `TAG${req.role}` }),
    submitOrder: async (req, beforePost) => {
      beforePost?.();
      posted.push(req.client_order_id);
      const order = {
        ...req, broker_order_id: `B-${req.client_order_id}`, state: "COMPLETE",
        filled_quantity: req.quantity, pending_quantity: 0,
        average_price: req.pricing.limit_price, fills: [],
        limit_price: req.pricing.limit_price,
        reject_family: null, reject_reason: null, created_at: 1_000, updated_at: 2_000,
      };
      orders.set(req.client_order_id, order);
      return order;
    },
    cancelOrder: async () => undefined,
    getOrder: async (id) => orders.get(id),
    listOrders: async () => [...orders.values()],
    listPositions: async () => [],
  };
  const rows = new Map();
  const persistence = {
    rows,
    create: async (i) => { rows.set(i.client_order_id, { ...i }); return { ...i }; },
    findByClientId: async (id) => rows.get(id) ?? null,
    loadNonterminal: async () => [],
    update: async (id, patch) => {
      const cur = rows.get(id) ?? {};
      const next = { ...cur, ...patch };
      rows.set(id, next);
      return { applied: true, intent: next };
    },
  };
  const manager = new BoxOrderManager({
    adapter,
    persistence,
    limits: LIMITS({ maxGrossOpenLegQuantity: gross, maxOpenLegQuantity: perLeg, entrySubmitConcurrency: concurrency }),
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => now++ },
    istDayKey: () => "2026-09-16",
    brokerAccount: () => "ZD1234",
  });
  manager.seedLimits({ tradingDay: "2026-09-16" });
  manager.setFeedHealthy(true);
  return { manager, adapter, posted, persistence };
}

const ROLES = ["k1_ce", "k1_pe", "k2_ce", "k2_pe"];
const legRequest = (role, i, attempt = "A1", quantity = 75) => ({
  client_order_id: `BOX:${attempt}:${role}`,
  trade_id: "T1", attempt_id: attempt, role, purpose: "ENTRY", phase: "entry",
  exchange: "NFO", tradingsymbol: `SYM-${role}`, token: 1000 + i,
  side: i < 2 ? "BUY" : "SELL", quantity,
  pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
});

test("R1-1 (composed): all four legs of a 4 x 75 attempt are admitted against an EXACT 300 cap", async () => {
  const stack = makeStack({ gross: 300 });
  await stack.manager.reconcile();
  const results = await Promise.allSettled(
    ROLES.map((role, i) => stack.manager.submit(legRequest(role, i))),
  );
  const rejected = results.filter((r) => r.status === "rejected").map((r) => r.reason?.message ?? "");
  assert.deepEqual(rejected, [], `no leg may be refused; got: ${rejected.join(" | ")}`);
  assert.equal(stack.posted.length, 4, "all four legs must reach the broker");
});

test("R1-2 (composed): cap 400 admits the attempt without stranding a filled hedge", async () => {
  // The reported variant: two legs admitted, leg 3 refused at 450 -> a filled hedge needing unwind.
  const stack = makeStack({ gross: 400 });
  await stack.manager.reconcile();
  const results = await Promise.allSettled(
    ROLES.map((role, i) => stack.manager.submit(legRequest(role, i))),
  );
  const rejected = results.filter((r) => r.status === "rejected").map((r) => r.reason?.message ?? "");
  assert.deepEqual(rejected, [], `got: ${rejected.join(" | ")}`);
  assert.equal(stack.posted.length, 4);
});

test("R1-3: a genuinely oversized attempt is STILL refused before any POST", async () => {
  const stack = makeStack({ gross: 200 });
  await stack.manager.reconcile();
  const results = await Promise.allSettled(
    ROLES.map((role, i) => stack.manager.submit(legRequest(role, i))),
  );
  assert.ok(results.some((r) => r.status === "rejected"), "4 x 75 cannot fit 200");
  assert.equal(stack.posted.length, 0, "nothing may reach the broker when the cap cannot be satisfied");
  const reason = results.find((r) => r.status === "rejected")?.reason?.message ?? "";
  assert.match(reason, /BEFORE the first leg posts/);
});

test("R1-4: a per-leg lot above the per-leg cap is refused with the per-leg reason", () => {
  const stack = makeStack({ perLeg: 50, gross: 4_000 });
  const reason = stack.manager.entryQuantityEnvelopeBlockReason(75, "A1");
  assert.match(reason ?? "", /exceeds the per-leg limit/);
  assert.match(reason ?? "", /do not raise it globally/);
});

test("R1-5: another attempt's reservations and existing exposure are still counted in FULL", () => {
  const stack = makeStack({ gross: 300 });
  stack.manager.setAttributedBoxPositions(
    [{ exchange: "NFO", tradingsymbol: "HELD", net_quantity: 75 }],
    { account: "ZD1234" },
  );
  const reason = stack.manager.entryQuantityEnvelopeBlockReason(75, "A1");
  assert.ok(reason !== null, "a pre-existing 75-unit position must still consume the envelope");
  assert.match(reason, /already committed: 75/);
});

test("R1-6: entry concurrency 1 through 4 all admit the same valid attempt", async () => {
  for (const concurrency of [1, 2, 3, 4]) {
    const stack = makeStack({ gross: 300, concurrency });
    await stack.manager.reconcile();
    const results = await Promise.allSettled(
      ROLES.map((role, i) => stack.manager.submit(legRequest(role, i))),
    );
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(rejected.length, 0, `concurrency ${concurrency} refused a valid attempt`);
    assert.equal(stack.posted.length, 4, `concurrency ${concurrency} did not post all four legs`);
  }
});

/* ══════════════════════════════ R6 — session state truthfulness ══════════════════════════════ */

const armedRecord = (o = {}) => ({
  armed_at: new Date(1_000),
  disarmed_at: null,
  max_completed_trades: 0,
  max_entry_attempts: 0,
  entry_attempts: 0,
  aborted_attempts: 0,
  established_trade_ids: [],
  completed_trade_ids: [],
  ...o,
});

const idleActivity = (o = {}) => ({
  recoveryActive: false,
  exitInProgress: false,
  openBoxes: 0,
  entryInProgress: false,
  entryBlockedExternally: false,
  ...o,
});

test("R6-1: an exhausted ATTEMPT budget reports BLOCKED, not ARMED", () => {
  const record = armedRecord({ max_entry_attempts: 1, entry_attempts: 1 });
  assert.equal(
    deriveSessionState(record, idleActivity()),
    "BLOCKED",
    "the engine refuses entry, so the state must not claim the session is ready to trade",
  );
});

test("R6-2: an attempt-exhausted session that established NOTHING is not COMPLETED", () => {
  // COMPLETED must stay keyed on the cycle budget: a session that never traded has completed nothing.
  const record = armedRecord({ max_entry_attempts: 1, entry_attempts: 1 });
  assert.notEqual(deriveSessionState(record, idleActivity()), "COMPLETED");
});

test("R6-3: truthful ACTIVITY states still outrank BLOCKED", () => {
  const record = armedRecord({ max_entry_attempts: 1, entry_attempts: 1 });
  assert.equal(deriveSessionState(record, idleActivity({ openBoxes: 1 })), "POSITION_OPEN");
  assert.equal(deriveSessionState(record, idleActivity({ exitInProgress: true })), "EXIT_IN_PROGRESS");
  assert.equal(deriveSessionState(record, idleActivity({ recoveryActive: true })), "RECOVERY");
  assert.equal(
    deriveSessionState(record, idleActivity({ entryInProgress: true })),
    "ENTRY_IN_PROGRESS",
    "the attempt that spent the budget must still be visible while it runs",
  );
});

test("R6-4: attempt and cycle budgets are consumed INDEPENDENTLY", () => {
  // An unlimited attempt budget with a spent cycle budget is COMPLETED...
  const cyclesSpent = armedRecord({ max_completed_trades: 1, established_trade_ids: ["T1"], completed_trade_ids: ["T1"] });
  assert.equal(deriveSessionState(cyclesSpent, idleActivity()), "COMPLETED");
  // ...and an unlimited cycle budget with attempts remaining is ARMED.
  const fresh = armedRecord({ max_entry_attempts: 2, entry_attempts: 1 });
  assert.equal(deriveSessionState(fresh, idleActivity()), "ARMED");
});

test("R6-5: an unlimited attempt budget (0) never blocks", () => {
  const record = armedRecord({ max_entry_attempts: 0, entry_attempts: 99 });
  assert.equal(deriveSessionState(record, idleActivity()), "ARMED");
});

/* ══════════════════════════════ R5 — trusted client IP (unit level) ══════════════════════════════ */

const reqFrom = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test("R5-1: a DIRECT caller cannot influence its own key with forwarding headers", () => {
  // The socket is public, so nginx is not in front of this request and every header is attacker data.
  const a = trustedClientIp(reqFrom("203.0.113.9", { "x-forwarded-for": "1.2.3.4" }));
  const b = trustedClientIp(reqFrom("203.0.113.9", { "x-forwarded-for": "5.6.7.8" }));
  assert.equal(a, "203.0.113.9");
  assert.equal(a, b, "rotating the header must NOT produce a different rate-limit bucket");
});

test("R5-2: behind a trusted proxy, the RIGHTMOST forwarded hop is used (nginx APPENDS)", () => {
  // nginx sets $proxy_add_x_forwarded_for, i.e. <client value>, <real peer>. Position 0 is forged.
  const ip = trustedClientIp(reqFrom("127.0.0.1", { "x-forwarded-for": "1.2.3.4, 198.51.100.7" }));
  assert.equal(ip, "198.51.100.7", "the hop nginx appended is the only trustworthy element");
});

test("R5-3: X-Real-IP wins behind a trusted proxy, because nginx REPLACES it", () => {
  const ip = trustedClientIp(reqFrom("127.0.0.1", {
    "x-real-ip": "198.51.100.7",
    "x-forwarded-for": "1.2.3.4",
  }));
  assert.equal(ip, "198.51.100.7");
});

test("R5-4: a DUPLICATED header is normalised instead of throwing", () => {
  // Node yields an ARRAY for a repeated header. `.split` on an array threw a TypeError BEFORE the
  // limiter incremented its counter — a bypass needing no forged value at all.
  assert.doesNotThrow(() => trustedClientIp(reqFrom("127.0.0.1", { "x-forwarded-for": ["1.2.3.4", "198.51.100.7"] })));
  assert.equal(
    trustedClientIp(reqFrom("127.0.0.1", { "x-forwarded-for": ["1.2.3.4", "198.51.100.7"] })),
    "198.51.100.7",
  );
});

test("R5-5: legitimately distinct clients still get distinct keys", () => {
  const one = trustedClientIp(reqFrom("127.0.0.1", { "x-real-ip": "198.51.100.7" }));
  const two = trustedClientIp(reqFrom("127.0.0.1", { "x-real-ip": "198.51.100.8" }));
  assert.notEqual(one, two, "the limiter must still separate real clients");
});

test("R5-6: only LOOPBACK is trusted by default — a private peer is not", () => {
  assert.equal(isTrustedProxyAddress("::ffff:127.0.0.1"), true);
  assert.equal(isTrustedProxyAddress("127.0.0.1"), true);
  // This originally asserted `true`, which encoded the behaviour rather than the requirement.
  // Trusting every RFC1918 source unconditionally, on a process that binds every interface, is what
  // let any in-VPC host forge its own rate-limit key on the passcode endpoint.
  assert.equal(isTrustedProxyAddress("10.0.0.5"), false, "a private peer is NOT a proxy by default");
  assert.equal(isTrustedProxyAddress("203.0.113.9"), false, "a public peer is never a trusted proxy");
  assert.equal(isTrustedProxyAddress(undefined), false);
});

test("R5-7: a missing socket address degrades to 'unknown' rather than throwing", () => {
  assert.equal(trustedClientIp({ socket: {}, headers: {} }), "unknown");
});
