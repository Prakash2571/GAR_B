/**
 * Dhan multi-order basket margin, and API-verified static-IP readiness.
 *
 * TWO CORRECTNESS CLAIMS UNDER TEST
 *
 * 1. A four-leg box is margined as a BASKET. The offsetting legs earn a hedge benefit
 *    that is most of the point of the structure, so the multi-order calculator must be
 *    preferred and the per-leg sum must only ever be a labelled fallback. Critically,
 *    a FAILED multi call must never produce an UNDERSTATED figure — the direction of
 *    the error is what matters.
 *
 * 2. Static-IP readiness must be evidence-based. Dhan exposes its whitelist, so a
 *    configured server IP is verified against it rather than trusted from a boolean,
 *    and every unverified state fails closed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ActiveBrokerManager } from "../../dist/brokers/registry.js";
import {
  DhanClient,
  describeDhanMarginPayload,
  extractIpv4Addresses,
  normalizeDhanMultiMargin,
} from "../../dist/brokers/dhan/client.js";

/* ------------------------- multi-margin normalization ---------------------- */

test("a hedge-adjusted total is read from any of Dhan's spellings", () => {
  for (const key of ["totalMargin", "totalMarginRequired", "total_margin"]) {
    const out = normalizeDhanMultiMargin({ [key]: 41_250 });
    assert.ok(out, `${key} was not recognised`);
    assert.equal(out.total, 41_250);
  }
});

test("span, exposure, F&O and hedge benefit are preserved when present", () => {
  const out = normalizeDhanMultiMargin({
    totalMargin: 41_250,
    spanMargin: 30_000,
    exposureMargin: 11_250,
    foMargin: 41_250,
    marginBenefit: 158_750,
  });
  assert.equal(out.span, 30_000);
  assert.equal(out.exposure, 11_250);
  assert.equal(out.foMargin, 41_250);
  assert.equal(out.hedgeBenefit, 158_750, "the benefit is the whole reason to use this call");
});

test("a payload wrapped in `data` is unwrapped", () => {
  const out = normalizeDhanMultiMargin({ data: { totalMargin: 1234 } });
  assert.ok(out);
  assert.equal(out.total, 1234);
});

test("an UNREADABLE total returns null, so the caller falls back rather than recording zero", () => {
  // This is the important negative case: treating an unreadable response as
  // "no margin required" would understate the figure.
  assert.equal(normalizeDhanMultiMargin({}), null);
  assert.equal(normalizeDhanMultiMargin(null), null);
  assert.equal(normalizeDhanMultiMargin(undefined), null);
  assert.equal(normalizeDhanMultiMargin({ totalMargin: "abc" }), null);
});

test("a zero or negative total is NOT a credible four-leg requirement", () => {
  // Accepting 0 here would silently mark a real box as margin-free.
  assert.equal(normalizeDhanMultiMargin({ totalMargin: 0 }), null);
  assert.equal(normalizeDhanMultiMargin({ totalMargin: -5 }), null);
});

/* ------------------------------ the wire contract -------------------------- */

/**
 * A DhanClient over a RECORDING transport, so the request body itself is observable.
 *
 * The manager-level tests further down stub `calculateMultiMargin` wholesale, and that
 * is exactly how a wrong body shape survived them: the preference logic was proven
 * correct while the request it actually sent was being rejected by Dhan every time, so
 * every real box silently fell through to the inflated per-leg sum. These tests assert
 * the field names on the wire, which is the only place that failure was visible.
 */
function recordingClient(response = { totalMargin: 41_250 }) {
  const sent = [];
  const http = {
    read: async (opts) => {
      sent.push(opts);
      return response;
    },
  };
  return { client: new DhanClient(http, () => "CLIENT7"), sent };
}

const ONE_LEG = {
  exchangeSegment: "NSE_FNO",
  transactionType: "BUY",
  quantity: 275,
  productType: "MARGIN",
  securityId: "45000",
  price: 50,
};

test("the multi-margin request sends its legs under `scripList`", async () => {
  const { client, sent } = recordingClient();
  await client.calculateMultiMargin([ONE_LEG]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].path, "/margincalculator/multi");
  assert.deepEqual(sent[0].body.scripList, [ONE_LEG]);
  assert.equal(sent[0].body.orders, undefined, "`orders` is not a field Dhan accepts here");
});

test("dhanClientId is sent ONCE at the top level, never repeated per leg", async () => {
  const { client, sent } = recordingClient();
  await client.calculateMultiMargin([ONE_LEG]);
  assert.equal(sent[0].body.dhanClientId, "CLIENT7");
  for (const leg of sent[0].body.scripList) {
    assert.equal(leg.dhanClientId, undefined);
  }
});

test("the netting flags are always explicit, and default to false", async () => {
  // Explicit rather than omitted: the figure must describe THIS basket, so that it is
  // reproducible whether it is computed at entry or on a later backfill sweep.
  const { client, sent } = recordingClient();
  await client.calculateMultiMargin([ONE_LEG]);
  assert.equal(sent[0].body.includePosition, false);
  assert.equal(sent[0].body.includeOrder, false);

  const { client: c2, sent: s2 } = recordingClient();
  await c2.calculateMultiMargin([ONE_LEG], { includePosition: true });
  assert.equal(s2[0].body.includePosition, true);
  assert.equal(s2[0].body.includeOrder, false);
});

test("the body carries exactly Dhan's four fields and nothing more", async () => {
  const { client, sent } = recordingClient();
  await client.calculateMultiMargin([ONE_LEG]);
  assert.deepEqual(Object.keys(sent[0].body).sort(), [
    "dhanClientId",
    "includeOrder",
    "includePosition",
    "scripList",
  ]);
});

test("an unreadable payload is described by FIELD NAME, never by value", async () => {
  // Account balances travel in this payload, so the diagnostic names keys only. Without
  // it, a renamed field is indistinguishable from a transient outage in the logs.
  assert.equal(
    describeDhanMarginPayload({ data: { errorType: "x", errorMessage: "y" } }),
    "errorType, errorMessage",
  );
  assert.equal(describeDhanMarginPayload({}), "<no fields>");
  assert.equal(describeDhanMarginPayload(null), "null");
});

/* ---------------------------- the basket margin ---------------------------- */

const BOX_ORDERS = [
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2500CE", transaction_type: "BUY", variety: "regular", product: "NRML", order_type: "MARKET", quantity: 275, price: 50 },
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2520CE", transaction_type: "SELL", variety: "regular", product: "NRML", order_type: "MARKET", quantity: 275, price: 30 },
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2520PE", transaction_type: "BUY", variety: "regular", product: "NRML", order_type: "MARKET", quantity: 275, price: 40 },
  { exchange: "NFO", tradingsymbol: "ASTRAL25SEP2500PE", transaction_type: "SELL", variety: "regular", product: "NRML", order_type: "MARKET", quantity: 275, price: 20 },
];

/**
 * A manager whose Dhan instrument store already resolves the four box legs, with the
 * Dhan client stubbed so the margin calls are observable.
 */
function marginManager({ multi, perLeg } = {}) {
  const calls = { multi: 0, perLeg: 0, multiLegs: null };
  const m = new ActiveBrokerManager({
    kite: {
      getAccessToken: () => "k",
      getApiKey: () => "k",
      getQuoteFull: async () => [],
      getBasketMargin: async () => ({ initial: 1, final: 2, total: 2 }),
    },
    tickerHub: {
      isConnected: () => true, subscribedCount: () => 0, subscribeTokens: () => {},
      unsubscribeTokens: () => {}, stop: () => {}, seed: () => {}, retain: () => () => {},
      addTickListener: () => () => {}, addConnectionListener: () => () => {},
      ingestExternalTicks: () => {}, setExternalConnected: () => {},
    },
    boxConfig: () => ({}),
    istDayKey: () => "2026-09-03",
    onDhanTicks: () => {},
  });

  // Seed the instrument store so every leg resolves to a Dhan security id.
  const store = m.dhanInstrumentStore;
  store.load = async () => [];
  const instruments = BOX_ORDERS.map((o, i) => ({
    exchange: "NFO",
    tradingsymbol: o.tradingsymbol,
    dhan_segment: "NSE_FNO",
    dhan_security_id: 45000 + i,
    instrument_token: 2_000_045_000 + i,
  }));
  Object.defineProperty(store, "instruments", { get: () => instruments, configurable: true });

  // Stub the Dhan client.
  const client = m.dhan;
  client.calculateMultiMargin = async (legs) => {
    calls.multi++;
    calls.multiLegs = legs;
    if (typeof multi === "function") return multi(legs);
    if (multi === "throw") throw new Error("multi endpoint unavailable");
    return multi ?? { totalMargin: 41_250, spanMargin: 30_000, exposureMargin: 11_250, marginBenefit: 158_750 };
  };
  client.calculateMargin = async () => {
    calls.perLeg++;
    if (perLeg === "throw") throw new Error("per-leg unavailable");
    return perLeg ?? { totalMargin: 50_000, spanMargin: 40_000 };
  };
  return { m, calls };
}

/** Force Dhan active without going through the guarded switch. */
function activateDhan(m) {
  Object.defineProperty(m, "active", { value: "dhan", writable: true, configurable: true });
}

test("the MULTI-ORDER endpoint is preferred over per-leg margins", async () => {
  const { m, calls } = marginManager();
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(calls.multi, 1);
  assert.equal(calls.perLeg, 0, "per-leg must not be called when multi succeeds");
  assert.equal(res.source, "dhan_multi");
});

test("all FOUR box legs are sent in one request", async () => {
  // Margining a subset would understate the requirement: the hedge benefit of three
  // legs is not the hedge benefit of four.
  const { m, calls } = marginManager();
  activateDhan(m);
  await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(calls.multiLegs.length, 4);
});

test("BUY/SELL direction is preserved per leg", async () => {
  // Sending them one-directionally would defeat the hedge recognition entirely.
  const { m, calls } = marginManager();
  activateDhan(m);
  await m.margins().basketMargin(BOX_ORDERS);
  assert.deepEqual(
    calls.multiLegs.map((l) => l.transactionType),
    ["BUY", "SELL", "BUY", "SELL"],
  );
});

test("the MARGIN (carry-forward) product is used, never INTRADAY", async () => {
  // INTRADAY is margined differently AND auto-squared-off.
  const { m, calls } = marginManager();
  activateDhan(m);
  await m.margins().basketMargin(BOX_ORDERS);
  assert.ok(calls.multiLegs.every((l) => l.productType === "MARGIN"));
  assert.ok(calls.multiLegs.every((l) => l.exchangeSegment === "NSE_FNO"));
  assert.ok(calls.multiLegs.every((l) => l.quantity === 275));
  assert.ok(calls.multiLegs.every((l) => l.price > 0));
});

test("the REAL per-leg price is preferred over the order price", async () => {
  // Dhan's calculator has no `order_type`, so it margins against whatever price it is
  // handed — a MARKET leg's price is not resolved server-side from the LTP the way
  // Kite's basket endpoint does it.
  const { m, calls } = marginManager();
  activateDhan(m);
  await m.margins().basketMargin(BOX_ORDERS.map((o) => ({ ...o, price: 0, reference_price: 12.5 })));
  assert.ok(calls.multiLegs.every((l) => l.price === 12.5));
});

test("an UNPRICED leg makes the basket unavailable instead of being margined at a nominal price", async () => {
  // CHANGED DELIBERATELY. This used to assert that an unpriced leg was still sent, at a nominal
  // ₹0.05, "to keep the hedge-aware path alive". Dhan margins against whatever price it is
  // handed, so that produced a figure for a basket whose premium component is not the one being
  // traded — and that figure then flowed into live admission as broker-confirmed evidence.
  //
  // A leg we cannot price is a leg we cannot margin. The basket is now reported unavailable and
  // NO request is sent, which is both honest and cheaper.
  const { m, calls } = marginManager();
  activateDhan(m);
  const res = await m.margins().basketMargin(
    BOX_ORDERS.map((o) => ({ ...o, price: 0, reference_price: null })),
  );
  assert.equal(calls.multi, 0, "a basket with an unpriced leg is never sent");
  assert.equal(calls.perLeg, 0);
  assert.equal(res.source, "unavailable");
  assert.equal(res.complete, false);
  assert.equal(res.total, null, "no figure at all, rather than one priced off a placeholder");
  assert.match(String(res.incomplete_reason), /price/i);
});

test("the hedge-adjusted total is returned, with span/exposure/benefit preserved", async () => {
  const { m } = marginManager();
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(res.total, 41_250, "the hedge-adjusted basket figure");
  assert.equal(res.span, 30_000);
  assert.equal(res.exposure, 11_250);
  assert.equal(res.hedge_benefit, 158_750);
});

test("the multi total is used even though it is FAR below the per-leg sum", async () => {
  // Per-leg would report 4 x 50,000 = 200,000 against a true basket requirement of
  // 41,250. Summing standalone margins is exactly the ~5x over-statement this fixes.
  const { m } = marginManager();
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.ok(res.total < 200_000);
  assert.equal(res.source, "dhan_multi");
});

test("a FAILED multi call falls back to the per-leg sum, clearly labelled", async () => {
  const { m, calls } = marginManager({ multi: "throw" });
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(calls.multi, 1);
  assert.equal(calls.perLeg, 4, "every leg was priced individually");
  assert.equal(res.source, "dhan_per_leg_fallback");
  assert.equal(res.hedge_benefit, null, "no benefit is recognised in this path");
});

test("the fallback is CONSERVATIVE — it can never understate the requirement", async () => {
  // The whole safety property: a broken multi endpoint must err high, not low.
  const { m } = marginManager({ multi: "throw" });
  activateDhan(m);
  const fallback = await m.margins().basketMargin(BOX_ORDERS);

  const { m: m2 } = marginManager();
  activateDhan(m2);
  const hedged = await m2.margins().basketMargin(BOX_ORDERS);

  assert.ok(
    fallback.total >= hedged.total,
    `fallback ${fallback.total} must be >= hedge-adjusted ${hedged.total}`,
  );
  assert.equal(fallback.total, 200_000);
});

test("an unreadable multi response falls back rather than recording zero", async () => {
  const { m, calls } = marginManager({ multi: {} });
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(calls.perLeg, 4);
  assert.equal(res.source, "dhan_per_leg_fallback");
  assert.ok(res.total > 0, "a failed multi API must not produce an understated value");
});

test("when NOTHING can be priced the result is `unavailable`, not zero margin", async () => {
  // Reported as unknown so the dashboard counts it separately instead of treating the
  // box as margin-free.
  const { m } = marginManager({ multi: "throw", perLeg: "throw" });
  activateDhan(m);
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(res.source, "unavailable");
  // STRENGTHENED: the total is now null, not 0. A numeric 0 still had to be defended against by
  // every consumer ("is this zero real?"); null cannot be mistaken for a requirement of nothing.
  assert.equal(res.total, null);
  assert.equal(res.complete, false);
  assert.equal(res.legs_priced, 0);
});

test("Zerodha still uses its own basket API, labelled kite_basket", async () => {
  const { m, calls } = marginManager();
  const res = await m.margins().basketMargin(BOX_ORDERS);
  assert.equal(res.source, "kite_basket");
  assert.equal(calls.multi, 0, "no Dhan call while Zerodha is active");
});

/* ------------------------------- static IP -------------------------------- */

/**
 * Run `fn` with a controlled Dhan environment, then restore it.
 *
 * MUST await inside the try. `try { return fn() } finally { restore() }` restores the
 * environment the instant `fn()` returns its promise — while the async body is still
 * running — so the body would observe the original env and every assertion would be
 * meaningless.
 */
async function ipEnv(values, fn) {
  const keys = ["DHAN_STATIC_IP_EXPECTED", "DHAN_STATIC_PUBLIC_IP", "DHAN_LIVE_TRADING_ENABLED"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function ipManager(getStaticIp) {
  const { m } = marginManager();
  activateDhan(m);
  // A live session, so verification is attempted rather than short-circuited.
  Object.defineProperty(m, "dhanAccessToken", { value: "tok", writable: true, configurable: true });
  Object.defineProperty(m, "dhanTokenExpiry", { value: null, writable: true, configurable: true });
  if (getStaticIp) m.dhan.getStaticIp = getStaticIp;
  return m;
}

test("with NO configured IP, readiness falls back to the manual declaration", async () => {
  await ipEnv({ DHAN_STATIC_IP_EXPECTED: "true" }, async () => {
    const m = ipManager();
    assert.equal(m.dhanStaticIpReady(), true);
    const state = m.dhanStaticIpState();
    assert.equal(state.configured_ip, null);
    assert.equal(state.declared, true);
  });
});

test("with nothing configured at all, it FAILS CLOSED", async () => {
  await ipEnv({}, async () => {
    const m = ipManager();
    assert.equal(m.dhanStaticIpReady(), false);
    assert.equal(m.healthFor("dhan").trading_ready, false);
  });
});

test("a configured IP that MATCHES Dhan's primary verifies and becomes ready", async () => {
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7" }, async () => {
    const m = ipManager(async () => ({ primaryIP: "203.0.113.7", secondaryIP: "" }));
    const result = await m.verifyDhanStaticIp();
    assert.equal(result.verified, true);
    assert.equal(m.dhanStaticIpReady(), true);
    assert.equal(m.dhanStaticIpState().api_verified, true);
  });
});

test("a configured IP matching the SECONDARY also verifies", async () => {
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.9" }, async () => {
    const m = ipManager(async () => ({ primaryIP: "198.51.100.1", secondaryIP: "203.0.113.9" }));
    assert.equal((await m.verifyDhanStaticIp()).verified, true);
    assert.equal(m.dhanStaticIpReady(), true);
  });
});

test("a MISMATCHED IP blocks trading and names both sides", async () => {
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7" }, async () => {
    const m = ipManager(async () => ({ primaryIP: "198.51.100.1", secondaryIP: "198.51.100.2" }));
    const result = await m.verifyDhanStaticIp();
    assert.equal(result.verified, false);
    assert.equal(m.dhanStaticIpReady(), false);
    assert.match(result.error, /203\.0\.113\.7/);
    assert.match(result.error, /198\.51\.100\.1/);
    assert.equal(m.healthFor("dhan").trading_ready, false);
  });
});

test("a configured IP that has NOT been verified yet is NOT ready", async () => {
  // null (never checked) must fail closed — the boolean alone is not enough once an
  // IP has been configured for verification.
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7", DHAN_STATIC_IP_EXPECTED: "true" }, async () => {
    const m = ipManager();
    assert.equal(m.dhanStaticIpState().api_verified, null);
    assert.equal(m.dhanStaticIpReady(), false);
  });
});

test("an UNREACHABLE verification call fails closed", async () => {
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7" }, async () => {
    const m = ipManager(async () => {
      throw new Error("network down");
    });
    const result = await m.verifyDhanStaticIp();
    assert.equal(result.verified, false);
    assert.equal(m.dhanStaticIpReady(), false);
    assert.match(result.error, /verification failed/i);
  });
});

test("verification without a Dhan session fails closed", async () => {
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7" }, async () => {
    const { m } = marginManager();
    activateDhan(m);
    const result = await m.verifyDhanStaticIp();
    assert.equal(result.verified, false);
    assert.match(result.error, /without a Dhan session/);
  });
});

test("the manual flag remains an override that can still BLOCK a verified IP", async () => {
  // API evidence supersedes a declaration for permitting, but an explicit false is
  // still an operator kill switch.
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "203.0.113.7", DHAN_STATIC_IP_EXPECTED: "false" }, async () => {
    const m = ipManager(async () => ({ primaryIP: "203.0.113.7" }));
    await m.verifyDhanStaticIp();
    assert.equal(m.dhanStaticIpReady(), false, "explicit false still blocks");
  });
});

test("readiness on the manual flag alone is reported as weaker evidence", async () => {
  await ipEnv({ DHAN_STATIC_IP_EXPECTED: "true", DHAN_LIVE_TRADING_ENABLED: "true" }, async () => {
    const m = ipManager();
    const problems = m.healthFor("dhan").problems;
    assert.ok(
      problems.some((p) => /DHAN_STATIC_PUBLIC_IP/.test(p)),
      `expected a note recommending API verification, got: ${problems.join(" | ")}`,
    );
  });
});


/* --------------------- /ip/getIP payload shape tolerance ------------------- */

/**
 * These exist because the first implementation read ONLY `primaryIP`/`secondaryIP`,
 * and when Dhan returned the whitelist under different keys it concluded both were
 * unset and failed closed — reporting an empty whitelist while the Dhan dashboard
 * plainly showed a whitelisted address. Guessing one spelling for a fail-closed
 * security check is fragile in the worst direction: it blocks trading and blames the
 * operator's configuration.
 */

test("IPv4 addresses are found under Dhan's dashboard-style ipAddress1/2 keys", () => {
  // The dashboard labels them "IP Address 1" / "IP Address 2", and NA marks an
  // unused second slot.
  const found = extractIpv4Addresses({
    dhanClientId: "1000000001",
    ipAddress1: "100.31.218.89",
    ipAddress2: "NA",
  });
  assert.deepEqual(found, ["100.31.218.89"]);
});

test("IPv4 addresses are found under primaryIP/secondaryIP keys", () => {
  const found = extractIpv4Addresses({ primaryIP: "203.0.113.7", secondaryIP: "198.51.100.2" });
  assert.deepEqual(found, ["203.0.113.7", "198.51.100.2"]);
});

test("a `data`-wrapped payload is scanned", () => {
  const found = extractIpv4Addresses({ status: "success", data: { ipAddress1: "203.0.113.7" } });
  assert.deepEqual(found, ["203.0.113.7"]);
});

test("an array of addresses is scanned", () => {
  const found = extractIpv4Addresses({ staticIp: ["203.0.113.7", "198.51.100.2"] });
  assert.deepEqual(found, ["203.0.113.7", "198.51.100.2"]);
});

test("NA, empty and null slots are skipped, never treated as addresses", () => {
  // Matching a literal "NA" would let an unset slot satisfy the comparison.
  assert.deepEqual(extractIpv4Addresses({ a: "NA", b: "na", c: "", d: null }), []);
});

test("non-IP strings are not mistaken for addresses", () => {
  // A loose /[\d.]+/ would match version strings and quantities and produce false
  // confidence in a security check.
  assert.deepEqual(
    extractIpv4Addresses({ version: "2.0.1", qty: "275", ratio: "1.5", ip: "999.1.1.1" }),
    [],
  );
});

test("duplicates are collapsed", () => {
  const found = extractIpv4Addresses({ a: "203.0.113.7", b: "203.0.113.7" });
  assert.deepEqual(found, ["203.0.113.7"]);
});

test("the scan is bounded and safe on odd payloads", () => {
  assert.deepEqual(extractIpv4Addresses(null), []);
  assert.deepEqual(extractIpv4Addresses(undefined), []);
  assert.deepEqual(extractIpv4Addresses("203.0.113.7"), ["203.0.113.7"]);
  assert.deepEqual(extractIpv4Addresses(42), []);
});

test("verification MATCHES against Dhan's dashboard-style key names", async () => {
  // The end-to-end regression: this exact payload previously produced
  // "primary unset, secondary unset" and blocked live trading.
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "100.31.218.89" }, async () => {
    const m = ipManager(async () => ({
      dhanClientId: "1000000001",
      ipAddress1: "100.31.218.89",
      ipAddress2: "NA",
    }));
    const result = await m.verifyDhanStaticIp();
    assert.equal(result.verified, true, result.error ?? "should have verified");
    assert.equal(m.dhanStaticIpReady(), true);
    assert.equal(result.primary_ip, "100.31.218.89");
  });
});

test("an EMPTY whitelist is reported differently from a mismatch", async () => {
  // Different operator actions: add a static IP vs correct the configured one.
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "100.31.218.89" }, async () => {
    const m = ipManager(async () => ({ dhanClientId: "1", ipAddress1: "NA", ipAddress2: "NA" }));
    const result = await m.verifyDhanStaticIp();
    assert.equal(result.verified, false);
    assert.match(result.error, /returned no IP address/);
    // The received keys are named so a future shape change is diagnosable.
    assert.match(result.error, /Response fields/);
  });
});

test("a genuine mismatch lists what Dhan actually has", async () => {
  await ipEnv({ DHAN_STATIC_PUBLIC_IP: "100.31.218.89" }, async () => {
    const m = ipManager(async () => ({ ipAddress1: "198.51.100.1", ipAddress2: "198.51.100.2" }));
    const result = await m.verifyDhanStaticIp();
    assert.equal(result.verified, false);
    assert.match(result.error, /does not match/);
    assert.match(result.error, /198\.51\.100\.1, 198\.51\.100\.2/);
    assert.equal(m.dhanStaticIpReady(), false, "still fails closed");
  });
});
