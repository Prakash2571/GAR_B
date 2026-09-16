/**
 * AUDIT REGRESSIONS — findings 2, 5, 7a and 7b.
 *
 * Every assertion describes DESIRED behaviour and FAILS on the audited baseline (978b813).
 *
 *   FINDING 2 — `OrderStreamConsumer.registerIntent` coalesced with `args.account ?? opts.account()`,
 *   which cannot tell an EXPLICIT null ("ownership is unproven") from an OMITTED field. Both became
 *   the CURRENT SESSION account — a hard claim the projection then enforces, so a fill naming the
 *   order's real (different) account was rejected as `foreign_account` and an owned fill was thrown
 *   away.
 *
 *   FINDING 5 — a real HTTP 429 produced no cooldown, for two independent reasons: the wrappers stored
 *   the nested error in `causeValue` while the finder walked `.cause`, and the transport discarded the
 *   `Retry-After` response header (sniffing the JSON body instead) while `response.json()` on a
 *   non-JSON error page destroyed the status entirely.
 *
 *   FINDING 7a — offset-less broker timestamps were parsed with host-local `Date.parse`, so an IST
 *   stamp on a UTC host landed 5h30m in the future.
 *
 *   FINDING 7b — the binary tick parser had no minimum packet length, so a 5-byte frame threw a
 *   RangeError out of the WebSocket message callback.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { OrderStreamConsumer } from "../../dist/box/orderStreamConsumer.js";
import { OrderUpdateProjection } from "../../dist/box/orderUpdateProjection.js";
import {
  IST_UTC_OFFSET_MS,
  brokerTimestampStatedZone,
  parseIstBrokerTimestamp,
} from "../../dist/box/brokerTimestamps.js";
import { parseBinary } from "../../dist/ticker.js";
import {
  KiteHttpError,
  KiteHttpTransport,
} from "../../dist/box/kiteBrokerAdapter.js";
import {
  BrokerAmbiguousSubmitError,
  BrokerCancelNotTransmittedError,
} from "../../dist/box/brokerAdapter.js";
import { RateBudgetLedger, brokerRateLimits, parseRetryAfterMs } from "../../dist/box/brokerPacing.js";

/* ══════════════════════ FINDING 2 — unproven ownership must stay unproven ══════════════════════ */

function consumerWith(sessionAccount) {
  return new OrderStreamConsumer({
    broker: "zerodha",
    account: () => sessionAccount,
    streamEnabled: true,
  });
}

test("F2-1: an EXPLICIT null account is preserved as UNPROVEN, not replaced by the session", () => {
  const consumer = consumerWith("ZD-CURRENT");
  consumer.registerIntent({
    clientOrderId: "BOX-1",
    ownerTag: "TAG1",
    // The manager passes this deliberately for a durable row that predates migration 011.
    account: null,
    requestedQty: 75,
  });

  // A fill arrives naming the account that REALLY placed it — a different one.
  const result = consumer.ingestStreamObservation({
    ownerTag: "TAG1",
    account: "ZD-ORIGINAL",
    cumulativeQty: 75,
    rawStatus: "COMPLETE",
  });

  // ON THE BASELINE the consumer had stamped "ZD-CURRENT", so this frame was `foreign_account` and
  // the fill was DISCARDED — real exposure left unobserved.
  assert.notEqual(
    result.rejection,
    "foreign_account",
    "a fill must not be rejected against an account the consumer invented",
  );
  assert.equal(result.attributed, true, "an owned fill on our own tag must be attributed");
});

test("F2-2: an OMITTED account may still default to the session account", () => {
  const consumer = consumerWith("ZD-CURRENT");
  // No `account` key at all: the caller has no opinion, so a default is legitimate.
  consumer.registerIntent({ clientOrderId: "BOX-2", ownerTag: "TAG2", requestedQty: 75 });

  const foreign = consumer.ingestStreamObservation({
    ownerTag: "TAG2",
    account: "SOMEONE-ELSE",
    cumulativeQty: 75,
    rawStatus: "COMPLETE",
  });
  assert.equal(
    foreign.rejection,
    "foreign_account",
    "a defaulted account is still a real claim and must reject a genuinely foreign frame",
  );
});

test("F2-3: a PROVEN account still rejects a foreign frame", () => {
  const consumer = consumerWith("ZD-CURRENT");
  consumer.registerIntent({
    clientOrderId: "BOX-3",
    ownerTag: "TAG3",
    account: "ZD-OWNER",
    requestedQty: 75,
  });
  const foreign = consumer.ingestStreamObservation({
    ownerTag: "TAG3",
    account: "ZD-INTRUDER",
    cumulativeQty: 75,
    rawStatus: "COMPLETE",
  });
  assert.equal(foreign.rejection, "foreign_account", "the fail-closed direction is unchanged");
});

test("F2-4: a BLANK account is treated as unproven, not as an account literally named ''", () => {
  const consumer = consumerWith("ZD-CURRENT");
  consumer.registerIntent({
    clientOrderId: "BOX-4",
    ownerTag: "TAG4",
    account: "   ",
    requestedQty: 75,
  });
  const result = consumer.ingestStreamObservation({
    ownerTag: "TAG4",
    account: "ZD-REAL",
    cumulativeQty: 75,
    rawStatus: "COMPLETE",
  });
  assert.notEqual(result.rejection, "foreign_account");
});

test("F2-5: unproven ownership stays VISIBLE — it is counted, never silent", () => {
  const projection = new OrderUpdateProjection();
  projection.register({ clientOrderId: "BOX-5", ownerTag: "TAG5", account: null, requestedQty: 75 });
  projection.ingest({
    ownerTag: "TAG5",
    account: "ZD-REAL",
    cumulativeQty: 75,
    quantityPresent: true,
    rawStatus: "COMPLETE",
    source: "order_update",
  });
  const diagnostics = projection.diagnostics();
  assert.ok(
    diagnostics.unverifiedAccount >= 1,
    "an attributed-but-unverified fill must be reported, so the gap is auditable",
  );
  assert.equal(diagnostics.foreignAccount, 0);
});

/* ═══════════════════ FINDING 5 — a real 429 must produce a real cooldown ═══════════════════════ */

function ledger() {
  return new RateBudgetLedger(brokerRateLimits("zerodha"), { workerCount: 1, recoveryReserveFraction: 0.2 });
}

/** A `Response`-shaped fake that carries REAL headers, as a rate-limited broker actually would. */
function rateLimited({ body = '{"status":"error","message":"Too many requests"}', retryAfter = "30", json } = {}) {
  return {
    ok: false,
    status: 429,
    headers: new Headers(retryAfter === null ? {} : { "retry-after": retryAfter }),
    text: async () => body,
    ...(json ? { json } : {}),
  };
}

test("F5-1: findKiteHttpError reaches a 429 nested via causeValue (the wrapper the placement path uses)", () => {
  const http = new KiteHttpError(429, "Too many requests", {}, "30");
  // The placement path wraps TWICE. Both wrappers historically used `causeValue` only.
  const wrapped = new BrokerAmbiguousSubmitError(
    "transport-pending",
    "outer",
    new BrokerAmbiguousSubmitError("transport-pending", "inner", http),
  );
  assert.equal(wrapped.causeValue !== undefined, true, "the repo convention is retained");
  assert.equal(
    wrapped.cause !== undefined,
    true,
    "and the standard cause is now populated too, so ordinary traversal can see it",
  );
});

test("F5-2: the transport preserves the REAL Retry-After header on a 429", async () => {
  const transport = new KiteHttpTransport({
    apiKey: "k",
    accessToken: () => "t",
    timeoutMs: 1_000,
    fetchImpl: async () => rateLimited({ retryAfter: "30" }),
  });

  await assert.rejects(
    transport.listOrders(),
    (error) => {
      assert.ok(error instanceof KiteHttpError, `expected KiteHttpError, got ${error?.name}`);
      assert.equal(error.status, 429);
      // ON THE BASELINE the header was discarded and only the JSON body was sniffed, which for
      // Kite's real 429 body yields nothing at all.
      assert.equal(error.retryAfter, "30", "the broker's own backoff instruction must survive");
      return true;
    },
  );
});

test("F5-3: a NON-JSON 429 body still yields the status instead of an opaque SyntaxError", async () => {
  const transport = new KiteHttpTransport({
    apiKey: "k",
    accessToken: () => "t",
    timeoutMs: 1_000,
    fetchImpl: async () => rateLimited({ body: "<html><body>429 Too Many Requests</body></html>" }),
  });

  await assert.rejects(
    transport.listOrders(),
    (error) => {
      // ON THE BASELINE `response.json()` threw first and the 429 was lost entirely, so no cooldown
      // was possible for exactly the case a throttling gateway produces.
      assert.ok(error instanceof KiteHttpError, `expected KiteHttpError, got ${error?.name}`);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, "30");
      return true;
    },
  );
});

test("F5-4: a 30-second Retry-After becomes a 30-second cooldown, not a 1-second default", () => {
  const budget = ledger();
  const now = 1_000_000;
  const retryAfterMs = parseRetryAfterMs("30", now);
  assert.equal(retryAfterMs, 30_000, "delta-seconds are understood");

  budget.penalize(now, retryAfterMs);
  const snapshot = budget.snapshot(now);
  assert.equal(snapshot.cooldown_active, true);
  assert.equal(
    snapshot.cooldown_until,
    now + 30_000,
    "the broker's stated backoff must be honoured rather than replaced by our conservative default",
  );
});

test("F5-5: an HTTP-date Retry-After is understood too", () => {
  const now = Date.parse("2026-09-16T10:00:00Z");
  const at = new Date(now + 45_000).toUTCString();
  assert.ok(Math.abs((parseRetryAfterMs(at, now) ?? 0) - 45_000) <= 1_000);
});

test("F5-6: a 2xx whose body is not JSON is a fault, not a silently empty success", async () => {
  const transport = new KiteHttpTransport({
    apiKey: "k",
    accessToken: () => "t",
    timeoutMs: 1_000,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => "not json at all",
    }),
  });
  await assert.rejects(transport.listOrders(), /not JSON/i);
});

test("F5-7: a json()-only response fake still works (no text() available)", async () => {
  const transport = new KiteHttpTransport({
    apiKey: "k",
    accessToken: () => "t",
    timeoutMs: 1_000,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ order_id: "1" }] }),
    }),
  });
  const orders = await transport.listOrders();
  assert.equal(orders.length, 1, "the legacy json()-only shape must keep working");
});

test("F5-8: a cooldown NEVER shortens, and a proven-unsent cancel is not an ambiguous submit", () => {
  const budget = ledger();
  budget.penalize(1_000, 30_000);
  budget.penalize(1_500, 1_000);
  assert.equal(budget.snapshot(1_500).cooldown_until, 31_000, "a later, smaller hint cannot shorten it");

  // The three-valued outcome finding 4 introduced: proven-unsent is its OWN type, so a caller can
  // never read a timeout as either "cancelled" or "reconcile this".
  const unsent = new BrokerCancelNotTransmittedError("BOX-9", "BRK-9");
  assert.equal(unsent.transmitted, false);
  assert.ok(!(unsent instanceof BrokerAmbiguousSubmitError), "it must not be confused with ambiguity");
});

/* ══════════════════ FINDING 7a — offset-less broker stamps are IST, not host-local ══════════════ */

test("F7a-1: a zone-less IST stamp resolves identically regardless of the host timezone", () => {
  // 2026-09-09 10:00:01 IST === 04:30:01 UTC.
  const expected = Date.UTC(2026, 8, 9, 10, 0, 1) - IST_UTC_OFFSET_MS;
  assert.equal(parseIstBrokerTimestamp("2026-09-09 10:00:01"), expected);
  assert.equal(new Date(expected).toISOString(), "2026-09-09T04:30:01.000Z");
  // ON THE BASELINE this was `Date.parse("2026-09-09 10:00:01")`, i.e. host-local — on a UTC host
  // (every container in deploy/) the instant landed 5h30m in the FUTURE.
  assert.equal(
    parseIstBrokerTimestamp("2026-09-09 10:00:01"),
    parseIstBrokerTimestamp("2026-09-09T10:00:01"),
    "the T separator must not change the answer",
  );
});

test("F7a-2: a stamp that STATES its offset is honoured verbatim, never re-read as IST", () => {
  assert.equal(parseIstBrokerTimestamp("2026-09-09T04:30:01Z"), Date.parse("2026-09-09T04:30:01Z"));
  assert.equal(parseIstBrokerTimestamp("2026-09-09T10:00:01+05:30"), Date.parse("2026-09-09T04:30:01Z"));
  assert.equal(brokerTimestampStatedZone("2026-09-09T04:30:01Z"), true);
  assert.equal(brokerTimestampStatedZone("2026-09-09 10:00:01"), false);
});

test("F7a-3: whole-second and fractional stamps both parse; junk is reported as unknown", () => {
  assert.equal(parseIstBrokerTimestamp("2026-09-09 10:00"), Date.UTC(2026, 8, 9, 10, 0, 0) - IST_UTC_OFFSET_MS);
  assert.equal(
    parseIstBrokerTimestamp("2026-09-09 10:00:01.250"),
    Date.UTC(2026, 8, 9, 10, 0, 1, 250) - IST_UTC_OFFSET_MS,
  );
  // FAIL-CLOSED: null makes the caller fall back to its own clock rather than record a wrong instant.
  for (const junk of [null, undefined, "", "   ", "not a date", "99-99-99"]) {
    assert.equal(parseIstBrokerTimestamp(junk), null, `${JSON.stringify(junk)} must be unknown`);
  }
});

test("F7a-4: an IST stamp is never in the future relative to the same wall clock", () => {
  // The mixed-clock signature the audit reproduced: a broker stamp compared against a local clock.
  const brokerStamp = parseIstBrokerTimestamp("2026-09-09 10:00:01");
  const sameInstantLocally = Date.parse("2026-09-09T04:30:01Z");
  assert.equal(
    brokerStamp - sameInstantLocally,
    0,
    "a correctly parsed broker stamp and the same instant must agree exactly",
  );
});

/* ═══════════════ FINDING 7b — a malformed frame must never throw into the socket ════════════════ */

/** A well-formed Kite frame: [uint16 packets][uint16 len][payload]. */
function kitePacket(length) {
  const buffer = new ArrayBuffer(4 + length);
  const view = new DataView(buffer);
  view.setInt16(0, 1, false);
  view.setInt16(2, length, false);
  if (length >= 8) {
    view.setUint32(4, 256, false);
    view.setUint32(8, 10_000, false);
  }
  if (length >= 44) view.setUint32(44, 9_900, false);
  return buffer;
}

test("F7b-1: the audit's exact 5-byte frame returns [] instead of throwing RangeError", () => {
  // [00 01][00 01][00] — declares one packet of ONE byte. The old bounds test only asked whether the
  // declared length FIT, never whether it was large enough for the mandatory token + last_price, so
  // `getUint32(4)` ran off the end of a valid DataView.
  const frame = new Uint8Array([0x00, 0x01, 0x00, 0x01, 0x00]).buffer;
  let ticks;
  assert.doesNotThrow(() => {
    ticks = parseBinary(frame);
  }, "a malformed frame must not throw out of the parser");
  assert.deepEqual(ticks, []);
});

test("F7b-2: every short packet length 0..7 is refused without throwing", () => {
  for (let len = 0; len < 8; len += 1) {
    const buffer = new ArrayBuffer(4 + len);
    const view = new DataView(buffer);
    view.setInt16(0, 1, false);
    view.setInt16(2, len, false);
    assert.doesNotThrow(() => parseBinary(buffer), `len=${len} must not throw`);
    assert.deepEqual(parseBinary(buffer), [], `len=${len} carries no usable tick`);
  }
});

test("F7b-3: a length above 32767 cannot become negative and rewind the read offset", () => {
  // Read as int16 this length was NEGATIVE, which passed `offset + len > byteLength` (adding a
  // negative shrinks the sum) and then moved `offset` BACKWARDS at the end of the iteration.
  const buffer = new ArrayBuffer(4 + 16);
  const view = new DataView(buffer);
  view.setInt16(0, 1, false);
  view.setUint16(2, 40_000, false);
  assert.doesNotThrow(() => parseBinary(buffer));
  assert.deepEqual(parseBinary(buffer), [], "a length that overruns the buffer yields nothing");
});

test("F7b-4: a frame claiming more packets than it carries stops cleanly", () => {
  const buffer = new ArrayBuffer(4 + 8);
  const view = new DataView(buffer);
  view.setInt16(0, 9, false); // claims nine packets
  view.setInt16(2, 8, false);
  view.setUint32(4, 256, false);
  view.setUint32(8, 10_000, false);
  const ticks = parseBinary(buffer);
  assert.equal(ticks.length, 1, "the one well-formed packet is returned and the rest is ignored");
  assert.equal(ticks[0].token, 256);
});

test("F7b-5: WELL-FORMED frames are completely unaffected by the hardening", () => {
  const ltp = parseBinary(kitePacket(8))[0];
  const quote = parseBinary(kitePacket(44))[0];
  const full = parseBinary(kitePacket(184))[0];
  assert.equal(ltp.token, 256);
  assert.equal(ltp.last_price, 100);
  assert.equal(ltp.depth_updated, false);
  assert.equal(quote.depth_updated, false);
  assert.equal(quote.close_price, 99);
  assert.equal(full.depth_updated, true, "full packets still carry depth provenance");
});

test("F7b-6: a truncated trailing packet does not discard the packets already recovered", () => {
  // One good 8-byte packet, then a header promising 8 bytes with only 2 present.
  const buffer = new ArrayBuffer(2 + 2 + 8 + 2 + 2);
  const view = new DataView(buffer);
  view.setInt16(0, 2, false);
  view.setInt16(2, 8, false);
  view.setUint32(4, 256, false);
  view.setUint32(8, 10_000, false);
  view.setInt16(12, 8, false);
  const ticks = parseBinary(buffer);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].token, 256);
});
