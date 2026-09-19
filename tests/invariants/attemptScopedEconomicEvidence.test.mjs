/**
 * ECONOMIC EVIDENCE BELONGS TO THE ATTEMPT THAT ACQUIRED IT.
 *
 * ── THE BUG THIS ELIMINATES ──────────────────────────────────────────────────────────────────
 *
 * The evidence that admits a live entry — funds/margin observation times, the broker/account/session
 * identity and the order-plan fingerprint — used to live in ONE mutable field on the gateway
 * (`private economicEvidence`). It was written by whichever attempt evaluated most recently and read
 * LATE, at POST time, by whichever attempt reached its send boundary:
 *
 *     attempt A evaluates         -> slot = A
 *     attempt B evaluates         -> slot = B      (A's evidence is gone)
 *     attempt A reaches pre_post  -> validates against B's freshness, identity and order plan
 *
 * The plan-fingerprint comparison would often have caught that and refused A — for the wrong reason,
 * and only by luck: two attempts on the same underlying and strikes can produce the same leg
 * fingerprint, and A would then have passed on B's freshness and B's account identity.
 *
 * The genuinely dangerous case needed no coincidence. The slot was set to `null` whenever an
 * admission was REFUSED, and the send boundary opens `if (!evidence) return null` — "nothing to
 * check". So B being refused erased A's evidence and turned A's send boundary into a silent no-op:
 * the expiry re-check that exists precisely to catch staleness between admission and transmit simply
 * did not run, and reported nothing.
 *
 * One-box serialisation made this unreachable in the shipped profile. It was never a property of the
 * evidence handling, which is why ownership is fixed here rather than the configuration documented.
 *
 * ── WHY THERE IS NO MAP AND NO CLEANUP ───────────────────────────────────────────────────────
 *
 * Evidence is now an immutable value captured in the closure of the attempt that produced it
 * (`sendBoundaryEconomics`). There is no slot to overwrite, no key to look up, nothing to evict and
 * nothing to leak: it becomes garbage with the attempt's own stack frame. A `Map<attemptId, …>` would
 * have been the weaker option — a lookup that can miss, return the wrong entry, or retain.
 *
 * ── WHAT `pre_post` HAS TO DO WITH IT ────────────────────────────────────────────────────────
 *
 * `entryEconomicEvidenceGap` in the order manager returns `null` for every stage except `pre_post`,
 * so the evidence is consulted at exactly one checkpoint: the final one before transmit, while the
 * attempt still holds no exposure. These tests therefore drive the same function that checkpoint
 * drives, and a structural assertion below pins that `pre_post` remains the only stage that consults
 * it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { entryEconomicSendBoundaryGap } from "../../dist/box/entryEconomicEvidence.js";

const src = (rel) => readFileSync(new URL(`../../src/box/${rel}`, import.meta.url), "utf8");

/* ───────────────────────────── fixtures ───────────────────────────── */

const IDENTITY_A = { broker: "zerodha", account_ref: "ACCOUNT-A", session_id: "session-A" };
const IDENTITY_B = { broker: "zerodha", account_ref: "ACCOUNT-B", session_id: "session-B" };

/** A bounded LIMIT request; only the fields the plan fingerprint reads matter. */
function request({ tradingsymbol = "NIFTY26SEP24500CE", side = "BUY", quantity = 65, limit = 12.5 } = {}) {
  return {
    client_order_id: `BOX:${tradingsymbol}:${side}`,
    role: "k1_ce",
    trade_id: "trade-1",
    attempt_id: "attempt-x",
    purpose: "ENTRY",
    phase: "ENTRY",
    exchange: "NFO",
    tradingsymbol,
    token: 1,
    side,
    quantity,
    pricing: { order_type: "LIMIT", limit_price: limit, max_chase_ticks: 2, tick_size: 0.05 },
  };
}

/**
 * Build evidence exactly as `evaluateEntryEconomics` does, for one attempt.
 *
 * `planFingerprint` is the pipe-joined per-leg fingerprint the real code produces; the boundary
 * checks membership of the single leg it is about to POST, so a one-leg plan is sufficient and keeps
 * the intent of each case visible.
 */
function evidenceFor({ attemptId, identity, observedAtMono, planFingerprint, maxAgeMs = 5_000 }) {
  return {
    fundsObservedAtMono: observedAtMono,
    marginObservedAtMono: observedAtMono,
    fundsMaxAgeMs: maxAgeMs,
    marginMaxAgeMs: maxAgeMs,
    planFingerprint,
    identity,
    fundsRequired: true,
    marginRequired: true,
    attemptId,
  };
}

/** The real fingerprint for a request, taken from the boundary's own refusal text. */
function legFingerprint(req) {
  const gap = entryEconomicSendBoundaryGap({
    evidence: evidenceFor({
      attemptId: "probe",
      identity: IDENTITY_A,
      observedAtMono: 1_000,
      planFingerprint: "definitely-not-this-leg",
    }),
    request: req,
    currentIdentity: IDENTITY_A,
    monoNow: 1_100,
  });
  assert.ok(gap, "fixture: a mismatched plan must refuse so the leg fingerprint can be read back");
  const match = /fetched for\): (.+)$/.exec(gap);
  assert.ok(match, `fixture: could not read the leg fingerprint out of: ${gap}`);
  return match[1];
}

/* ══════════════════ 1. the interleaving regression — the core case ══════════════════ */

/**
 * Two attempts, deliberately interleaved: B evaluates AFTER A but BEFORE A reaches its send boundary.
 * That is the exact ordering the old single slot could not survive.
 *
 * The two attempts are made distinguishable on EVERY axis the boundary checks — different account and
 * session identity, different order plan, and different freshness — so that a contaminated read
 * cannot coincidentally look correct.
 */
test("INTERLEAVED: attempt A validates only A's evidence, and B only B's", () => {
  const reqA = request({ tradingsymbol: "NIFTY26SEP24500CE", quantity: 65, limit: 12.5 });
  const reqB = request({ tradingsymbol: "NIFTY26SEP24600CE", quantity: 130, limit: 8.25 });

  // 1-3. Attempt A evaluates its economics and captures evidence A.
  const evidenceA = evidenceFor({
    attemptId: "attempt-A",
    identity: IDENTITY_A,
    observedAtMono: 10_000,
    planFingerprint: legFingerprint(reqA),
  });

  // 4-6. Attempt B evaluates AFTER A. Under the old model this overwrote the single slot.
  const evidenceB = evidenceFor({
    attemptId: "attempt-B",
    identity: IDENTITY_B,
    observedAtMono: 20_000,
    planFingerprint: legFingerprint(reqB),
  });

  // 9-10. A reaches pre_post. It must be admitted on ITS OWN evidence: its own identity, its own
  // plan, its own freshness. Under the old model this read B's slot and refused on B's plan.
  const gapA = entryEconomicSendBoundaryGap({
    evidence: evidenceA,
    request: reqA,
    currentIdentity: IDENTITY_A,
    monoNow: 10_500,
  });
  assert.equal(gapA, null, `attempt A must be admitted on its own evidence, got: ${gapA}`);

  // 11-12. B reaches pre_post afterwards and is likewise judged only on B's evidence.
  const gapB = entryEconomicSendBoundaryGap({
    evidence: evidenceB,
    request: reqB,
    currentIdentity: IDENTITY_B,
    monoNow: 20_500,
  });
  assert.equal(gapB, null, `attempt B must be admitted on its own evidence, got: ${gapB}`);
});

test("A must not PASS because B is healthy, and must not FAIL because B is stale", () => {
  const reqA = request({ tradingsymbol: "NIFTY26SEP24500CE" });
  const fingerprintA = legFingerprint(reqA);

  // A's own evidence is STALE. A must be refused on that, regardless of B being perfectly fresh.
  const staleA = evidenceFor({ attemptId: "attempt-A", identity: IDENTITY_A, observedAtMono: 1_000, planFingerprint: fingerprintA });
  const freshB = evidenceFor({ attemptId: "attempt-B", identity: IDENTITY_A, observedAtMono: 99_000, planFingerprint: fingerprintA });
  const refusedA = entryEconomicSendBoundaryGap({ evidence: staleA, request: reqA, currentIdentity: IDENTITY_A, monoNow: 99_500 });
  assert.ok(refusedA, "A's own stale evidence must refuse A");
  assert.match(refusedA, /attempt-A/, "and the refusal must name A, not a sibling");
  assert.match(refusedA, /EXPIRED before transmit/);

  // The reverse: B is stale, A is fresh. A must still be admitted — B's staleness is not A's problem.
  const admittedA = entryEconomicSendBoundaryGap({ evidence: freshB, request: reqA, currentIdentity: IDENTITY_A, monoNow: 99_500 });
  assert.equal(admittedA, null, "a sibling's staleness must not refuse an attempt with fresh evidence");
});

/**
 * THE OLD MODEL, SIMULATED, TO SHOW THE HAZARD WAS REAL.
 *
 * The pure function cannot reproduce a gateway field, so this reproduces what that field DID: a single
 * slot holding whichever evidence was written last, read at A's send boundary. Both halves of the
 * damage are demonstrated, and the second is the one that mattered.
 */
test("OLD MODEL: a shared slot gave attempt A the wrong verdict, both ways", () => {
  const reqA = request({ tradingsymbol: "NIFTY26SEP24500CE", quantity: 65, limit: 12.5 });
  const reqB = request({ tradingsymbol: "NIFTY26SEP24600CE", quantity: 130, limit: 8.25 });

  // One mutable slot, exactly as the gateway field behaved.
  let sharedSlot = null;
  sharedSlot = evidenceFor({ attemptId: "attempt-A", identity: IDENTITY_A, observedAtMono: 10_000, planFingerprint: legFingerprint(reqA) });
  sharedSlot = evidenceFor({ attemptId: "attempt-B", identity: IDENTITY_B, observedAtMono: 20_000, planFingerprint: legFingerprint(reqB) });

  // (a) A is now judged on B's evidence and refused — for a reason that is not about A at all.
  const contaminated = entryEconomicSendBoundaryGap({
    evidence: sharedSlot,
    request: reqA,
    currentIdentity: IDENTITY_A,
    monoNow: 20_500,
  });
  assert.ok(contaminated, "the shared slot made A fail on B's evidence");
  assert.match(contaminated, /attempt-B/, "and the refusal is about B, while A was the attempt posting");

  /*
   * (b) THE DANGEROUS HALF. An admission that was REFUSED nulled the slot. A's send boundary then
   * short-circuits on `if (!evidence) return null` and performs NO check — so A's own genuinely
   * EXPIRED funds and margin evidence sails through the one checkpoint built to catch it.
   */
  sharedSlot = null; // B's admission was refused
  const silentlyUnchecked = entryEconomicSendBoundaryGap({
    evidence: sharedSlot,
    request: reqA,
    currentIdentity: IDENTITY_A,
    monoNow: 999_999, // A's evidence is ancient by now
  });
  assert.equal(silentlyUnchecked, null, "the old model performed no check at all here");

  // Under the new ownership, A holds its own evidence and that same moment refuses.
  const ownEvidence = evidenceFor({ attemptId: "attempt-A", identity: IDENTITY_A, observedAtMono: 10_000, planFingerprint: legFingerprint(reqA) });
  const nowRefused = entryEconomicSendBoundaryGap({
    evidence: ownEvidence,
    request: reqA,
    currentIdentity: IDENTITY_A,
    monoNow: 999_999,
  });
  assert.ok(nowRefused, "attempt-scoped evidence catches what the shared slot silently skipped");
  assert.match(nowRefused, /attempt-A/);
  assert.match(nowRefused, /EXPIRED before transmit/);
});

/* ══════════════════ 2. an attempt cannot be satisfied by another's evidence ══════════════════ */

test("evidence acquired for a DIFFERENT account cannot admit this attempt", () => {
  const reqA = request();
  const gap = entryEconomicSendBoundaryGap({
    evidence: evidenceFor({ attemptId: "attempt-B", identity: IDENTITY_B, observedAtMono: 10_000, planFingerprint: legFingerprint(reqA) }),
    request: reqA,
    // The session/account in force is A's; the evidence was acquired under B's.
    currentIdentity: IDENTITY_A,
    monoNow: 10_100,
  });
  assert.ok(gap, "evidence from another account must not admit this attempt");
  assert.match(gap, /no longer applies/);
  assert.match(gap, /attempt-B/, "the refusal names the attempt the evidence belonged to");
});

test("evidence acquired for a DIFFERENT order plan cannot admit this attempt", () => {
  const reqA = request({ tradingsymbol: "NIFTY26SEP24500CE", quantity: 65 });
  const reqB = request({ tradingsymbol: "NIFTY26SEP24600CE", quantity: 130 });
  const gap = entryEconomicSendBoundaryGap({
    evidence: evidenceFor({ attemptId: "attempt-B", identity: IDENTITY_A, observedAtMono: 10_000, planFingerprint: legFingerprint(reqB) }),
    request: reqA,
    currentIdentity: IDENTITY_A,
    monoNow: 10_100,
  });
  assert.ok(gap, "the margin figure was computed for a different plan");
  assert.match(gap, /order plan CHANGED/);
});

test("a quantity or limit-price change alone breaks the plan binding", () => {
  const priced = request({ quantity: 65, limit: 12.5 });
  const fingerprint = legFingerprint(priced);
  for (const changed of [request({ quantity: 130, limit: 12.5 }), request({ quantity: 65, limit: 99.0 })]) {
    const gap = entryEconomicSendBoundaryGap({
      evidence: evidenceFor({ attemptId: "attempt-A", identity: IDENTITY_A, observedAtMono: 10_000, planFingerprint: fingerprint }),
      request: changed,
      currentIdentity: IDENTITY_A,
      monoNow: 10_100,
    });
    assert.ok(gap, "evidence must not survive a change to the quantity or the limit price");
    assert.match(gap, /order plan CHANGED/);
  }
});

/* ══════════════════ 3. fail-closed, and the one legitimate null ══════════════════ */

test("STALE funds and STALE margin each refuse independently", () => {
  const req = request();
  const fingerprint = legFingerprint(req);
  const base = { attemptId: "attempt-A", identity: IDENTITY_A, planFingerprint: fingerprint };

  const fundsOnly = { ...evidenceFor({ ...base, observedAtMono: 1_000 }), marginRequired: false, marginObservedAtMono: null };
  const fundsGap = entryEconomicSendBoundaryGap({ evidence: fundsOnly, request: req, currentIdentity: IDENTITY_A, monoNow: 50_000 });
  assert.match(fundsGap ?? "", /available-funds evidence EXPIRED/);

  const marginOnly = { ...evidenceFor({ ...base, observedAtMono: 1_000 }), fundsRequired: false, fundsObservedAtMono: null };
  const marginGap = entryEconomicSendBoundaryGap({ evidence: marginOnly, request: req, currentIdentity: IDENTITY_A, monoNow: 50_000 });
  assert.match(marginGap ?? "", /planned-margin evidence EXPIRED/);
});

/**
 * `null` evidence permits the POST, and that is correct — but it now means exactly ONE thing.
 *
 * Under the old model it also meant "a sibling attempt's admission was refused and nulled the shared
 * slot", which silently disabled this attempt's expiry re-check. That second meaning is gone: the
 * value arrives from the attempt's own closure, and an attempt whose own admission was refused never
 * reaches a send boundary at all (`simulateLeggingEntry` returns REFUSED_BEFORE_SUBMIT before the
 * guard is built). A structural assertion below pins that there is no field for anything else to
 * write.
 */
test("null evidence means only 'no economic control enabled for THIS attempt'", () => {
  assert.equal(
    entryEconomicSendBoundaryGap({ evidence: null, request: request(), currentIdentity: IDENTITY_A, monoNow: 1 }),
    null,
  );
});

/* ══════════════════ 4. structural: no shared slot can come back ══════════════════ */

test("the gateway holds NO economic-evidence field, and no single-slot equivalent", () => {
  const gw = src("executionGateway.ts");
  /*
   * Scanned with comments STRIPPED. The gateway deliberately names these forbidden shapes in prose,
   * to tell the next reader not to reintroduce them; a banned identifier in a comment is the warning
   * working, whereas one in code is the regression.
   */
  const code = gw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(
    code.split("this.economicEvidence").length - 1,
    0,
    "the mutable single slot must be gone, not merely bypassed",
  );
  for (const banned of [
    "private economicEvidence",
    "latestEconomicEvidence",
    "currentEconomicEvidence",
    "Map<string, EntryEconomicEvidence>",
    "Map<attemptId",
  ]) {
    assert.ok(!code.includes(banned), `\`${banned}\` reintroduces shared or keyed evidence state`);
  }
  // `lastEconomicReport` is a DIFFERENT thing and must survive: a status projection, never an input.
  assert.ok(gw.includes("private lastEconomicReport"), "the status projection must remain");
  assert.match(gw, /lastEconomicReport[\s\S]{0,200}?Never a correctness input|for status/);
});

test("the evidence reaches the boundary through the attempt's own closure", () => {
  const gw = src("executionGateway.ts");
  // Captured as an immutable local in the attempt's frame...
  assert.match(gw, /const attemptEconomicEvidence: EntryEconomicEvidence \| null = economics\?\.evidence \?\? null/);
  // ...and passed explicitly into the boundary from the closure, not read from `this`.
  assert.match(
    gw,
    /sendBoundaryEconomics: \(candidateRequest\?: BrokerOrderRequest\) =>\s*\n?\s*this\.economicSendBoundary\(attemptEconomicEvidence, candidateRequest \?\? request\)/,
  );
  // The producer returns it rather than storing it.
  assert.match(gw, /return \{ report, evidence \};/);
});

test("pre_post remains the ONLY stage that consults economic evidence", () => {
  const om = src("orderManager.ts");
  const start = om.indexOf("private entryEconomicEvidenceGap");
  assert.ok(start > 0, "fixture: the gap function must be locatable");
  const body = om.slice(start, om.indexOf("\n  }", om.indexOf("sendBoundaryEconomics(request)", start)));
  assert.match(body, /if \(stage !== "pre_post"\) return null;/, "every earlier stage must short-circuit");
});

/* ══════════════════ 5. reduction paths do not consume it ══════════════════ */

/**
 * Economic evidence is an ENTRY admission concern. This asserts structurally that the new ownership
 * is reachable only from the entry send boundary — stronger than testing three purposes, because it
 * also covers any purpose added later.
 */
test("no reduction path consumes economic evidence", () => {
  const om = src("orderManager.ts");
  const start = om.indexOf("canManageExposure(): boolean {");
  const reasonFn = om.indexOf("exposureReductionBlockReason(): string | null {");
  assert.ok(start > 0 && reasonFn > start, "fixture: both reduction predicates must be locatable");
  const after = om.slice(reasonFn);
  const reductionBody = om.slice(start, reasonFn) + after.slice(0, after.indexOf("\n  }\n"));
  for (const token of ["sendBoundaryEconomics", "economicEvidenceGap", "EntryEconomicEvidence"]) {
    assert.ok(!reductionBody.includes(token), `a reduction must not depend on ${token}`);
  }

  // `entryEconomicEvidenceGap` is fed only from the ENTRY guard evaluation, which `submit()` reaches
  // only under `purpose === "ENTRY"`.
  assert.equal(
    om.split("entryEconomicEvidenceGap(").length - 1,
    2,
    "exactly one declaration and one call site, both on the entry guard path",
  );

  // The exit, cancel and flatten paths in the gateway must not have acquired the boundary either.
  const gw = src("executionGateway.ts");
  const exitStart = gw.indexOf('stableAttemptId(args.position.id, args.detectedAt, "EXIT")');
  assert.ok(exitStart > 0, "fixture: the live exit path must be locatable");
  const exitBody = gw.slice(exitStart, exitStart + 6_000);
  assert.ok(
    !exitBody.includes("sendBoundaryEconomics") && !exitBody.includes("economicSendBoundary"),
    "the EXIT path must not require economic evidence to reduce owned exposure",
  );
});
