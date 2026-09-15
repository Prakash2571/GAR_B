/**
 * CONCURRENT BROKER SIGN-INS.
 *
 * The site is a shared console: anyone holding the passcode is a legitimate operator, and the
 * broker session they establish is shared process state. Two of them signing in at the same
 * time is ORDINARY, not an anomaly.
 *
 * The pending-login store used to hold one entry per broker, so the second person to click
 * "Connect Zerodha" silently destroyed the first person's in-flight login — and the first
 * operator's redirect came back refused with `state_mismatch`, an error that reads like
 * tampering and was really just a colleague. These tests pin the fixed behaviour.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PENDING_PER_BROKER,
  PendingLoginStore,
} from "../../dist/brokerAuth/pendingLogins.js";

test("two operators can sign into the SAME broker at once, and both complete", () => {
  const store = new PendingLoginStore();

  const alice = store.start("zerodha", { startedBy: "full" });
  const bob = store.start("zerodha", { startedBy: "full" });
  assert.notEqual(alice.nonce, bob.nonce);

  // Bob started second; Alice's redirect must STILL be claimable — this is the whole point.
  const aliceClaim = store.consume("zerodha", alice.nonce, { requireNonce: true });
  assert.equal(aliceClaim.ok, true, "the first operator's login must survive the second start");

  // And Bob's independently completes afterwards.
  const bobClaim = store.consume("zerodha", bob.nonce, { requireNonce: true });
  assert.equal(bobClaim.ok, true, "the second operator's login must also complete");
});

test("order does not matter: the second starter can finish first", () => {
  const store = new PendingLoginStore();
  const first = store.start("zerodha", { startedBy: "full" });
  const second = store.start("zerodha", { startedBy: "full" });

  assert.equal(store.consume("zerodha", second.nonce, { requireNonce: true }).ok, true);
  assert.equal(store.consume("zerodha", first.nonce, { requireNonce: true }).ok, true);
});

test("claiming one operator's login does not consume anyone else's", () => {
  const store = new PendingLoginStore();
  const a = store.start("zerodha", { startedBy: "full" });
  const b = store.start("zerodha", { startedBy: "full" });
  const c = store.start("zerodha", { startedBy: "full" });

  assert.equal(store.consume("zerodha", b.nonce, { requireNonce: true }).ok, true);
  // b is spent; a and c are untouched.
  assert.equal(store.consume("zerodha", b.nonce, { requireNonce: true }).ok, false);
  assert.equal(store.consume("zerodha", a.nonce, { requireNonce: true }).ok, true);
  assert.equal(store.consume("zerodha", c.nonce, { requireNonce: true }).ok, true);
});

test("concurrent DHAN sign-ins each spend only ONE entry", () => {
  const store = new PendingLoginStore();
  store.start("dhan", { startedBy: "full", consentId: "C1" });
  store.start("dhan", { startedBy: "full", consentId: "C2" });

  // Dhan round-trips no nonce, so entries are indistinguishable and any live one authorises
  // the exchange. The MOST RECENT is chosen, and only it is spent.
  const first = store.consume("dhan", null, { requireNonce: false });
  assert.equal(first.ok, true);
  assert.equal(first.pending.consentId, "C2", "the latest intent is claimed first");

  const second = store.consume("dhan", null, { requireNonce: false });
  assert.equal(second.ok, true);
  assert.equal(second.pending.consentId, "C1", "the earlier one must still be claimable");

  assert.equal(store.consume("dhan", null, { requireNonce: false }).ok, false);
});

test("a nonce minted for one broker can never claim the other broker's login", () => {
  const store = new PendingLoginStore();
  const zerodha = store.start("zerodha", { startedBy: "full" });
  store.start("dhan", { startedBy: "full" });

  // Entries are keyed by nonce, so the lookup MUST filter by broker or a Zerodha nonce could
  // claim a Dhan login (and vice versa).
  assert.deepEqual(store.consume("dhan", zerodha.nonce, { requireNonce: true }), {
    ok: false,
    reason: "state_mismatch",
  });
  // Both are still intact.
  assert.equal(store.isPending("zerodha"), true);
  assert.equal(store.isPending("dhan"), true);
  assert.equal(store.consume("zerodha", zerodha.nonce, { requireNonce: true }).ok, true);
});

test("the store is hard-bounded per broker, evicting the OLDEST first", () => {
  const store = new PendingLoginStore();
  const started = [];
  for (let i = 0; i < MAX_PENDING_PER_BROKER + 3; i += 1) {
    started.push(store.start("zerodha", { startedBy: "full" }));
  }

  // The three oldest were evicted to keep the cap.
  for (const evicted of started.slice(0, 3)) {
    assert.equal(
      store.consume("zerodha", evicted.nonce, { requireNonce: true }).ok,
      false,
      "an evicted entry must not be claimable",
    );
  }
  // Every surviving one still works — newest kept, because it is most likely still in use.
  for (const kept of started.slice(3)) {
    assert.equal(store.consume("zerodha", kept.nonce, { requireNonce: true }).ok, true);
  }
  assert.ok(MAX_PENDING_PER_BROKER >= 2, "concurrency requires room for at least two");
});

test("filling one broker's slots cannot evict the other broker's logins", () => {
  const store = new PendingLoginStore();
  const dhan = store.start("dhan", { startedBy: "full" });
  for (let i = 0; i < MAX_PENDING_PER_BROKER + 5; i += 1) {
    store.start("zerodha", { startedBy: "full" });
  }
  // The cap is PER BROKER, so a burst of Zerodha sign-ins must not starve Dhan.
  assert.equal(store.isPending("dhan"), true);
  assert.equal(store.consume("dhan", dhan.nonce, { requireNonce: false }).ok, true);
});

test("a lapsed attempt is reported as EXPIRED, and an absent one as never-started", () => {
  let now = 1_000_000;
  const store = new PendingLoginStore({ ttlMs: 600_000, now: () => now });

  // Nothing ever started.
  assert.deepEqual(store.consume("zerodha", "whatever", { requireNonce: true }), {
    ok: false,
    reason: "no_pending_login",
  });

  const entry = store.start("zerodha", { startedBy: "full" });
  now += 600_001;
  // Distinguishing these two tells the operator to try again rather than that nothing happened.
  assert.deepEqual(store.consume("zerodha", entry.nonce, { requireNonce: true }), {
    ok: false,
    reason: "login_expired",
  });
});

test("one operator's lapsed attempt does not refuse another's live one", () => {
  let now = 1_000_000;
  const store = new PendingLoginStore({ ttlMs: 600_000, now: () => now });
  const stale = store.start("zerodha", { startedBy: "full" });
  now += 590_000;
  const fresh = store.start("zerodha", { startedBy: "full" });
  now += 20_000; // `stale` has now lapsed; `fresh` has not.

  assert.equal(store.consume("zerodha", fresh.nonce, { requireNonce: true }).ok, true);
  assert.equal(store.consume("zerodha", stale.nonce, { requireNonce: true }).ok, false);
});

test("signing out clears EVERY pending login for that broker only", () => {
  const store = new PendingLoginStore();
  store.start("zerodha", { startedBy: "full" });
  store.start("zerodha", { startedBy: "full" });
  const dhan = store.start("dhan", { startedBy: "full" });

  store.clear("zerodha");
  assert.equal(store.isPending("zerodha"), false, "all of them, not just the newest");
  assert.equal(store.isPending("dhan"), true, "and the other broker is untouched");
  assert.equal(store.consume("dhan", dhan.nonce, { requireNonce: false }).ok, true);
});

test("a wrong nonce still consumes nothing, even with several logins in flight", () => {
  const store = new PendingLoginStore();
  const a = store.start("zerodha", { startedBy: "full" });
  const b = store.start("zerodha", { startedBy: "full" });
  const wrong = "x".repeat(a.nonce.length);

  assert.deepEqual(store.consume("zerodha", wrong, { requireNonce: true }), {
    ok: false,
    reason: "state_mismatch",
  });
  // Neither operator was denied by the bogus attempt.
  assert.equal(store.consume("zerodha", a.nonce, { requireNonce: true }).ok, true);
  assert.equal(store.consume("zerodha", b.nonce, { requireNonce: true }).ok, true);
});
