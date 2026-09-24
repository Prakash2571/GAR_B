/**
 * TWO INDEPENDENT OS PROCESSES, ONE POSTGRESQL. THE TOPOLOGY THE REVIEW USED.
 *
 * Every defect in this area was a property that held inside one process and failed between two. Two
 * objects in one Node process share a module registry, a connection pool, an event loop and a clock, so
 * a test built from them can pass while the real topology fails. These tests therefore spawn real child
 * processes (`tests/helpers/executionOwnerWorker.mjs`) and assert against the DATABASE.
 *
 * WHAT IS ASSERTED
 *
 *   1. BUDGET CONTENTION — two processes racing the attempt ceiling admit exactly the ceiling, and the
 *      persisted counter equals the number admitted.
 *   2. EXCLUSIVITY — a second process cannot acquire a lease a live process holds, and its refusal says
 *      plainly that it will not submit.
 *   3. OWNER DEATH (SIGKILL) — no release runs, and a successor takes over only after the TTL lapses,
 *      with a strictly higher fence and a CLEARED reconciled stamp.
 *   4. PAUSED OWNER (SIGSTOP) — a stopped process cannot renew, so its lease lapses and a successor may
 *      take over; before the lapse the successor is refused.
 *   5. CLEAN HANDOVER — a graceful release lets the successor acquire at once.
 *   6. DELAYED / STALLED OWNER — an owner whose observation has aged past the guard margin refuses its
 *      OWN dispatch in both directions. This is the honest bound, and the test names its limit.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED, BECAUSE IT IS NOT TRUE
 *
 * That a lease stops a broker request already on the wire. It cannot. Neither Zerodha nor Dhan accepts a
 * fencing token, so there is no way to have the broker reject an order from a superseded owner. Test 6
 * pins what IS true: the superseded owner stops choosing to send. See docs/EXECUTION_OWNERSHIP.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setup, teardown } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(HERE, "..", "helpers", "executionOwnerWorker.mjs");
const BASE_URL = (process.env.DATABASE_URL ?? "postgres://strikedge:strikedge@127.0.0.1:55432/strikedge").trim();

const DEPLOYMENT = "twoproc";
const BROKER = "zerodha";
const ACCOUNT = "AB1234";

let ctx;
let schemaUrl;
let leaseStore;
let repo;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  ctx = await setup("twoproc");
  const u = new URL(BASE_URL);
  u.searchParams.set("options", `-csearch_path=${ctx.schema}`);
  schemaUrl = u.toString();
  leaseStore = await import("../../dist/box/executionLeaseStore.js");
  repo = await import("../../dist/box/repository.js");
});

test.after(async () => {
  await teardown(ctx);
});

/**
 * Spawn a worker. Returns a handle exposing the parsed stdout lines, a promise for exit, and the child
 * so a test can signal it. `NODE_OPTIONS` is cleared so the parent's egress-guard `--import` is not
 * re-applied in a way that changes the child's module graph; the child performs no network I/O at all.
 */
function spawnWorker(command, args = {}) {
  const child = spawn(process.execPath, [WORKER, schemaUrl, command, JSON.stringify(args)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  const lines = [];
  const waiters = [];
  let buf = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (raw.trim() === "") continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        stderr += `UNPARSEABLE: ${raw}\n`;
        continue;
      }
      lines.push(parsed);
      for (const w of [...waiters]) {
        if (w.tag === parsed.tag) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(parsed);
        }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });

  const exited = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));

  return {
    child,
    lines,
    stderrText: () => stderr,
    /** Wait for the first line carrying `tag`. Fails loudly rather than hanging forever. */
    async waitFor(tag, timeoutMs = 20_000) {
      const already = lines.find((l) => l.tag === tag);
      if (already) return already;
      return new Promise((res, rej) => {
        const w = { tag, resolve: res };
        waiters.push(w);
        const t = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          rej(new Error(
            `worker did not emit "${tag}" within ${timeoutMs}ms. ` +
            `Saw: ${JSON.stringify(lines)}. stderr: ${stderr.slice(0, 800)}`,
          ));
        }, timeoutMs);
        void Promise.resolve(res).then(() => clearTimeout(t));
        exited.then(() => {
          clearTimeout(t);
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            rej(new Error(
              `worker exited before emitting "${tag}". Saw: ${JSON.stringify(lines)}. ` +
              `stderr: ${stderr.slice(0, 800)}`,
            ));
          }
        });
      });
    },
    exited,
    kill(signal = "SIGKILL") { try { child.kill(signal); } catch { /* already gone */ } },
  };
}

const scope = () => leaseStore.executionLeaseScope({
  deployment: DEPLOYMENT, broker: BROKER, account: ACCOUNT,
});

async function cleanLeases() {
  await ctx.pool.query(`DELETE FROM box_execution_leases`);
}

/* ═══════════════════ 1. budget contention across two processes ═══════════════════ */

test("two PROCESSES racing the attempt ceiling admit exactly the ceiling and lose no update", async () => {
  await ctx.pool.query(`DELETE FROM box_trading_session`);

  const CEILING = 3;
  // Arm the session in this process, so both workers adopt an already-armed record.
  const { BoxTradingSessionManager } = await import("../../dist/box/tradingSessionStore.js");
  const arming = new BoxTradingSessionManager({
    persistence: {
      load: () => repo.loadBoxTradingSession(),
      save: (r, o) => repo.saveBoxTradingSession(r, o),
      flatTradeIds: async () => [],
      consumeEntryAttempt: (a) => repo.consumeBoxTradingSessionEntryAttempt(a),
    },
    configuredMaxCompletedTrades: () => 0,
    configuredMaxEntryAttempts: () => CEILING,
    persistenceAvailable: () => true,
    log: () => {},
  });
  await arming.initialise();
  const armed = await arming.arm({
    maxEntryAttempts: CEILING, armedBy: "twoproc", openBoxes: 0, residualLegs: 0, recoveryActive: false,
  });
  assert.equal(armed.ok, true, `arming must succeed: ${armed.ok === false ? armed.reason : ""}`);

  // Both workers try 4 times each against a ceiling of 3, starting together.
  const startAt = Date.now() + 1_500;
  const a = spawnWorker("spend_attempts", { ceiling: CEILING, tries: 4, startAt });
  const b = spawnWorker("spend_attempts", { ceiling: CEILING, tries: 4, startAt });
  await Promise.all([a.waitFor("ready"), b.waitFor("ready")]);
  const [ra, rb] = await Promise.all([a.waitFor("spent", 30_000), b.waitFor("spent", 30_000)]);
  await Promise.all([a.exited, b.exited]);

  const admitted = [...ra.outcomes, ...rb.outcomes].filter((o) => o.ok).length;
  const loaded = await repo.loadBoxTradingSession();
  assert.equal(loaded.ok, true);
  const persisted = loaded.record.entry_attempts;

  assert.equal(
    admitted, CEILING,
    `exactly the ceiling may be admitted across two processes (${CEILING}), got ${admitted}: ` +
      `A=${JSON.stringify(ra.outcomes)} B=${JSON.stringify(rb.outcomes)}`,
  );
  assert.equal(
    persisted, admitted,
    `no update may be lost across processes: persisted ${persisted} vs admitted ${admitted}`,
  );
  // Both processes must have been admitted at least once, otherwise this was not a contended race and
  // the assertion above proves nothing about concurrency.
  assert.ok(
    ra.outcomes.some((o) => o.ok) && rb.outcomes.some((o) => o.ok),
    "NON-VACUITY: both processes must have won at least one attempt for this to be a real race",
  );
  // And every refusal must be legible.
  // Every refusal must carry an operator-readable reason. Two distinct refusals are legitimate here:
  // the DURABLE ceiling (from the atomic consume) and the LOCAL pre-check (`evaluateSessionEntry`,
  // which also owns the completed-cycle ceiling). Both name the attempt budget.
  for (const o of [...ra.outcomes, ...rb.outcomes].filter((x) => !x.ok)) {
    assert.match(
      String(o.detail),
      /attempt/i,
      `a refusal must say what was refused and why: ${o.detail}`,
    );
    assert.ok(String(o.detail).length > 20, `a refusal must be more than a token: ${o.detail}`);
  }
});

/* ═══════════════════ 2. exclusivity between two processes ═══════════════════ */

test("a second PROCESS cannot acquire a lease a live process holds", async () => {
  await cleanLeases();
  const holder = spawnWorker("hold", { ttlMs: 30_000, heartbeatMs: 2_000, holdMs: 20_000 });
  const first = await holder.waitFor("acquired");
  assert.equal(first.kind, "held", `the first process must hold the lease: ${JSON.stringify(first)}`);
  // A fresh owner must still reconcile broker state before NEW entry — there is no order manager wired
  // in this worker, so the stamp legitimately stays unset. What matters here is that it may REDUCE.
  assert.match(
    String(first.entry_block), /not yet been reconciled|just established/,
    "a freshly-acquired lease withholds new entry until broker state is reconciled",
  );
  assert.equal(first.reduce_block, null, "a fresh owner may reduce");

  const challenger = spawnWorker("hold", { ttlMs: 30_000, holdMs: 1_000 });
  const second = await challenger.waitFor("acquired");
  assert.equal(second.kind, "refused", `the second process must be REFUSED: ${JSON.stringify(second)}`);
  assert.match(second.detail, /held by another live instance/);
  assert.match(
    second.entry_block, /held by another instance/,
    "the refused process must refuse its own entry dispatch",
  );
  assert.match(
    second.reduce_block, /would race the owner/,
    "the refused process must also refuse REDUCTION, or two processes could double-close",
  );

  // The durable row still belongs to the holder.
  const row = await leaseStore.readExecutionLease(scope());
  assert.equal(row.fence, first.fence);

  holder.kill();
  challenger.kill();
  await Promise.all([holder.exited, challenger.exited]);
});

/* ═══════════════════ 3. owner death by SIGKILL ═══════════════════ */

test("a SIGKILLed owner releases nothing, and a successor takes over only after the TTL lapses", async () => {
  await cleanLeases();
  const victim = spawnWorker("hold", { ttlMs: 2_000, heartbeatMs: 30_000, holdMs: 60_000 });
  const got = await victim.waitFor("acquired");
  assert.equal(got.kind, "held");

  // SIGKILL cannot be trapped, so no release runs. This is exactly why expiry is the backstop.
  victim.kill("SIGKILL");
  const how = await victim.exited;
  assert.equal(how.signal, "SIGKILL");

  const stillThere = await leaseStore.readExecutionLease(scope());
  assert.notEqual(stillThere, null, "a killed owner leaves its row behind — nothing ran to remove it");
  assert.equal(stillThere.owner, got.owner);

  // Before the TTL lapses, a successor is refused.
  const tooEarly = spawnWorker("try_acquire", { ttlMs: 30_000 });
  const early = (await tooEarly.waitFor("try_acquire")).result;
  await tooEarly.exited;
  if (early.ok) {
    // The 2s TTL may already have passed on a slow machine; only assert when it genuinely had not.
    assert.equal(early.took_over, true, "if it succeeded, it must be reported as a takeover");
  } else {
    assert.equal(early.reason, "held_by_other");
  }

  await sleep(2_500);

  const successor = spawnWorker("hold", { ttlMs: 30_000, holdMs: 3_000 });
  const took = await successor.waitFor("acquired");
  assert.equal(took.kind, "held", `the successor must take over a lapsed lease: ${JSON.stringify(took)}`);
  assert.ok(took.fence > got.fence, `the successor's fence (${took.fence}) must exceed the dead owner's (${got.fence})`);
  assert.equal(
    took.reconciled, false,
    "a takeover must start UNRECONCILED, so new entry stays refused until the predecessor's pending " +
      "broker operations are established",
  );
  assert.match(
    took.entry_block, /TAKEN OVER/,
    "the successor must refuse new entry until it has reconciled",
  );
  assert.equal(
    took.reduce_block, null,
    "the successor MUST be able to reduce, or the dead owner's exposure would be stranded",
  );

  successor.kill();
  await successor.exited;
});

/* ═══════════════════ 4. paused owner (SIGSTOP) ═══════════════════ */

test("a SIGSTOPped owner cannot renew, so its lease lapses and exactly one successor takes over", async () => {
  await cleanLeases();
  const paused = spawnWorker("hold", { ttlMs: 2_000, heartbeatMs: 500, holdMs: 60_000 });
  const got = await paused.waitFor("acquired");
  assert.equal(got.kind, "held");

  // SIGSTOP freezes the process WITHOUT killing it: it holds its lease row but stops heartbeating.
  // This is the case a TTL must cover and a held connection would not.
  paused.kill("SIGSTOP");

  // While the lease is still live, nobody may take over.
  const early = spawnWorker("try_acquire", { ttlMs: 30_000 });
  const earlyResult = (await early.waitFor("try_acquire")).result;
  await early.exited;
  assert.equal(
    earlyResult.ok, false,
    "a paused owner's UNEXPIRED lease must not be takeable — being quiet is not being gone",
  );
  assert.equal(earlyResult.reason, "held_by_other");

  await sleep(2_500);

  // Three challengers at once: exactly one may win.
  const challengers = [
    spawnWorker("try_acquire", { ttlMs: 30_000 }),
    spawnWorker("try_acquire", { ttlMs: 30_000 }),
    spawnWorker("try_acquire", { ttlMs: 30_000 }),
  ];
  const results = await Promise.all(challengers.map((c) => c.waitFor("try_acquire")));
  await Promise.all(challengers.map((c) => c.exited));
  const winners = results.map((r) => r.result).filter((r) => r.ok);
  assert.equal(winners.length, 1, `exactly one successor may take over, got ${winners.length}`);
  assert.ok(winners[0].lease.fence > got.fence, "the successor's fence must be strictly higher");
  assert.equal(winners[0].lease.takeover_reconciled_at, null, "a takeover starts unreconciled");

  // Let the paused process go and confirm it cannot reclaim or damage the successor's row.
  paused.kill("SIGCONT");
  await sleep(1_500);
  const row = await leaseStore.readExecutionLease(scope());
  assert.equal(
    row.owner, winners[0].lease.owner,
    "a resumed owner must NOT be able to take its lease back from the successor",
  );
  paused.kill("SIGKILL");
  await paused.exited;
});

/* ═══════════════════ 5. clean handover ═══════════════════ */

test("a gracefully released lease is acquirable by the next process at once", async () => {
  await cleanLeases();
  const first = spawnWorker("acquire_then_release", { ttlMs: 30_000 });
  const got = await first.waitFor("acquired");
  assert.equal(got.kind, "held");
  const released = await first.waitFor("released");
  assert.equal(released.kind, "inactive");
  await first.exited;

  assert.equal(
    await leaseStore.readExecutionLease(scope()), null,
    "a clean release must remove the row, so a successor need not wait out the TTL",
  );

  const second = spawnWorker("hold", { ttlMs: 30_000, holdMs: 2_000 });
  const took = await second.waitFor("acquired");
  assert.equal(took.kind, "held", "a released account must be immediately acquirable");
  assert.ok(took.fence > got.fence, "fences stay monotonic across a clean handover");
  assert.equal(
    took.reconciled, false,
    "acquiring an absent row is 'fresh', and fresh is also unreconciled until proven otherwise",
  );
  second.kill();
  await second.exited;
});

/* ═══════════════ 6. a stalled owner refuses its OWN dispatch ═══════════════ */

test("an owner whose lease observation aged past the guard margin refuses its own dispatch", async () => {
  await cleanLeases();
  // TTL 2s, guard margin 1s: after a 2.5s stall with no heartbeat there is no provable life left.
  const staller = spawnWorker("acquire_then_stall", {
    ttlMs: 2_000, heartbeatMs: 30_000, guardMarginMs: 1_000, stallMs: 2_500,
  });
  const before = await staller.waitFor("before_stall");
  assert.equal(before.kind, "held");
  // REDUCTION is the direction this test is about: it is permitted on a fresh observation and must
  // stop once ownership is no longer provable. (Entry is separately withheld until broker state is
  // reconciled, which this worker has no order manager to do.)
  assert.equal(before.reduce_block, null, "a fresh observation permits reduction");

  const after = await staller.waitFor("after_stall", 30_000);
  await staller.exited;

  assert.equal(
    typeof after.entry_block, "string",
    "a stalled owner must refuse its own ENTRY dispatch once it cannot prove ownership",
  );
  assert.match(
    after.entry_block, /cannot prove it still owns execution/,
    "the reason must be UNPROVABLE OWNERSHIP, not the reconciliation gate — otherwise this test would " +
      "pass for the wrong reason",
  );
  assert.equal(
    typeof after.reduce_block, "string",
    "it must refuse REDUCTION too: a successor may already own the account, and two processes " +
      "reducing the same exposure double-close it",
  );
  assert.match(after.reduce_block, /two instances acting on one account/);
});
