/**
 * A SEPARATE OS PROCESS that competes for execution ownership and for the session attempt budget.
 *
 * WHY A REAL PROCESS AND NOT TWO OBJECTS. Every defect in this area was a property that held inside one
 * process and failed between two: the session mutex is a per-instance promise chain, the order
 * manager's guards all read local state, and the boot ordinal is a number rather than a grant. Two
 * objects in one Node process share a module registry, a connection pool, an event loop and a clock, so
 * a test built from them can pass while the real topology fails. This worker exists so the contended
 * case is genuinely contended: two pids, two pools, two module instances, one PostgreSQL.
 *
 * PROTOCOL. Arguments are `<schemaUrl> <command> <json-args>`. Every line written to stdout is one JSON
 * object with a `tag` field; the parent matches on `tag`. Anything unexpected goes to stderr so a crash
 * is never mistaken for a result.
 *
 * NO BROKER NETWORK. Nothing here constructs an adapter or reaches a host. The CI egress guard is armed
 * for the suite that spawns it and would refuse anything but loopback.
 */

import { argv, exit, stdout } from "node:process";

const [, , schemaUrl, command, rawArgs] = argv;
const args = rawArgs ? JSON.parse(rawArgs) : {};

function emit(tag, payload = {}) {
  stdout.write(`${JSON.stringify({ tag, pid: process.pid, ...payload })}\n`);
}

const pool = await import("../../dist/pg/pool.js");
await pool.initPg({
  connectionString: schemaUrl,
  poolMax: 4,
  statementTimeoutMs: 5000,
  lockTimeoutMs: 4000,
  applicationName: `gts-owner-worker-${process.pid}`,
});

const leaseStore = await import("../../dist/box/executionLeaseStore.js");
const { BoxExecutionLeaseManager } = await import("../../dist/box/executionLease.js");

/** A manager configured exactly as the engine configures it, minus the broker adapter. */
function manager(overrides = {}) {
  return new BoxExecutionLeaseManager({
    deployment: args.deployment ?? "twoproc",
    instance: `inst-${process.pid}`,
    owner: `${args.deployment ?? "twoproc"}:inst-${process.pid}:p${process.pid}:boot:exec-lease-0:uuid-${process.pid}`,
    broker: () => args.broker ?? "zerodha",
    account: () => args.account ?? "AB1234",
    persistenceAvailable: () => true,
    liveCapable: () => true,
    ttlMs: args.ttlMs ?? 30_000,
    heartbeatMs: args.heartbeatMs ?? 2_000,
    guardMarginMs: args.guardMarginMs ?? 1_000,
    log: (m) => emit("log", { message: m }),
    ...overrides,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  switch (command) {
    /* Acquire, report the outcome, then hold the lease (heartbeating) until told to stop. */
    case "hold": {
      const m = manager();
      await m.initialise();
      const state = m.snapshot();
      emit("acquired", {
        kind: state.kind,
        fence: state.kind === "held" ? state.lease.fence : null,
        owner: state.kind === "held" ? state.lease.owner : null,
        reconciled: state.kind === "held" ? state.lease.reconciled : null,
        detail: state.kind === "held" ? null : state.detail,
        entry_block: m.dispatchBlockReason("new_entry"),
        reduce_block: m.dispatchBlockReason("exposure_reduction"),
      });
      // Stay alive, heartbeating, until the parent kills us or the hold window elapses.
      await sleep(args.holdMs ?? 60_000);
      emit("hold_elapsed");
      break;
    }

    /* Acquire, report, then STOP HEARTBEATING without releasing — models a wedged owner. */
    case "acquire_then_wedge": {
      const m = manager();
      await m.initialise();
      const state = m.snapshot();
      emit("acquired", {
        kind: state.kind,
        fence: state.kind === "held" ? state.lease.fence : null,
      });
      m.stopHeartbeat();
      emit("wedged");
      // Sit still. The lease will lapse on its TTL because nothing renews it.
      await sleep(args.holdMs ?? 60_000);
      break;
    }

    /*
     * Acquire, capture the guard verdict, sleep past the guard margin WITHOUT heartbeating, then ask
     * the guard again. This is the honest bound on a paused owner: the lease cannot retract anything,
     * but the guard must refuse once the observation is too old to prove ownership.
     */
    case "acquire_then_stall": {
      const m = manager();
      await m.initialise();
      emit("before_stall", {
        kind: m.snapshot().kind,
        entry_block: m.dispatchBlockReason("new_entry"),
        reduce_block: m.dispatchBlockReason("exposure_reduction"),
      });
      m.stopHeartbeat();
      await sleep(args.stallMs ?? 3_000);
      emit("after_stall", {
        kind: m.snapshot().kind,
        entry_block: m.dispatchBlockReason("new_entry"),
        reduce_block: m.dispatchBlockReason("exposure_reduction"),
      });
      break;
    }

    /* Acquire and release cleanly, as a graceful shutdown does. */
    case "acquire_then_release": {
      const m = manager();
      await m.initialise();
      const state = m.snapshot();
      emit("acquired", { kind: state.kind, fence: state.kind === "held" ? state.lease.fence : null });
      await m.release();
      emit("released", { kind: m.snapshot().kind });
      break;
    }

    /* One-shot acquire attempt through the raw store, so the refusal shape is observable. */
    case "try_acquire": {
      const result = await leaseStore.acquireExecutionLease({
        deployment: args.deployment ?? "twoproc",
        broker: args.broker ?? "zerodha",
        account: args.account ?? "AB1234",
        owner: `w-${process.pid}`,
        instance: `inst-${process.pid}`,
        ttlMs: args.ttlMs ?? 30_000,
      });
      emit("try_acquire", { result });
      break;
    }

    /*
     * Spend N entry attempts through a REAL BoxTradingSessionManager over the REAL repository, in this
     * process. Two of these racing is the review's lost-update scenario with two genuine processes.
     */
    case "spend_attempts": {
      const repo = await import("../../dist/box/repository.js");
      const { BoxTradingSessionManager } = await import("../../dist/box/tradingSessionStore.js");
      const m = new BoxTradingSessionManager({
        persistence: {
          load: () => repo.loadBoxTradingSession(),
          save: (record, options) => repo.saveBoxTradingSession(record, options),
          flatTradeIds: async () => [],
          consumeEntryAttempt: (a) => repo.consumeBoxTradingSessionEntryAttempt(a),
        },
        configuredMaxCompletedTrades: () => 0,
        configuredMaxEntryAttempts: () => args.ceiling ?? 1,
        persistenceAvailable: () => true,
        log: () => {},
      });
      await m.initialise();
      emit("ready", { session_id: m.snapshot().session_id, spent: m.snapshot().entry_attempts });
      // Barrier: wait for the parent's go signal so both workers push at the same instant.
      if (args.startAt) {
        const wait = args.startAt - Date.now();
        if (wait > 0) await sleep(wait);
      }
      const outcomes = [];
      for (let i = 0; i < (args.tries ?? 1); i += 1) {
        outcomes.push(await m.recordAttemptStarted());
      }
      emit("spent", { outcomes });
      break;
    }

    default:
      emit("error", { message: `unknown command ${command}` });
      await pool.closePg().catch(() => {});
      exit(2);
  }
  await pool.closePg().catch(() => {});
  exit(0);
} catch (err) {
  emit("error", { message: err instanceof Error ? err.message : String(err) });
  await pool.closePg().catch(() => {});
  exit(1);
}
