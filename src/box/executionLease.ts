/**
 * EXCLUSIVE, ACCOUNT-SCOPED EXECUTION OWNERSHIP.
 *
 * `executionLeaseStore.ts` holds the SQL. This module holds the policy: when a lease is acquired,
 * what a held lease permits, how a lost one is noticed, and — the part that has to be exactly right —
 * a SYNCHRONOUS predicate the order dispatch boundary can call in the last instant before a broker
 * POST.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES AND DOES NOT GUARANTEE. READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * IT DOES guarantee that at most one process will BEGIN a new broker mutation for a given
 * (deployment, broker, account), provided all three of:
 *
 *   (a) every dispatch path consults `dispatchBlockReason()` immediately before the wire, with no
 *       `await` in between — see `orderManager.ts` CHECKPOINT 5, which is written for exactly that
 *       invariant;
 *   (b) `safetyMarginMs` exceeds the longest possible pause between that call and the socket write.
 *       The margin is what converts "I held it when I last heard from the database" into "nobody else
 *       can have taken it yet", because a challenger may only take over a row whose `expires_at` has
 *       passed ON THE SERVER'S CLOCK;
 *   (c) PostgreSQL is the single authority both processes talk to.
 *
 * IT DOES NOT — and cannot — do any of the following, and no comment or status field in this codebase
 * may imply otherwise:
 *
 *   · CANCEL A REQUEST ALREADY ON THE WIRE. If a lease lapses while an HTTP POST is in flight, that
 *     POST still reaches the broker and may still be accepted. A database row has no authority over a
 *     TCP connection. This is why a takeover must reconcile before it starts new entry, and why
 *     `takeover_reconciled_at` exists.
 *   · BE ENFORCED BY THE BROKER. Neither Zerodha's nor Dhan's order API accepts a fencing token, an
 *     epoch, or a conditional-on-generation placement. There is no way to ask the broker to reject an
 *     order from a superseded owner. The fence orders OUR decisions; the broker never sees it. A
 *     genuinely partitioned old owner that still reaches the broker but not the database will be
 *     stopped by (b) — because its own guard fails once its observed lease ages out — and by nothing
 *     else. That is a real, bounded residual risk, not a proof.
 *   · SURVIVE AN UNBOUNDED PROCESS PAUSE. A process stopped (SIGSTOP, a very long GC pause, a
 *     suspended VM) between the guard and the wire for longer than `safetyMarginMs` can emit an order
 *     after a successor has taken over. The margin bounds this; it does not eliminate it. Shorter TTL
 *     narrows the takeover delay but widens the false-loss rate, so the trade is deliberate.
 *
 * See `docs/EXECUTION_OWNERSHIP.md` for the operator-facing version of this, including what to do
 * when the lease is held by an instance you did not expect.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

import { performance } from "node:perf_hooks";
import {
  acquireExecutionLease,
  ensureExecutionLeaseStoreReady,
  executionLeaseScope,
  markExecutionLeaseReconciled,
  readExecutionLease,
  releaseExecutionLease,
  renewExecutionLease,
  type ExecutionLeaseRow,
} from "./executionLeaseStore.js";
import type { BoxOrderPurpose } from "./types.js";

/** Default lease lifetime. A successor may take over this long after the owner stops renewing. */
export const DEFAULT_EXECUTION_LEASE_TTL_MS = 30_000;
/** Default heartbeat. Comfortably below a third of the TTL, so two renewals may fail harmlessly. */
export const DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS = 8_000;
/**
 * Default guard margin.
 *
 * The dispatch guard refuses unless the observed lease has at least this much life left. It must
 * exceed the longest plausible gap between the guard returning and the socket write — adapter pacing
 * is already done by then, so what remains is the callback chain, TLS write and any event-loop stall.
 * Five seconds is generous for that and still leaves 25s of usable lease at the default TTL.
 */
export const DEFAULT_EXECUTION_LEASE_GUARD_MARGIN_MS = 5_000;

/**
 * THE DURATION CLOCK. MONOTONIC, NEVER WALL-CLOCK.
 *
 * Every local reading in this module is used as one end of a DURATION — "how long ago did I observe the
 * lease" — and never as an instant to compare against the server's clock. `Date.now()` cannot express
 * that safely: it is settable. An NTP step, a manual `date -s`, a suspended-and-restored VM or a
 * container clock correction can move it BACKWARDS, and a backwards step made the guard arithmetic
 * `now() - observedAtLocal` negative, which the old `Math.max(0, …)` clamp then presented as "observed
 * zero milliseconds ago" — i.e. maximally fresh. A guard whose freshness improves when the clock slips
 * is not a guard, so the default source is now monotonic and unsettable.
 *
 * `performance.now()` is milliseconds since process start, taken from the platform's monotonic source.
 * Its epoch is meaningless and that is fine: nothing here compares a local reading to a server instant.
 */
export function monotonicNowMs(): number {
  return performance.now();
}

/** What a lease is being consulted for. New entry is held to a stricter standard than reduction. */
export type ExecutionLeaseUse = "new_entry" | "exposure_reduction";

/**
 * Which uses a purpose maps to.
 *
 * ENTRY creates exposure and is the only thing withheld from an unreconciled takeover. Everything
 * else REDUCES or PROTECTS exposure, and withholding those from the one process that owns the account
 * would mean a takeover could not clean up after its predecessor — which is the opposite of safe.
 */
export function leaseUseForPurpose(purpose: BoxOrderPurpose): ExecutionLeaseUse {
  return purpose === "ENTRY" ? "new_entry" : "exposure_reduction";
}

/** The cached, locally-observable lease state. Everything the synchronous guard may read. */
interface ObservedLease {
  readonly scope: string;
  readonly owner: string;
  readonly fence: number;
  readonly account: string;
  readonly broker: string;
  /**
   * Server-clock lifetime remaining at the instant of observation, in ms. Never negative.
   *
   * ALREADY NET OF THE DATABASE CALL. The server evaluates `clock_timestamp()` inside the statement,
   * but the application only learns the answer once the statement has finished, the row has crossed the
   * network, the driver has parsed it and the event loop has got round to the continuation. Every one of
   * those milliseconds is lease life that had ALREADY been spent by the time this process could act on
   * the number, so the measured duration of the call is subtracted here. Charging the whole call rather
   * than half of it is deliberate: the only safe assumption is that the server read its clock at the
   * earliest possible moment, and being early about expiry costs a refusal while being late costs two
   * processes on one account.
   */
  readonly remainingAtObservationMs: number;
  /**
   * A MONOTONIC reading (see {@link monotonicNowMs}) taken when that observation was recorded. Used
   * only as one end of a DURATION, never compared against a server instant.
   */
  readonly observedAtLocal: number;
  readonly reconciled: boolean;
  /**
   * Why this owner holds the row: 'fresh' (no incumbent) or 'expired' (an incumbent's lease lapsed).
   *
   * Carried only so the refusal message can be accurate. A fresh acquisition and a takeover are held to
   * the SAME standard — both must reconcile broker state before new entry — but telling an operator
   * "TAKEN OVER from a previous instance" when nothing was taken over sends them looking for a second
   * process that does not exist.
   */
  readonly takeoverReason: string;
}

/**
 * THE STATE MACHINE.
 *
 * `refused` and `lost` are the two PROVEN-FOREIGN states: something authoritative told this process
 * that another instance owns, or may own, the account. They carry the scope the proof was about, so a
 * later broker switch or account replacement can retire evidence that no longer applies while a
 * transient database fault cannot. See {@link BoxExecutionLeaseManager.adoptUnproven}.
 */
export type ExecutionLeaseState =
  /** No account is known yet, or leasing is not applicable (paper, no live account). */
  | { readonly kind: "inactive"; readonly detail: string }
  | { readonly kind: "held"; readonly lease: ObservedLease }
  | {
      readonly kind: "refused";
      readonly detail: string;
      readonly holder: string | null;
      /** The scope this refusal was proved for. Null when it could not be determined. */
      readonly scope: string | null;
    }
  | {
      readonly kind: "lost";
      readonly detail: string;
      /** The scope this loss was proved for. Null when it could not be determined. */
      readonly scope: string | null;
    }
  | { readonly kind: "unavailable"; readonly detail: string };

/**
 * The durable-store operations this manager drives.
 *
 * Injectable for ONE reason that matters: the defect this seam was added for was a bad STATE
 * TRANSITION — a store error overwriting proven-foreign evidence — and a transition can only be
 * tested by driving the real state machine across two passes with different store answers. Installing
 * states directly (as the guard tests do) cannot catch it, and a PostgreSQL-backed test cannot easily
 * produce "the driver threw" on the second call only. Defaults are the real module functions, so
 * production wiring passes nothing and behaves exactly as before.
 */
export interface ExecutionLeaseStoreOps {
  readonly acquire: typeof acquireExecutionLease;
  readonly renew: typeof renewExecutionLease;
  readonly markReconciled: typeof markExecutionLeaseReconciled;
  readonly release: typeof releaseExecutionLease;
  readonly read: typeof readExecutionLease;
  readonly ready: typeof ensureExecutionLeaseStoreReady;
}

export interface ExecutionLeaseManagerDeps {
  readonly deployment: string;
  readonly instance: string;
  /** This process's owner id. Stable for the process lifetime. */
  readonly owner: string;
  /** The broker currently selected. */
  readonly broker: () => string;
  /**
   * The live broker account, or null when it cannot be PROVEN.
   *
   * Null is not an error and must not be turned into one: a paper deployment, or a live one whose
   * account is not yet resolved, has nothing to lease. It does mean the lease grants nothing, so
   * anything that requires proven exclusivity must consult `dispatchBlockReason` and get its answer
   * from `requireLeaseForDispatch` rather than from the absence of a lease.
   */
  readonly account: () => string | null;
  /** Whether durable persistence exists at all. No database ⇒ no lease is possible. */
  readonly persistenceAvailable: () => boolean;
  /**
   * Whether this deployment can place live orders.
   *
   * A paper deployment needs no lease and must not be blocked by one — it sends nothing to a broker.
   */
  readonly liveCapable: () => boolean;
  readonly ttlMs?: number;
  readonly heartbeatMs?: number;
  readonly guardMarginMs?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
  /**
   * Called once after a TAKEOVER, before new entry is permitted, to reconcile the previous owner's
   * pending and ambiguous broker operations. Resolve truthy to stamp the lease as reconciled.
   *
   * Deliberately injected rather than reached for: reconciliation lives in the order manager, and this
   * module must not know how it works — only that it has to happen first.
   */
  readonly reconcileAfterTakeover?: () => Promise<boolean>;
  /** Override individual durable-store operations. Tests only — see {@link ExecutionLeaseStoreOps}. */
  readonly store?: Partial<ExecutionLeaseStoreOps>;
}

export class BoxExecutionLeaseManager {
  private state: ExecutionLeaseState = {
    kind: "inactive",
    detail: "the execution lease has not been acquired yet",
  };
  private heartbeat: NodeJS.Timeout | null = null;
  private disposed = false;
  /** Guards against two overlapping acquire/renew passes. */
  private inFlight: Promise<ExecutionLeaseState> | null = null;
  private reconcileInFlight = false;
  /** The scope this manager currently holds or last tried, so a release can be fence-pinned. */
  private currentScope: string | null = null;

  private readonly deps: ExecutionLeaseManagerDeps;
  private readonly store: ExecutionLeaseStoreOps;

  constructor(deps: ExecutionLeaseManagerDeps) {
    this.deps = deps;
    this.store = {
      acquire: deps.store?.acquire ?? acquireExecutionLease,
      renew: deps.store?.renew ?? renewExecutionLease,
      markReconciled: deps.store?.markReconciled ?? markExecutionLeaseReconciled,
      release: deps.store?.release ?? releaseExecutionLease,
      read: deps.store?.read ?? readExecutionLease,
      ready: deps.store?.ready ?? ensureExecutionLeaseStoreReady,
    };
  }

  /**
   * The duration clock. Monotonic unless a test injects its own (a counter, which is also monotonic).
   *
   * Both readings that ever meet — the observation stamp and the elapsed measurement in
   * `dispatchBlockReason` — come from HERE, so they are always the same clock. Do not reintroduce
   * `Date.now()`: see {@link monotonicNowMs}.
   */
  private now(): number {
    return this.deps.now ? this.deps.now() : monotonicNowMs();
  }

  private ttl(): number {
    return Math.max(2_000, this.deps.ttlMs ?? DEFAULT_EXECUTION_LEASE_TTL_MS);
  }

  private margin(): number {
    return Math.max(0, this.deps.guardMarginMs ?? DEFAULT_EXECUTION_LEASE_GUARD_MARGIN_MS);
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  /** The current state, for status projections. Read-only. */
  snapshot(): ExecutionLeaseState {
    return this.state;
  }

  /**
   * THE SYNCHRONOUS DISPATCH GUARD. Returns null when this process may send, a reason when it may not.
   *
   * Synchronous by requirement, not convenience: the whole value of CHECKPOINT 5 in `orderManager.ts`
   * is that no `await` separates the last check from the POST, so a check that awaited the database
   * would reintroduce exactly the window it is meant to close. It therefore reads only the cached
   * observation the heartbeat maintains.
   *
   * THE ARITHMETIC IS SKEW-FREE. `remainingAtObservationMs` is a DIFFERENCE of two server-clock
   * readings (`expires_at - clock_timestamp()`) taken in one statement, so no local clock takes part —
   * less the measured duration of the database call itself, which had already elapsed before this
   * process could act on the answer. The local clock contributes only ELAPSED time since the
   * observation, used as a duration and read from a MONOTONIC source, so nothing compares a local
   * instant with a server instant and no settable clock can make the observation look younger than it
   * is. A duration that measures negative anyway is treated as unprovable, never as fresh.
   *
   * ────────────────────────────────────────────────────────────────────────────────────────────────
   * THE ASYMMETRY BETWEEN ENTRY AND REDUCTION IS THE MOST IMPORTANT THING IN THIS METHOD.
   *
   * It mirrors `orderManager.dispatchAccountBlockReason`, which blocks only on POSITIVE PROOF of a
   * different account, because "cannot tell" must never strand exposure — a refused EXIT guarantees
   * the position stays. The same distinction applies here, and the two cases are genuinely different:
   *
   *   · CANNOT TELL (no lease table, no proven account, nothing acquired yet). There is no evidence
   *     another instance exists. Creating NEW exposure without provable exclusivity is refused,
   *     because that is the hazard. Reducing existing exposure is PERMITTED, because refusing it would
   *     strand real positions for a reason that is not evidence of anything.
   *
   *   · PROVEN FOREIGN (the lease is held by another live instance, or ours lapsed and may have been
   *     taken over, or our observation is too old to prove we still hold it). Now there is positive
   *     evidence of a second owner, and BOTH directions must stop: two processes flattening the same
   *     position double-close it, and two processes cancelling race each other. This is the
   *     "an old owner must not race its successor on cancellation or flatten" property.
   *
   * Collapsing these two into one answer breaks one invariant or the other, whichever way it is
   * collapsed. Do not simplify it.
   * ────────────────────────────────────────────────────────────────────────────────────────────────
   */
  dispatchBlockReason(use: ExecutionLeaseUse): string | null {
    // A paper deployment sends nothing to a broker, so there is nothing to fence.
    if (!this.deps.liveCapable()) return null;

    const state = this.state;
    if (state.kind === "held") {
      const rawElapsed = this.now() - state.lease.observedAtLocal;
      if (rawElapsed < 0) {
        /*
         * THE CLOCK WENT BACKWARDS. Refuse both directions.
         *
         * This is unreachable with the default monotonic source and is kept as a hard backstop for an
         * injected clock. It used to be silently clamped to zero by `Math.max(0, …)`, which reported the
         * observation as maximally FRESH and let the guard pass for as long as the backwards step was
         * large — the one failure mode where a broken clock made the guard more permissive instead of
         * less. An unexplained negative duration means the measurement cannot be trusted at all, and an
         * untrustworthy measurement is not proof of ownership.
         */
        return (
          `this process cannot prove it still owns execution for ${state.lease.broker} account ` +
          `${state.lease.account}: its duration clock moved BACKWARDS by ` +
          `${Math.round(-rawElapsed)}ms since the lease was observed, so the age of that observation ` +
          "cannot be measured. Refusing rather than treat an unmeasurable observation as fresh."
        );
      }
      const elapsed = rawElapsed;
      const remaining = state.lease.remainingAtObservationMs - elapsed;
      if (remaining <= this.margin()) {
        // PROVEN-UNPROVABLE: we cannot show we still hold it, so a successor may already exist.
        // Blocks both directions. This is transient by construction — the heartbeat runs at a small
        // fraction of the TTL — and when it is NOT transient the database is unreachable, in which
        // case reduction is already refused upstream for want of the durable order journal.
        return (
          `this process cannot prove it still owns execution for ${state.lease.broker} account ` +
          `${state.lease.account}: its lease observation is ${Math.round(elapsed)}ms old and leaves ` +
          `${Math.round(Math.max(0, remaining))}ms of provable life, under the ${this.margin()}ms guard ` +
          "margin. Refusing rather than risk two instances acting on one account."
        );
      }
      if (use === "new_entry" && !state.lease.reconciled) {
        // A fresh acquisition and a takeover are held to the SAME standard here: in both cases this
        // process has not yet established what exists at the broker for this account, and a clean
        // handover leaves open positions and possibly working orders behind just as a crash does. Only
        // the wording differs, so an operator is not sent looking for a second process that never
        // existed.
        return state.lease.takeoverReason === "fresh"
          ? "execution ownership for this account was just established and the broker's pending " +
            "operations for it have not been reconciled yet, so new entry is refused. Exposure " +
            "reduction, protective cancellation and reconciliation remain available."
          : "execution ownership for this account was TAKEN OVER from a previous instance and its " +
            "pending broker operations have not been reconciled yet, so new entry is refused. " +
            "Exposure reduction, protective cancellation and reconciliation remain available.";
      }
      return null;
    }

    // PROVEN FOREIGN. Another live instance holds the lease, or ours lapsed. Both directions stop.
    if (state.kind === "refused") {
      return (
        "execution ownership for this account is held by another instance, so this process will not " +
        `send anything for it — including a reduction, which would race the owner. ${state.detail}`
      );
    }
    if (state.kind === "lost") {
      return (
        `this process no longer owns execution for this account, so it will not send anything for it ` +
        `— including a reduction, which would race whoever took over: ${state.detail}`
      );
    }

    // CANNOT TELL. No evidence of a second owner. New entry refused; reduction permitted.
    if (use === "exposure_reduction") return null;
    if (state.kind === "unavailable") {
      return (
        "exclusive execution ownership could not be established, so NEW ENTRY is refused: " +
        `${state.detail} Exposure reduction, protective cancellation and reconciliation remain ` +
        "available, because refusing those would strand real exposure without evidence that another " +
        "instance exists."
      );
    }
    return (
      "exclusive execution ownership has not been established for this account, so NEW ENTRY is " +
      `refused (${state.detail}). Exposure reduction, protective cancellation and reconciliation ` +
      "remain available."
    );
  }

  /**
   * Whether new ENTRY is permitted by ownership alone. Used by the entry gate so a lease problem
   * closes entry without waiting for an order to reach the dispatch boundary.
   */
  entryBlockReason(): string | null {
    return this.dispatchBlockReason("new_entry");
  }

  /**
   * Acquire or renew, and adopt the result. Never throws.
   *
   * Idempotent under concurrency: overlapping callers share one in-flight pass, so a heartbeat and a
   * broker-switch re-acquire cannot both write.
   */
  async refresh(): Promise<ExecutionLeaseState> {
    if (this.inFlight) return this.inFlight;
    const pass = this.runRefresh().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = pass;
    return pass;
  }

  private async runRefresh(): Promise<ExecutionLeaseState> {
    if (this.disposed) return this.state;

    if (!this.deps.liveCapable()) {
      return this.adopt({
        kind: "inactive",
        detail: "this deployment cannot place live orders, so no execution lease is required",
      });
    }
    if (!this.deps.persistenceAvailable()) {
      // No durable authority ⇒ exclusivity cannot be established. For a LIVE-capable deployment that
      // is a refusal, not a pass: without PostgreSQL there is no way to know whether another instance
      // is trading the same account.
      //
      // UNPROVEN, so it cannot overwrite a standing refusal: losing the database does not mean the
      // instance that holds the lease stopped trading — if anything it is the same outage.
      return this.adoptUnproven(
        {
          kind: "unavailable",
          detail:
            "durable persistence is unavailable, so exclusive execution ownership cannot be " +
            "established or proven. Live order dispatch stays refused until PostgreSQL is reachable.",
        },
        null,
      );
    }
    const account = this.deps.account();
    if (account === null || account.trim() === "") {
      // Also UNPROVEN: an account that can no longer be resolved is not evidence that a previously
      // proven foreign owner went away, and the scope cannot be computed to retire the evidence.
      return this.adoptUnproven(
        {
          kind: "inactive",
          detail:
            "the live broker account is not proven yet, so there is nothing to lease. Live dispatch " +
            "stays refused until the account is known, because an unknown account cannot be fenced.",
        },
        null,
      );
    }
    const broker = this.deps.broker();
    const scope = executionLeaseScope({ deployment: this.deps.deployment, broker, account });

    // A change of scope (broker switch, account replacement) means the old lease is meaningless here.
    // Release it FENCE-PINNED before taking the new one, so we never hold two.
    if (this.currentScope !== null && this.currentScope !== scope) {
      await this.releaseCurrent("the broker or account changed");
    }

    const held = this.state.kind === "held" ? this.state.lease : null;
    if (held !== null && held.scope === scope) {
      // THE CALL IS TIMED, and its duration is charged against the lifetime the row reports. The server
      // stamped `clock_timestamp()` when the statement ran; by the time the answer is in this variable
      // that much of the lease is already gone. See `ObservedLease.remainingAtObservationMs`.
      const renewIssuedAt = this.now();
      const renewElapsedMs = (): number => Math.max(0, this.now() - renewIssuedAt);
      const renewed = await this.store.renew({
        scope,
        owner: held.owner,
        fence: held.fence,
        ttlMs: this.ttl(),
      }).catch((err: unknown) => {
        this.log(
          `[Box] the execution lease heartbeat could not reach PostgreSQL (${
            err instanceof Error ? err.message : String(err)
          }); the cached observation will age out and dispatch will refuse.`,
        );
        return undefined;
      });
      if (renewed === undefined) {
        // A transient database fault. Do NOT declare the lease lost — we may still hold it, and
        // declaring loss would needlessly stop protective reduction. The cached observation ages out
        // on its own, which refuses dispatch at the guard without inventing a state transition.
        return this.state;
      }
      if (renewed === null) {
        return this.adopt({
          kind: "lost",
          scope,
          detail:
            "the execution lease was not renewable — it lapsed and may have been taken over by " +
            "another instance. New entry is stopped. Do NOT assume this process's in-flight broker " +
            "requests were cancelled: a lease cannot retract a request already sent.",
        });
      }
      const renewedState = this.adopt({ kind: "held", lease: this.observe(renewed, renewElapsedMs()) });
      // RETRY RECONCILIATION ON EVERY RENEWAL while it is still outstanding. Attempting it only at
      // acquisition left entry blocked forever whenever the first pass could not complete — which is
      // the common case, because ownership is established before the broker session is necessarily
      // usable. `reconcileTakeover` is idempotent and single-flighted, so calling it often is free.
      if (!renewed.takeover_reconciled_at) void this.reconcileTakeover();
      return renewedState;
    }

    const acquireIssuedAt = this.now();
    const acquired = await this.store.acquire({
      deployment: this.deps.deployment,
      broker,
      account,
      owner: this.deps.owner,
      instance: this.deps.instance,
      ttlMs: this.ttl(),
    }).catch((err: unknown) => ({
      ok: false as const,
      reason: "unavailable" as const,
      detail: `the execution lease could not be acquired (${err instanceof Error ? err.message : String(err)})`,
      holder: null,
    }));
    const acquireElapsedMs = Math.max(0, this.now() - acquireIssuedAt);

    if (!acquired.ok) {
      this.currentScope = scope;
      if (acquired.reason === "held_by_other") {
        this.log(`[Box] EXECUTION LEASE REFUSED: ${acquired.detail}`);
        return this.adopt({
          kind: "refused",
          scope,
          detail: acquired.detail,
          holder: acquired.holder?.owner ?? null,
        });
      }
      // NOT AUTHORITATIVE. `unavailable` here means the store could not answer — a thrown driver error,
      // a failed fence-sequence read, PostgreSQL unreachable. That is "cannot tell", and it must never
      // erase a `refused`/`lost` we already proved for this scope, because doing so would re-permit
      // exposure reduction while the other owner is still live. See `adoptUnproven`.
      return this.adoptUnproven({ kind: "unavailable", detail: acquired.detail }, scope);
    }

    this.currentScope = scope;
    const observed = this.observe(acquired.lease, acquireElapsedMs);
    const next = this.adopt({ kind: "held", lease: observed });
    if (acquired.took_over) {
      this.log(
        `[Box] EXECUTION LEASE TAKEN OVER for ${broker} account ${account} (fence ${acquired.lease.fence}). ` +
          "New entry stays refused until the previous owner's pending broker operations are reconciled.",
      );
    }
    // Both a takeover AND a fresh acquisition must establish broker state before new entry. A clean
    // handover leaves open positions and possibly working orders behind just as a crash does.
    if (!observed.reconciled) void this.reconcileTakeover();
    return next;
  }

  /**
   * Reconcile the predecessor's pending/ambiguous broker operations, then stamp the lease.
   *
   * Runs at most once at a time and never blocks acquisition: the lease is already held, and holding
   * it is what makes the reconciliation safe to perform. Until it succeeds, `dispatchBlockReason`
   * withholds new entry while continuing to permit reduction.
   */
  private async reconcileTakeover(): Promise<void> {
    if (this.reconcileInFlight || this.disposed) return;
    const state = this.state;
    if (state.kind !== "held" || state.lease.reconciled) return;
    const reconcile = this.deps.reconcileAfterTakeover;
    if (reconcile === undefined) {
      // Nothing was injected to reconcile with. Leaving the stamp unset is the honest outcome: new
      // entry stays refused rather than being permitted on an unverified takeover.
      this.log(
        "[Box] the execution lease was taken over but no takeover reconciler is wired, so new entry " +
          "stays refused. Protective reduction and cancellation remain available.",
      );
      return;
    }
    this.reconcileInFlight = true;
    const { scope, owner, fence } = state.lease;
    try {
      const ok = await reconcile();
      if (!ok) {
        this.log(
          "[Box] takeover reconciliation did not complete, so new entry stays refused for this " +
            "account. Reduction and cancellation remain available.",
        );
        return;
      }
      const stampIssuedAt = this.now();
      const stamped = await this.store.markReconciled({ scope, owner, fence });
      const stampElapsedMs = Math.max(0, this.now() - stampIssuedAt);
      if (stamped === null) {
        // We lost the lease while reconciling. Refuse rather than claim a reconciled takeover.
        this.adopt({
          kind: "lost",
          scope,
          detail:
            "the execution lease lapsed while reconciling the previous owner's broker operations, so " +
            "it may now belong to another instance",
        });
        return;
      }
      this.adopt({ kind: "held", lease: this.observe(stamped, stampElapsedMs) });
      this.log("[Box] takeover reconciliation complete; this instance now owns execution for the account.");
    } catch (err) {
      this.log(
        `[Box] takeover reconciliation failed (${err instanceof Error ? err.message : String(err)}); ` +
          "new entry stays refused for this account.",
      );
    } finally {
      this.reconcileInFlight = false;
    }
  }

  /**
   * Turn a database row into the cached observation the synchronous guard reads.
   *
   * `dbCallElapsedMs` is the MEASURED duration of the statement that produced the row, from a monotonic
   * reading taken before the call to one taken after. It is subtracted from the reported lifetime
   * because the server's `clock_timestamp()` was read at some unknown point inside that window, so every
   * millisecond of it is lease life that may already have been spent. Omitting it was defect (2): a
   * slow or queued response made the cached lease look valid for longer than the row actually was,
   * which is exactly the window in which a successor takes over.
   */
  private observe(row: ExecutionLeaseRow, dbCallElapsedMs: number): ObservedLease {
    // A DIFFERENCE of two readings of the same server clock. No local INSTANT participates — only the
    // locally-measured DURATION of the call, as a deduction.
    const reportedLifeMs = Math.max(0, row.expires_at - row.server_now);
    return {
      scope: row.scope,
      owner: row.owner,
      fence: row.fence,
      account: row.account,
      broker: row.broker,
      // Floored, never rounded: a fractional millisecond of claimed life is not worth having, and
      // rounding UP would hand back part of what the deduction just took away.
      remainingAtObservationMs: Math.max(0, Math.floor(reportedLifeMs - Math.max(0, dbCallElapsedMs))),
      observedAtLocal: this.now(),
      reconciled: row.takeover_reconciled_at !== null,
      takeoverReason: row.takeover_reason,
    };
  }

  /**
   * Install a state on AUTHORITY: the database answered, or this process itself released.
   *
   * Everything that is not authoritative must go through {@link adoptUnproven} instead.
   */
  private adopt(state: ExecutionLeaseState): ExecutionLeaseState {
    this.state = state;
    return state;
  }

  /**
   * ────────────────────────────────────────────────────────────────────────────────────────────────
   * PROVEN-FOREIGN EVIDENCE OUTRANKS "CANNOT TELL". THIS IS A SAFETY RULE, NOT A TIDINESS RULE.
   *
   * `unavailable` and `inactive` both mean "no evidence either way", and `dispatchBlockReason`
   * deliberately PERMITS exposure reduction in that case — refusing it would strand real positions for
   * a reason that is not evidence of anything. `refused` and `lost` mean the opposite: something
   * authoritative said another instance owns this account, and BOTH directions must stop, because two
   * processes flattening one position double-close it and two processes cancelling race each other.
   *
   * The defect this method exists to prevent: the acquire path could not distinguish "the lease is held
   * by someone else" from "I could not ask". A single `catch` on the store call — or the store's own
   * non-unique-violation catch, or a failed fence-sequence read — produced `reason: "unavailable"`, and
   * writing that over an existing `refused` DISCARDED the proof that a second owner exists. The state
   * went from "block both directions" to "reduction permitted" purely because a query failed, so a
   * database blip could reopen exactly the concurrent-flatten race the lease is for. Nothing about a
   * failed query is evidence that the other owner went away; in fact the most likely cause of a lease
   * store error — PostgreSQL being unreachable — leaves the other owner running untouched.
   *
   * THE RULE: once a proven-foreign state is installed for a scope, only an authoritative answer about
   * that scope may replace it —
   *   · a successful acquire/renew (`held`): we now demonstrably own it, which is proof the refusal is
   *     stale. This is the "authoritative reacquisition" the rule waits for;
   *   · another proven-foreign answer (`refused`/`lost`): still foreign, only the detail changes;
   *   · an authoritative clear via {@link adopt} — a fence-pinned release, a scope this manager no
   *     longer leases, or a deployment that cannot place live orders at all.
   * A mere failure to ask changes nothing and is logged rather than applied.
   *
   * SCOPE IS PART OF THE RULE. A broker switch or account replacement makes an old refusal irrelevant —
   * it was about a different account — so evidence is retired when the incoming state is known to
   * concern a DIFFERENT scope. When either scope is unknown the evidence is KEPT, because "I cannot
   * prove the scope changed" is not proof that it did.
   * ────────────────────────────────────────────────────────────────────────────────────────────────
   */
  private adoptUnproven(
    next: Extract<ExecutionLeaseState, { kind: "unavailable" | "inactive" }>,
    scope: string | null,
  ): ExecutionLeaseState {
    const current = this.state;
    if (current.kind === "refused" || current.kind === "lost") {
      const sameScope = current.scope === null || scope === null || current.scope === scope;
      if (sameScope) {
        this.log(
          `[Box] the execution lease could not be re-established (${next.detail}) — KEEPING the ` +
            `existing ${current.kind} state, because a failure to ask is not evidence that the other ` +
            "owner released the account. Both new entry and exposure reduction stay refused until an " +
            "acquisition actually succeeds.",
        );
        return current;
      }
    }
    return this.adopt(next);
  }

  /**
   * Verify the durable store, then acquire and start heartbeating.
   *
   * Never throws: a failure leaves the manager in `unavailable`, which refuses live dispatch — the
   * safe direction — rather than preventing boot. Refusing to boot would also refuse to monitor,
   * reconcile and flatten real exposure, which is the trade-off the reservation layer already makes.
   */
  async initialise(): Promise<void> {
    if (!this.deps.liveCapable()) {
      this.adopt({
        kind: "inactive",
        detail: "this deployment cannot place live orders, so no execution lease is required",
      });
      return;
    }
    if (this.deps.persistenceAvailable()) {
      try {
        await this.store.ready();
      } catch (err) {
        // Unproven: a store that cannot be verified says nothing about who owns the account.
        this.adoptUnproven(
          {
            kind: "unavailable",
            detail: err instanceof Error ? err.message : String(err),
          },
          null,
        );
        this.startHeartbeat();
        return;
      }
    }
    await this.refresh();
    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null || this.disposed) return;
    const period = Math.max(1_000, this.deps.heartbeatMs ?? DEFAULT_EXECUTION_LEASE_HEARTBEAT_MS);
    const set = this.deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.heartbeat = set(() => {
      void this.refresh();
    }, period);
    // Never hold the event loop open for a heartbeat.
    this.heartbeat?.unref?.();
  }

  /** Release this process's lease, fence-pinned. Safe to call when we hold nothing. */
  private async releaseCurrent(why: string): Promise<void> {
    const state = this.state;
    const scope = this.currentScope;
    if (state.kind !== "held" || scope === null) {
      this.currentScope = null;
      return;
    }
    try {
      const removed = await this.store.release({
        scope,
        owner: state.lease.owner,
        fence: state.lease.fence,
      });
      this.log(
        `[Box] released the execution lease for ${state.lease.broker} account ${state.lease.account} ` +
          `(${why}); ${removed} row(s) removed.`,
      );
    } catch (err) {
      // A failed release is not a safety problem: the TTL reaps it. Log and carry on.
      this.log(
        `[Box] could not release the execution lease (${err instanceof Error ? err.message : String(err)}); ` +
          "it will lapse on its TTL instead.",
      );
    }
    this.currentScope = null;
    this.adopt({ kind: "inactive", detail: `the execution lease was released (${why})` });
  }

  /**
   * Stop heartbeating. SYNCHRONOUS, so the engine's synchronous `dispose()` can keep its "every timer
   * this object owns is cleared" property without awaiting a database write.
   *
   * Stopping the heartbeat alone is already safe: the cached observation ages out, and once it is
   * inside the guard margin `dispatchBlockReason` refuses. Release is a separate, awaited step.
   */
  stopHeartbeat(): void {
    this.disposed = true;
    if (this.heartbeat !== null) {
      const clear = this.deps.clearTimer ?? ((t: NodeJS.Timeout) => clearInterval(t));
      clear(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /**
   * Release this process's lease so a successor need not wait out the TTL.
   *
   * AN OPTIMISATION, NOT A GUARANTEE. `kill -9` never reaches here, which is exactly why expiry is the
   * backstop. Releasing cleanly only shortens a successor's wait.
   *
   * Must run BEFORE `closePg()` in the shutdown sequence, since it is a database write. Idempotent.
   */
  async release(): Promise<void> {
    this.stopHeartbeat();
    await this.releaseCurrent("the process is shutting down");
  }

  /** Stop heartbeating and release. Convenience for tests and non-staged teardown. */
  async dispose(): Promise<void> {
    await this.release();
  }

  /** Read the durable row directly. For status/diagnostics only — never for a dispatch decision. */
  async inspect(): Promise<ExecutionLeaseRow | null> {
    const scope = this.currentScope;
    if (scope === null) return null;
    return this.store.read(scope).catch(() => null);
  }
}

/** The status projection, kept pure and separately testable. */
export interface ExecutionLeaseStatus {
  /** Whether a lease is required at all in this deployment. */
  readonly required: boolean;
  readonly state: ExecutionLeaseState["kind"];
  readonly detail: string;
  readonly owner: string | null;
  readonly fence: number | null;
  readonly account: string | null;
  /** Null when not held. Otherwise the provable life remaining at the last observation. */
  readonly provable_life_ms: number | null;
  /** False when a takeover has not yet reconciled the previous owner's pending operations. */
  readonly reconciled: boolean;
  /** True when this process may start new entry as far as ownership is concerned. */
  readonly may_enter: boolean;
  /** True when this process may reduce/cancel as far as ownership is concerned. */
  readonly may_reduce: boolean;
}

export function executionLeaseStatus(args: {
  readonly state: ExecutionLeaseState;
  readonly liveCapable: boolean;
  readonly entryBlockReason: string | null;
  readonly reductionBlockReason: string | null;
}): ExecutionLeaseStatus {
  const held = args.state.kind === "held" ? args.state.lease : null;
  return {
    required: args.liveCapable,
    state: args.state.kind,
    detail: args.state.kind === "held"
      ? `execution ownership is held for ${held?.broker ?? "?"} account ${held?.account ?? "?"}` +
        (held?.reconciled === false
          ? held.takeoverReason === "fresh"
            ? " (broker state not yet reconciled: new entry refused)"
            : " (takeover not yet reconciled: new entry refused)"
          : "")
      : args.state.detail,
    owner: held?.owner ?? null,
    fence: held?.fence ?? null,
    account: held?.account ?? null,
    provable_life_ms: held?.remainingAtObservationMs ?? null,
    reconciled: held?.reconciled ?? false,
    may_enter: args.entryBlockReason === null,
    may_reduce: args.reductionBlockReason === null,
  };
}
