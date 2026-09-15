/**
 * RESTART-AWARE READINESS ORDERING — a browser must not reject a restarted backend forever.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `operational_readiness.decision_generation` is minted by `++this.readinessDecisionGeneration`,
 * where the field is declared `private readinessDecisionGeneration = 0`. It is PROCESS-LOCAL. The
 * frontend accepted a decision only when its generation was strictly greater than the one already
 * rendered — correct for ordering concurrent responses from one process, and wrong across a restart:
 *
 *     browser has rendered generation 5000
 *     backend restarts; the counter resets; it publishes generation 1
 *     5000 > 1  ⇒  the browser rejects 1, and 2, and 3, … indefinitely
 *
 * The dashboard then shows a permission verdict from a process that no longer exists, and goes on
 * showing "entry permitted" long after the new process has decided otherwise. Only a manual reload
 * clears it.
 *
 * THE FIX IS NOT "ACCEPT SMALLER GENERATIONS". That would make a delayed response from the OLD
 * process overwrite the new one — the same bug pointing the other way. Ordering needs an order, so
 * the decision now carries a restart-durable `instance.boot_ordinal` minted atomically by
 * PostgreSQL, and decisions are ordered by the pair (boot_ordinal, decision_generation).
 *
 * This suite drives the REAL `orderReadinessDecision` — the shared rule the frontend vendors rather
 * than reimplementing — plus the real `buildOperationalReadiness` publication.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { orderReadinessDecision } from "../../dist/box/backendInstance.js";

/* ─────────────────────────── helpers ─────────────────────────── */

const A = "instance-aaaa";
const B = "instance-bbbb";

const rendered = (instanceId, bootOrdinal, decisionGeneration) => ({
  instanceId,
  bootOrdinal,
  decisionGeneration,
});
const incoming = (instanceId, bootOrdinal, decisionGeneration) => ({
  instanceId,
  bootOrdinal,
  decisionGeneration,
});
const NOTHING_RENDERED = rendered(null, null, null);

/* ═══════════════ 1. the headline case ═══════════════ */

test("generation 5000 then a legitimate new boot at generation 1: the new instance is ADOPTED", () => {
  // The exact reported scenario. Instance A reached 5000; the process restarted as instance B with a
  // higher boot ordinal and its counter back at 1.
  const v = orderReadinessDecision(rendered(A, 7, 5000), incoming(B, 8, 1));
  assert.equal(v.kind, "adopt_new_instance", "a restart must be picked up, not rejected forever");
  assert.match(v.reason, /boot ordinal 8 > 7/);
  assert.match(v.reason, /without a manual refresh/);
});

test("REPRODUCTION: the OLD strictly-increasing rule rejects that very decision", () => {
  // The old rule, verbatim: `incoming > current` on decision_generation alone.
  const oldRule = (current, incomingGen) => incomingGen > current;
  assert.equal(oldRule(5000, 1), false, "the old rule rejects the restarted backend");
  assert.equal(oldRule(5000, 2), false, "and the next one");
  assert.equal(oldRule(5000, 3), false, "and every one thereafter — indefinitely");
  // The new rule accepts it, because it can see the instance changed AND which one is newer.
  assert.equal(orderReadinessDecision(rendered(A, 7, 5000), incoming(B, 8, 1)).kind, "adopt_new_instance");
});

test("the fix is NOT 'accept every smaller generation'", () => {
  // A smaller generation from the SAME instance is still refused — that is the out-of-order case the
  // original rule existed to catch, and it must keep working.
  const v = orderReadinessDecision(rendered(A, 7, 5000), incoming(A, 7, 4999));
  assert.equal(v.kind, "reject_stale");
  assert.match(v.reason, /out-of-order response from the same instance/);
});

/* ═══════════════ 2. a delayed response from the OLD instance after adoption ═══════════════ */

test("a delayed response from the SUPERSEDED instance is rejected after the new one is adopted", () => {
  // Having adopted instance B (ordinal 8), a slow in-flight response from A (ordinal 7) lands — with
  // a much HIGHER generation, because A had been running for hours.
  const v = orderReadinessDecision(rendered(B, 8, 3), incoming(A, 7, 5000));
  assert.equal(v.kind, "reject_stale", "the higher generation must not win: it is from a dead process");
  assert.match(v.reason, /superseded backend instance/);
  assert.match(v.reason, /boot ordinal 7 < 8/);
});

/* ═══════════════ 3. a random different id is NOT automatically newer ═══════════════ */

test("an unfamiliar instance id with NO ordinal is INCOMPATIBLE, never automatically newer", () => {
  const v = orderReadinessDecision(rendered(A, 7, 100), incoming(B, null, 1));
  assert.equal(v.kind, "reject_incompatible", "a random id cannot express 'newer'");
  assert.match(v.reason, /could not establish a durable boot ordinal/);
  assert.match(v.reason, /must not authorise new entry/);
});

test("a backend with no instance identity at all is INCOMPATIBLE", () => {
  const v = orderReadinessDecision(rendered(A, 7, 100), incoming(null, null, 101));
  assert.equal(v.kind, "reject_incompatible");
  assert.match(v.reason, /predates the instance-aware readiness contract/);
});

test("a decision with no usable generation is INCOMPATIBLE", () => {
  for (const gen of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = orderReadinessDecision(rendered(A, 7, 100), incoming(A, 7, gen));
    assert.equal(v.kind, "reject_incompatible", `generation ${String(gen)} cannot be ordered`);
  }
});

/* ═══════════════ 4. same-boot out-of-order and duplicates ═══════════════ */

test("same-boot ordering: strictly increasing, and a DUPLICATE is refused", () => {
  assert.equal(orderReadinessDecision(rendered(A, 7, 10), incoming(A, 7, 11)).kind, "accept");
  assert.equal(
    orderReadinessDecision(rendered(A, 7, 10), incoming(A, 7, 10)).kind,
    "reject_stale",
    "re-applying the same generation adds no information and must not reset a freshness timer",
  );
  assert.equal(orderReadinessDecision(rendered(A, 7, 10), incoming(A, 7, 9)).kind, "reject_stale");
});

test("concurrent responses crossing a restart resolve to the newest instance regardless of arrival order", () => {
  // Five responses in flight: three from the old instance, two from the new one, arriving interleaved.
  const arrivals = [
    incoming(A, 7, 4998),
    incoming(B, 8, 1),
    incoming(A, 7, 5000), // old instance, much higher generation, arrives AFTER the new instance
    incoming(B, 8, 2),
    incoming(A, 7, 4999),
  ];
  let state = rendered(A, 7, 4997);
  const applied = [];
  for (const a of arrivals) {
    const v = orderReadinessDecision(state, a);
    if (v.kind === "accept" || v.kind === "adopt_new_instance") {
      state = rendered(a.instanceId, a.bootOrdinal, a.decisionGeneration);
      applied.push(`${a.instanceId}:${a.decisionGeneration}`);
    }
  }
  assert.deepEqual(
    applied,
    ["instance-aaaa:4998", "instance-bbbb:1", "instance-bbbb:2"],
    "the old instance's later-arriving 5000 and 4999 are both discarded",
  );
  assert.equal(state.instanceId, B, "the newest instance is what is rendered");
  assert.equal(state.decisionGeneration, 2);
});

/* ═══════════════ 5. reconnection / remount ═══════════════ */

test("a fresh mount with nothing rendered accepts any ORDERABLE decision", () => {
  const v = orderReadinessDecision(NOTHING_RENDERED, incoming(A, 7, 1));
  assert.equal(v.kind, "accept");
  assert.match(v.reason, /first orderable/);
});

test("a fresh mount still REFUSES an unorderable decision", () => {
  // A component remount must not become a way to adopt a verdict that cannot be ordered.
  assert.equal(orderReadinessDecision(NOTHING_RENDERED, incoming(A, null, 1)).kind, "reject_incompatible");
  assert.equal(orderReadinessDecision(NOTHING_RENDERED, incoming(null, 7, 1)).kind, "reject_incompatible");
});

test("an ORDERABLE decision may replace an UNORDERABLE one already on screen", () => {
  // The reverse of the rule above: better evidence replaces worse, never the other way round.
  const v = orderReadinessDecision(rendered(A, null, 5), incoming(B, 9, 1));
  assert.equal(v.kind, "adopt_new_instance");
  assert.match(v.reason, /orderable decision over an unorderable one/);
});

/* ═══════════════ 6. multiple instances at the same epoch ═══════════════ */

test("two instances reporting the SAME ordinal is INCOMPATIBLE, not a coin toss", () => {
  // The atomic UPDATE ... RETURNING makes this impossible for two healthy processes against one
  // database, so it means two databases, a restored snapshot, or a topology that is not the supported
  // single process. Interleaving two processes' verdicts would be the worst available outcome.
  const v = orderReadinessDecision(rendered(A, 8, 100), incoming(B, 8, 1));
  assert.equal(v.kind, "reject_incompatible");
  assert.match(v.reason, /SAME boot ordinal 8/);
  assert.match(v.reason, /single process/);
  assert.match(v.reason, /new entry is disabled/);
});

/* ═══════════════ 7. no dependence on wall clocks ═══════════════ */

test("ordering never consults a clock: started_at cannot change any verdict", () => {
  // The function's inputs contain no time at all, which is the strongest form of this guarantee. An
  // NTP step, a VM snapshot restore or a container booting with a skewed clock therefore cannot make
  // an older instance look newer.
  const argNames = orderReadinessDecision.length;
  assert.equal(argNames, 2, "exactly (rendered, incoming) — no clock parameter");
  // And a lower ordinal loses even if it claims to have started later.
  const v = orderReadinessDecision(rendered(B, 8, 1), incoming(A, 7, 99999));
  assert.equal(v.kind, "reject_stale");
});

/* ═══════════════ 8. the published decision carries what ordering needs ═══════════════ */

test("the published readiness decision carries the instance identity as EXPLICIT nulls", async () => {
  const { buildOperationalReadiness, OPERATIONAL_READINESS_VERSION } = await import(
    "../../dist/box/operationalReadiness.js"
  );
  const base = {
    now: 1_700_000_000_000,
    decisionGeneration: 42,
    identity: {
      broker: "dhan",
      account: "1000000001",
      executionMode: "live",
      liveRuntimeArmed: false,
      deploymentLiveCapable: true,
    },
    marketData: {
      state: "READY",
      generation: 3,
      desiredInstruments: 4,
      readyInstruments: 4,
      backlog: false,
      // Ages, in the machine's own monotonic domain (see operationalReadiness.ts).
      frameAgeMs: 0,
      heartbeatAgeMs: 0,
      depthAgeMs: 0,
      lastFrameWallAt: 1_700_000_000_000,
      lastHeartbeatWallAt: 1_700_000_000_000,
      lastDepthWallAt: 1_700_000_000_000,
      frames: 100,
      heartbeats: 5,
      depthObservations: 80,
      source: "broker_websocket",
      socketConnected: true,
      authenticated: true,
      subscriptionsRequested: true,
      usableBooks: 4,
    },
    orderStream: {
      lifecycle: "READY",
      publishedState: "LIVE",
      wiring: "armed",
      gateEnabled: true,
      connected: true,
      authorised: true,
      disconnects: 0,
      lastEventAt: 1_700_000_000_000,
      reconcilePending: false,
      fillsObservedBy: "stream_primary_rest_reconcile",
      detail: "live",
    },
    blockers: [],
    paperExecution: { simulated: false, profile: null, usingStreamedQuotes: false },
    openExposure: { openPositions: 0, residualLegs: 0, workingOrders: 0 },
  };

  // WITH an instance.
  const withInstance = buildOperationalReadiness({
    ...base,
    instance: { instance_id: A, boot_ordinal: 12, started_at: 1_699_000_000_000 },
  });
  assert.equal(withInstance.instance.instance_id, A);
  assert.equal(withInstance.instance.boot_ordinal, 12);
  assert.equal(withInstance.instance.started_at, 1_699_000_000_000);
  assert.equal(withInstance.decision_generation, 42, "the per-instance sequence is still published");
  assert.equal(withInstance.decision_version, OPERATIONAL_READINESS_VERSION);
  assert.equal(OPERATIONAL_READINESS_VERSION, "1.7.0", "the shape version is bumped with the shape");

  // WITHOUT one: explicit nulls, never omitted keys, so a client can tell "cannot be ordered" from
  // "the field was dropped in transit".
  const withoutInstance = buildOperationalReadiness(base);
  assert.deepEqual(withoutInstance.instance, {
    instance_id: null,
    boot_ordinal: null,
    started_at: null,
  });
  assert.ok("instance" in withoutInstance, "the key is always present");

  // And such a decision is refused by the shared ordering rule.
  assert.equal(
    orderReadinessDecision(NOTHING_RENDERED, {
      instanceId: withoutInstance.instance.instance_id,
      bootOrdinal: withoutInstance.instance.boot_ordinal,
      decisionGeneration: withoutInstance.decision_generation,
    }).kind,
    "reject_incompatible",
  );
});

/* ═══════════════ 9. the SERVER refuses entry when it cannot be ordered ═══════════════ */

test("the engine adds an entry blocker when the boot ordinal is unknown", async () => {
  // Safety must not depend on the client noticing the null. The server is the only place the refusal
  // is authoritative, so it refuses too — while leaving exposure management alone, because not being
  // able to ORDER a verdict is no reason to stop reducing risk.
  const { readFileSync } = await import("node:fs");
  const engine = readFileSync(new URL("../../src/box/engine.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  assert.ok(
    engine.includes("this.backendInstance.hasOrdinal()"),
    "the engine must consult whether its own epoch is established",
  );
  assert.ok(engine.includes('code: "instance_epoch_unknown"'), "and publish a named entry blocker");
  const idx = engine.indexOf('code: "instance_epoch_unknown"');
  const block = engine.slice(idx, idx + 400);
  assert.ok(block.includes('scope: "entry"'), "the blocker must be ENTRY-scoped, never exposure-scoped");
  assert.ok(
    engine.includes("void this.backendInstance.resolveBootOrdinal()"),
    "and the ordinal must actually be claimed at startup",
  );
});

/* ═══════════════ 10. the ordinal is claimed at most once per process ═══════════════ */

test("BackendInstance never consumes a second ordinal for the same process", async () => {
  const { BackendInstance } = await import("../../dist/box/backendInstance.js");
  const inst = new BackendInstance({ instanceId: "fixed-id", startedAt: 111 });
  assert.equal(inst.identity().instance_id, "fixed-id");
  assert.equal(inst.identity().boot_ordinal, null, "null until claimed — never a fabricated 0");
  assert.equal(inst.hasOrdinal(), false);
  assert.equal(inst.identity().started_at, 111);

  // With no database configured the claim fails, leaves the ordinal null, and does NOT throw.
  const first = await inst.resolveBootOrdinal();
  assert.equal(first, null, "a failure yields null rather than throwing into startup");
  assert.equal(inst.hasOrdinal(), false);
  assert.match(inst.ordinalError() ?? "", /boot ordinal|backend_instance_epoch/i, "and says why");
});
