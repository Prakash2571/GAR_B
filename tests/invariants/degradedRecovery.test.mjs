/**
 * DEGRADED RECOVERY — the admission test for REST depth, and the policy around it.
 *
 * THE DEFECT
 *
 * Every recovery path priced off `BoxQuoteStore`, which is WS-only by construction, and every one was
 * gated on one global raw-tick recency test. One quiet socket blocked every exit for every position:
 * automatic exit, manual close, emergency flatten (which reuses manual close) and residual flatten. And
 * because the monitor returned BEFORE its liquidity gate, the outage was SILENT — no
 * EXIT_SKIPPED_LIQUIDITY event, no exit_blocked_reason. The position simply went quiet, while the
 * EXPIRY_SAFETY alarm above demanded an exit that was blocked four lines later.
 *
 * WHAT THESE TESTS ENFORCE
 *
 * The admission test must be STRICTER than the WS path, not looser. Specifically it must refuse:
 *   - a book that is not REST-sourced (so the degraded path cannot silently re-read the unhealthy store)
 *   - a book from another broker or a provably different account
 *   - a book for a different instrument (token AND tradingsymbol, since tokens are recycled)
 *   - an observation with no usable time, a future-dated one, or one older than a TIGHT limit
 *   - a side with no real price or no real size — the last traded price is never a substitute
 *   - depth that does not cover the quantity WITHIN the bounded limit
 *   - an unbounded or non-positive limit price
 *
 * And the policy must never claim flatness, must keep entry out of scope, and must name the broker
 * terminal whenever this process cannot price the reduction.
 */

import test from "node:test";
import assert from "node:assert/strict";

const {
  admitRecoveryDepth,
  degradedRecoveryVerdict,
  degradedRecoveryStatus,
} = await import("../../dist/box/degradedRecovery.js");

const NOW = 1_000_000;

const observation = (overrides = {}) => ({
  source: "rest",
  broker: "zerodha",
  account: "AB1234",
  token: 1001,
  tradingsymbol: "NIFTY26SEP25000CE",
  observed_at: NOW - 500,
  bids: [{ price: 100, qty: 150 }, { price: 99.9, qty: 300 }],
  asks: [{ price: 100.1, qty: 150 }, { price: 100.2, qty: 300 }],
  ...overrides,
});

const admit = (overrides = {}) =>
  admitRecoveryDepth({
    observation: observation(),
    token: 1001,
    tradingsymbol: "NIFTY26SEP25000CE",
    activeBroker: "zerodha",
    dispatchAccount: "AB1234",
    side: "SELL",
    quantity: 75,
    limitPrice: 99.95,
    now: NOW,
    maxObservationAgeMs: 2_000,
    ...overrides,
  });

/* ══════════════════════ the happy path, so refusals mean something ══════════════════════ */

test("a fresh, identity-matched REST book with enough depth inside the limit is admitted", () => {
  const v = admit();
  assert.equal(v.admitted, true, `must be admitted: ${v.detail}`);
  assert.equal(v.refusal, null);
  assert.equal(v.reference_price, 100, "a reducing SELL takes the BID touch");
  assert.equal(v.executable_quantity, 150, "only the level at/above the limit counts");
  assert.equal(v.observation_age_ms, 500);
});

test("a reducing BUY reads the ASK side, not the bid", () => {
  const v = admit({ side: "BUY", limitPrice: 100.15 });
  assert.equal(v.admitted, true, `must be admitted: ${v.detail}`);
  assert.equal(
    v.reference_price, 100.1,
    "a reducing BUY consumes asks; reading the bid would price against the spread and look executable " +
      "when it is not",
  );
  assert.equal(v.executable_quantity, 150);
});

/* ══════════════════════ source, broker, account, instrument ══════════════════════ */

test("a non-REST observation is refused", () => {
  const v = admit({ observation: observation({ source: "ws" }) });
  assert.equal(v.admitted, false);
  assert.equal(v.refusal, "wrong_source");
  assert.match(
    v.detail, /must not silently consume the WebSocket store/,
    "the degraded path must not re-read the very store whose freshness clock is unhealthy",
  );
});

test("a book from another broker is refused", () => {
  const v = admit({ observation: observation({ broker: "dhan" }) });
  assert.equal(v.admitted, false);
  assert.equal(v.refusal, "wrong_broker");
});

test("a book fetched under a provably different account is refused", () => {
  const v = admit({ observation: observation({ account: "ZZ9999" }) });
  assert.equal(v.admitted, false);
  assert.equal(v.refusal, "wrong_account");
});

test("an UNPROVEN account on either side is 'cannot tell' and does not refuse", () => {
  // Mirrors dispatchAccountBlockReason: only positive proof of difference refuses, because a refused
  // reduction strands exposure.
  assert.equal(admit({ observation: observation({ account: null }) }).admitted, true);
  assert.equal(admit({ dispatchAccount: null }).admitted, true);
  assert.equal(
    admit({ observation: observation({ account: null }), dispatchAccount: null }).admitted, true,
  );
});

test("a different token or a different tradingsymbol is refused", () => {
  assert.equal(admit({ observation: observation({ token: 9999 }) }).refusal, "wrong_instrument");
  assert.equal(
    admit({ observation: observation({ tradingsymbol: "NIFTY26SEP25200CE" }) }).refusal,
    "wrong_instrument",
    "a token alone is not identity — tokens are recycled across expiries",
  );
});

test("identity is checked BEFORE depth, so a wrong-instrument book is never accepted on its content", () => {
  // A book for the wrong instrument that would otherwise pass every depth check.
  const v = admit({
    observation: observation({ token: 9999, bids: [{ price: 1000, qty: 100000 }] }),
  });
  assert.equal(v.refusal, "wrong_instrument");
  assert.equal(v.reference_price, null, "nothing may be derived from a book for another instrument");
});

/* ══════════════════════ observation time and freshness ══════════════════════ */

test("an observation with no usable time is refused", () => {
  for (const observed_at of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = admit({ observation: observation({ observed_at }) });
    assert.equal(v.admitted, false, `observed_at=${observed_at} must be refused`);
    assert.equal(v.refusal, "unusable_observation_time");
  }
});

test("a FUTURE-dated observation is refused rather than treated as maximally fresh", () => {
  const v = admit({ observation: observation({ observed_at: NOW + 5_000 }) });
  assert.equal(v.admitted, false);
  assert.equal(v.refusal, "unusable_observation_time");
  assert.match(v.detail, /in the FUTURE/);
  assert.match(v.detail, /clocks disagree/);
});

test("an observation older than the tight degraded limit is refused as not fresh", () => {
  const v = admit({ observation: observation({ observed_at: NOW - 2_001 }), maxObservationAgeMs: 2_000 });
  assert.equal(v.admitted, false);
  assert.equal(v.refusal, "stale_observation");
  assert.match(
    v.detail, /expired cached price is not a\s+fresh quote/,
    "an expired cache must never be presented as a current quote",
  );
  assert.match(v.detail, /market order in disguise/);
  // Exactly at the limit is still admitted; one millisecond past is not.
  assert.equal(admit({ observation: observation({ observed_at: NOW - 2_000 }) }).admitted, true);
});

/* ══════════════════════ LTP is never depth ══════════════════════ */

test("a side whose levels have no real size is refused — LTP is not an executable book", () => {
  // Exactly the shape kite.getQuoteDepth()'s `?? last` fallback produces: a price with no quantity.
  const v = admit({ observation: observation({ bids: [{ price: 100, qty: 0 }] }) });
  assert.equal(v.admitted, false);
  assert.equal(v.refusal, "no_relevant_side_depth");
  assert.match(
    v.detail, /last traded price is NOT a substitute for an executable book/,
    "this is the specific trap: inventing the LTP as a two-sided price makes an unquoted instrument " +
      "look executable",
  );
});

test("levels with a non-positive or non-integer size or a non-positive price are discarded", () => {
  for (const bids of [
    [{ price: 0, qty: 150 }],
    [{ price: -1, qty: 150 }],
    [{ price: 100, qty: -5 }],
    [{ price: 100, qty: 1.5 }],
    [{ price: Number.NaN, qty: 150 }],
  ]) {
    const v = admit({ observation: observation({ bids }) });
    assert.equal(v.admitted, false, `bids=${JSON.stringify(bids)} must be refused`);
    assert.equal(v.refusal, "no_relevant_side_depth");
  }
});

test("an empty relevant side is refused even when the OTHER side is rich", () => {
  const v = admit({ observation: observation({ bids: [], asks: [{ price: 100.1, qty: 10_000 }] }) });
  assert.equal(v.refusal, "no_relevant_side_depth");
});

/* ══════════════════════ quantity and bounded limits ══════════════════════ */

test("depth is counted only AT OR BETTER THAN the bounded limit", () => {
  // A SELL with a limit of 99.95: only the 100 level qualifies; the 99.9 level is beyond the limit.
  const v = admit({ quantity: 200, limitPrice: 99.95 });
  assert.equal(v.admitted, false);
  assert.equal(v.refusal, "insufficient_quantity");
  assert.match(v.detail, /offers 150 within the bounded limit/);
  // Lower the limit and the second level becomes available.
  const wider = admit({ quantity: 200, limitPrice: 99.9 });
  assert.equal(wider.admitted, true, `must be admitted: ${wider.detail}`);
  assert.equal(wider.executable_quantity, 450);
});

test("an unbounded or non-positive limit price is refused — this path never enables MARKET orders", () => {
  for (const limitPrice of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = admit({ limitPrice });
    assert.equal(v.admitted, false, `limitPrice=${limitPrice} must be refused`);
    assert.equal(v.refusal, "unbounded_limit");
    assert.match(v.detail, /market order, which this path never enables/);
  }
});

test("a non-positive or non-integer quantity is refused", () => {
  for (const quantity of [0, -75, 7.5, Number.NaN]) {
    const v = admit({ quantity });
    assert.equal(v.admitted, false, `quantity=${quantity} must be refused`);
  }
});

test("a missing observation is refused without inventing a price", () => {
  for (const observation of [null, undefined]) {
    const v = admit({ observation });
    assert.equal(v.admitted, false);
    assert.equal(v.refusal, "no_observation");
    assert.equal(v.reference_price, null);
    assert.match(v.detail, /without inventing one/);
  }
});

/* ══════════════════════════════════ the policy ══════════════════════════════════ */

const capability = (overrides = {}) => ({
  supported: true,
  enabled: true,
  detail: "REST depth is available.",
  ...overrides,
});

test("a healthy feed means the ordinary path applies and this policy has no opinion", () => {
  const v = degradedRecoveryVerdict({
    marketOpen: true, feed: "healthy", capability: capability(), admission: null, tradingsymbol: "X",
  });
  assert.deepEqual(v, { kind: "normal" });
});

test("a closed exchange blocks but does NOT ask for broker-terminal intervention", () => {
  const v = degradedRecoveryVerdict({
    marketOpen: false, feed: "unhealthy", capability: capability(), admission: null, tradingsymbol: "X",
  });
  assert.equal(v.kind, "blocked");
  assert.equal(
    v.needs_broker_terminal, false,
    "nobody can trade a closed exchange, so sending the operator to the terminal would be wrong",
  );
  assert.match(v.blocker, /still owned and still monitored/);
  assert.match(v.blocker, /re-attempted when the market opens/);
});

test("an unsupported broker blocks and names the broker terminal", () => {
  const v = degradedRecoveryVerdict({
    marketOpen: true,
    feed: "unhealthy",
    capability: capability({ supported: false, detail: "No REST depth source is known." }),
    admission: null,
    tradingsymbol: "NIFTY 25000/25200",
  });
  assert.equal(v.kind, "blocked");
  assert.equal(v.needs_broker_terminal, true);
  assert.match(v.blocker, /CANNOT be reduced by this process/);
  assert.match(v.blocker, /unresolved and still owned/);
  assert.match(v.blocker, /Reduce it at the\s+broker terminal/);
  assert.match(v.blocker, /NIFTY 25000\/25200/, "the blocker must name the instrument");
});

test("a supported but DISABLED degraded path blocks honestly and says it is disabled", () => {
  const v = degradedRecoveryVerdict({
    marketOpen: true,
    feed: "unhealthy",
    capability: capability({ enabled: false, detail: "Not wired at the dispatch boundary." }),
    admission: null,
    tradingsymbol: "X",
  });
  assert.equal(v.kind, "blocked");
  assert.equal(v.needs_broker_terminal, true);
  assert.match(v.blocker, /not enabled/);
  assert.match(v.blocker, /Not wired at the dispatch boundary/);
  assert.match(v.blocker, /unresolved and still owned/);
});

test("a REFUSED admission blocks, carries the exact refusal, and states nothing was sent", () => {
  const refusedAdmission = admit({ observation: observation({ observed_at: NOW - 60_000 }) });
  assert.equal(refusedAdmission.admitted, false);
  const v = degradedRecoveryVerdict({
    marketOpen: true,
    feed: "unhealthy",
    capability: capability(),
    admission: refusedAdmission,
    tradingsymbol: "NIFTY26SEP25000CE",
  });
  assert.equal(v.kind, "blocked");
  assert.match(v.blocker, /was REFUSED/);
  assert.match(v.blocker, /beyond the/, "the precise refusal detail must be carried through");
  assert.match(v.blocker, /Nothing was sent/);
  assert.match(v.blocker, /unresolved and still owned/);
});

test("an ADMITTED book yields a degraded decision that says so and keeps entry blocked", () => {
  const v = degradedRecoveryVerdict({
    marketOpen: true,
    feed: "unhealthy",
    capability: capability(),
    admission: admit(),
    tradingsymbol: "NIFTY26SEP25000CE",
  });
  assert.equal(v.kind, "degraded");
  assert.match(v.detail, /priced from REST depth/);
  assert.match(v.detail, /observed 500ms ago/);
  assert.match(
    v.detail, /New entry stays blocked/,
    "a degraded feed can never justify creating a new four-leg box",
  );
  assert.match(v.detail, /DEGRADED reduction, not a normal one/);
});

test("no blocker anywhere promises flatness or claims success because recovery was requested", () => {
  const blockers = [
    degradedRecoveryVerdict({ marketOpen: false, feed: "unhealthy", capability: capability(), admission: null, tradingsymbol: "X" }),
    degradedRecoveryVerdict({ marketOpen: true, feed: "unhealthy", capability: capability({ supported: false }), admission: null, tradingsymbol: "X" }),
    degradedRecoveryVerdict({ marketOpen: true, feed: "unhealthy", capability: capability({ enabled: false }), admission: null, tradingsymbol: "X" }),
    degradedRecoveryVerdict({ marketOpen: true, feed: "unhealthy", capability: capability(), admission: null, tradingsymbol: "X" }),
    degradedRecoveryVerdict({ marketOpen: true, feed: "unhealthy", capability: capability(), admission: admit({ limitPrice: 0 }), tradingsymbol: "X" }),
  ].filter((v) => v.kind === "blocked").map((v) => v.blocker);

  assert.equal(blockers.length, 5, "every one of these must be a blocked verdict");
  for (const b of blockers) {
    assert.doesNotMatch(b, /\bflat\b|flattened|closed successfully/i, `must not imply flatness: ${b}`);
    assert.match(b, /CANNOT be reduced|no reduction can be worked/, `must say what did not happen: ${b}`);
  }
});

/* ══════════════════════════════════ the projection ══════════════════════════════════ */

test("the status projection reports capability, activity and the blocked list", () => {
  const s = degradedRecoveryStatus({
    capability: capability({ enabled: false, detail: "Not wired." }),
    feed: "unhealthy",
    blocked: [{ tradingsymbol: "NIFTY 25000/25200", reason: "feed unhealthy" }],
  });
  assert.equal(s.supported, true);
  assert.equal(s.enabled, false);
  assert.equal(s.detail, "Not wired.");
  assert.equal(s.active, true, "an unhealthy feed means reductions are on the degraded assessment");
  assert.deepEqual(s.blocked, [{ tradingsymbol: "NIFTY 25000/25200", reason: "feed unhealthy" }]);

  const healthy = degradedRecoveryStatus({ capability: capability(), feed: "healthy", blocked: [] });
  assert.equal(healthy.active, false);
});
