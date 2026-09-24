/**
 * AN UNAUTHENTICATED CALLBACK MUST NOT BE ABLE TO DESTROY SOMEONE'S SIGN-IN.
 *
 * The broker callback cannot be authenticated — the session cookie is SameSite=Strict, so the browser
 * arriving from Zerodha or Dhan sends nothing. Zerodha round-trips our nonce, so a caller must prove it
 * holds one, and `inAppLogin.test.mjs` already pins that a FAILED nonce check consumes nothing.
 *
 * DHAN ROUND-TRIPS NOTHING OF OURS, and that asymmetry is where the defect lived: any caller with a
 * non-empty `tokenId` reached the store, and the store deleted the newest pending login BEFORE the token
 * exchange was attempted. So a junk callback fired while an operator was signing in consumed their
 * attempt, and their real redirect arrived to "your login expired". Repeatable by anyone who could reach
 * the URL. There was no Dhan equivalent of the Zerodha test, which is why it survived.
 *
 * Deleting up front never bought the safety it appeared to. The property that matters is that ONE
 * SUCCESSFUL exchange happens per initiation; deleting first only guaranteed that a FAILED one also
 * destroyed the initiation. Hence claim → exchange → commit/release, pinned here.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { CLAIM_LAPSE_MS, PendingLoginStore } = await import("../../dist/brokerAuth/pendingLogins.js");

function store({ now } = {}) {
  const clock = now ?? { t: 1_000 };
  let n = 0;
  return {
    clock,
    store: new PendingLoginStore({
      now: () => clock.t,
      mintNonce: () => `nonce-${(n += 1)}`.padEnd(43, "0"),
    }),
  };
}

const DHAN = { requireNonce: false };
const ZERODHA = { requireNonce: true };

/* ───────────── the reported defect: a junk Dhan callback ───────────── */

test("a junk Dhan callback whose exchange FAILS leaves the operator's login intact", async () => {
  const { store: s } = store();
  const started = s.start("dhan", { startedBy: "full" });

  // The attacker's callback: no proof of anything, just a non-empty tokenId.
  const attacker = s.claim("dhan", null, DHAN);
  assert.equal(attacker.ok, true, "with no nonce to check, the claim itself cannot be refused");

  // Their token exchange fails, because their tokenId is junk.
  s.release(attacker.claim);

  // THE OPERATOR'S REAL REDIRECT NOW ARRIVES.
  const operator = s.claim("dhan", null, DHAN);
  assert.equal(
    operator.ok,
    true,
    "THE DEFECT: the operator's pending login had been deleted by a caller that proved nothing, so " +
      "their own redirect was refused as expired",
  );
  assert.equal(operator.claim.pending.nonce, started.nonce, "it is the same initiation, not a new one");
  assert.equal(s.commit(operator.claim), true);
  assert.equal(s.isPending("dhan"), false, "and a successful sign-in spends it");
});

test("a flood of failing Dhan callbacks cannot exhaust the operator's login", async () => {
  const { store: s } = store();
  s.start("dhan", { startedBy: "full" });
  for (let i = 0; i < 50; i += 1) {
    const attempt = s.claim("dhan", null, DHAN);
    assert.equal(attempt.ok, true);
    s.release(attempt.claim);
  }
  assert.equal(s.isPending("dhan"), true, "the initiation survives any number of failed attempts");
  assert.equal(s.claim("dhan", null, DHAN).ok, true);
});

/* ───────────── replay protection is preserved ───────────── */

test("a SUCCESSFUL Dhan exchange is single-use: the replay finds nothing", () => {
  const { store: s } = store();
  s.start("dhan", { startedBy: "full" });

  const first = s.claim("dhan", null, DHAN);
  assert.equal(first.ok, true);
  assert.equal(s.commit(first.claim), true);

  const replay = s.claim("dhan", null, DHAN);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "no_pending_login");
});

test("a second callback cannot start a second exchange while one is IN FLIGHT", () => {
  // Otherwise the two-phase protocol would trade a denial-of-login for an amplifier: one initiation
  // driving many concurrent outbound token exchanges.
  const { store: s } = store();
  s.start("dhan", { startedBy: "full" });

  const inFlight = s.claim("dhan", null, DHAN);
  assert.equal(inFlight.ok, true);

  const concurrent = s.claim("dhan", null, DHAN);
  assert.equal(concurrent.ok, false);
  assert.equal(concurrent.reason, "login_in_progress");

  // The first exchange completes; the initiation is spent exactly once.
  assert.equal(s.commit(inFlight.claim), true);
});

test("a claim that is never resolved LAPSES, so a crash cannot lock an operator out", () => {
  const { store: s, clock } = store();
  s.start("dhan", { startedBy: "full" });

  const abandoned = s.claim("dhan", null, DHAN);
  assert.equal(abandoned.ok, true);
  assert.equal(s.claim("dhan", null, DHAN).ok, false, "reserved while in flight");

  clock.t += CLAIM_LAPSE_MS;
  const retry = s.claim("dhan", null, DHAN);
  assert.equal(retry.ok, true, "an exchange that never answered must not hold the login forever");

  // The abandoned claim must no longer be able to disturb the new one.
  s.release(abandoned.claim);
  assert.equal(s.isPending("dhan"), true);
  assert.equal(s.commit(retry.claim), true);
});

/* ───────────── Zerodha keeps its stronger proof ───────────── */

test("Zerodha still requires the nonce, and a wrong one claims nothing", () => {
  const { store: s } = store();
  const started = s.start("zerodha", { startedBy: "full" });

  assert.equal(s.claim("zerodha", null, ZERODHA).reason, "state_missing");
  assert.equal(s.claim("zerodha", "wrong".padEnd(43, "0"), ZERODHA).reason, "state_mismatch");
  assert.equal(s.isPending("zerodha"), true, "a failed proof consumes nothing");

  const real = s.claim("zerodha", started.nonce, ZERODHA);
  assert.equal(real.ok, true);
  assert.equal(s.commit(real.claim), true);
});

test("a Zerodha exchange that fails releases the initiation for a retry", () => {
  const { store: s } = store();
  const started = s.start("zerodha", { startedBy: "full" });

  const attempt = s.claim("zerodha", started.nonce, ZERODHA);
  assert.equal(attempt.ok, true);
  s.release(attempt.claim);

  // Kite can legitimately fail an exchange (a clock problem, a transient 5xx). The operator should be
  // able to click the link again rather than start a whole new consent.
  const retry = s.claim("zerodha", started.nonce, ZERODHA);
  assert.equal(retry.ok, true);
});

test("a replayed Zerodha nonce is refused while its exchange is in flight", () => {
  const { store: s } = store();
  const started = s.start("zerodha", { startedBy: "full" });
  const first = s.claim("zerodha", started.nonce, ZERODHA);
  assert.equal(first.ok, true);
  const replay = s.claim("zerodha", started.nonce, ZERODHA);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "login_in_progress");
});

/* ───────────── the properties the old tests relied on still hold ───────────── */

test("concurrent sign-ins stay independent", () => {
  const { store: s } = store();
  const first = s.start("dhan", { startedBy: "full" });
  const second = s.start("dhan", { startedBy: "trade" });

  // The newest intent is the one most likely being completed right now.
  const claimed = s.claim("dhan", null, DHAN);
  assert.equal(claimed.claim.pending.nonce, second.nonce);
  s.commit(claimed.claim);

  const other = s.claim("dhan", null, DHAN);
  assert.equal(other.ok, true, "a colleague's parallel attempt is untouched");
  assert.equal(other.claim.pending.nonce, first.nonce);
});

test("the two brokers never interfere", () => {
  const { store: s } = store();
  const zerodha = s.start("zerodha", { startedBy: "full" });
  s.start("dhan", { startedBy: "full" });

  const dhanClaim = s.claim("dhan", null, DHAN);
  assert.equal(dhanClaim.ok, true);
  s.commit(dhanClaim.claim);

  assert.equal(s.isPending("zerodha"), true);
  assert.equal(s.claim("zerodha", zerodha.nonce, ZERODHA).ok, true);
});

test("an unsolicited callback for either broker is still refused", () => {
  const { store: s } = store();
  assert.equal(s.claim("dhan", null, DHAN).reason, "no_pending_login");
  assert.equal(s.claim("zerodha", "anything".padEnd(43, "0"), ZERODHA).reason, "no_pending_login");
});

test("an expired initiation is reported as expired, not as absent", () => {
  const { store: s, clock } = store();
  s.start("dhan", { startedBy: "full" });
  clock.t += 10 * 60_000 + 1;
  const result = s.claim("dhan", null, DHAN);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "login_expired");
});

test("commit on an entry that has already gone is not an error", () => {
  const { store: s } = store();
  s.start("dhan", { startedBy: "full" });
  const claimed = s.claim("dhan", null, DHAN);
  s.clear("dhan");
  assert.equal(s.commit(claimed.claim), false, "there is simply nothing left to spend");
});
