/**
 * BACKEND INSTANCE IDENTITY — how a client orders readiness decisions ACROSS a restart.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS FIXES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The readiness decision carries `decision_generation`, incremented once per decision by
 * `private readinessDecisionGeneration = 0`. It is PROCESS-LOCAL. The frontend accepts a decision
 * only when its generation is strictly greater than the one already rendered — correct for ordering
 * concurrent responses from one process, and completely wrong across a restart:
 *
 *     browser has rendered generation 5000
 *     backend restarts; its counter resets; it publishes generation 1
 *     5000 > 1  ⇒  the browser rejects 1, and 2, and 3, … indefinitely
 *
 * The dashboard then shows a permission verdict from a process that no longer exists, and keeps
 * showing "entry permitted" long after the new process has decided otherwise. Only a manual reload
 * clears it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ORDERING PROTOCOL, AND WHY IT WORKS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A decision is ordered by the pair (`boot_ordinal`, `decision_generation`), compared
 * lexicographically, with `instance_id` used only to tell whether we are still talking to the same
 * process:
 *
 *   same instance_id      → order by decision_generation (strictly increasing). Unchanged behaviour;
 *                           this is what already fixed out-of-order concurrent responses.
 *   higher boot_ordinal   → a genuinely NEWER process. ADOPT it and rebase the sequence, so a
 *                           restart is picked up without a manual refresh.
 *   lower boot_ordinal    → a delayed response from a process we have already superseded. REJECT.
 *   equal ordinal, different instance_id
 *                         → two processes claim the same epoch, which the single-instance topology
 *                           forbids. INCOMPATIBLE: refuse, and disable new entry with that reason,
 *                           rather than interleaving two processes' verdicts.
 *   ordinal missing (null)
 *                         → UNORDERABLE. Never allowed to overwrite an ordered decision, and
 *                           reported as incompatible so new entry is disabled.
 *
 * WHY AN ORDINAL RATHER THAN A RANDOM ID. A random per-boot identifier tells a client the instance
 * CHANGED but not which one is NEWER. A client would then have to either trust any unfamiliar id —
 * in which case a delayed response from the OLD process gets adopted as new, the same bug pointing
 * the other way — or trust none, which is where we started. Ordering requires an order.
 *
 * WHY NOT A CLOCK. Wall clocks cannot carry this: an NTP step, a VM snapshot restore, or a container
 * booting with a skewed clock each produce an "older" instance that looks newer. Correctness here
 * depends on no clock at all.
 *
 * WHY POSTGRESQL. It is already the operational authority in this system, and
 * `UPDATE … SET last_ordinal = last_ordinal + 1 RETURNING last_ordinal` is atomic, so two concurrent
 * boots receive DISTINCT ordinals and neither can observe the other's value. Minting the ordinal from
 * the same authority that orders everything else is what makes "newer" mean something.
 *
 * FAIL-CLOSED WHEN THE AUTHORITY IS ABSENT. If PG cannot be reached at boot the ordinal is null and
 * the decision is unorderable, which disables new entry. That is the correct reading rather than an
 * inconvenience: a backend that cannot reach its authoritative store must not be authorising new
 * exposure, and the engine independently refuses entry in that state for the same reason.
 */

import { randomUUID } from "node:crypto";

import { query } from "../pg/pool.js";

/**
 * The only shape of the epoch query this class reads.
 *
 * Narrowed to exactly what is used, and injectable, so the behaviours that matter — the single-flight
 * guard, the transient/permanent split, and that a settled claim never issues a second `UPDATE` — are
 * unit-testable without PostgreSQL. Those are precisely the properties a DB-backed test cannot force
 * on demand: a real database will not fail when you need it to.
 */
export type EpochQuery = (
  sql: string,
) => Promise<{ readonly rows: readonly { readonly last_ordinal: string | number }[] }>;

/** The identity a client needs in order to place a readiness decision in a total order. */
export interface BackendInstanceIdentity {
  /**
   * Identifies THIS process. Random and non-secret. Used only to detect that the instance changed;
   * it deliberately carries no ordering, because a random value cannot express "newer".
   */
  readonly instance_id: string;
  /**
   * Restart-durable, strictly increasing ordinal for this boot, from PostgreSQL.
   *
   * NULL means it could not be established — the authoritative store was unreachable at boot. Null
   * is NOT zero and must never be compared as a number: a client treats a null-ordinal decision as
   * unorderable and refuses to adopt it over an ordered one.
   */
  readonly boot_ordinal: number | null;
  /** Wall-clock ms this process started. AUDIT ONLY — never used for ordering. */
  readonly started_at: number;
}

/**
 * Mint the identity for this process.
 *
 * `instance_id` is available immediately; `boot_ordinal` requires the database and is therefore
 * resolved asynchronously by {@link resolveBootOrdinal}. Until it resolves, the identity reports a
 * null ordinal — which is honest: at that point we genuinely cannot order ourselves against a
 * previous instance.
 */
export class BackendInstance {
  private readonly instanceId: string;
  private readonly startedAt: number;
  private bootOrdinal: number | null = null;
  private resolved = false;
  private lastError: string | null = null;
  /**
   * The claim currently in flight, so concurrent callers share one attempt.
   *
   * REQUIRED ONCE THERE IS A RETRY. The class documents itself as "idempotent per process — it can
   * never consume a second ordinal and make this process look newer than itself", and that held only
   * because there was exactly ONE call site. `this.resolved` cannot provide the guarantee on its own:
   * it stays false for the whole duration of an attempt AND after a transient failure, so two
   * overlapping calls would both reach the `UPDATE … last_ordinal + 1` and consume two ordinals. That
   * would not merely waste a number — the process would hold the lower one while the database had
   * advanced past it, so a later boot could mint an ordinal this process has already published.
   */
  private inFlight: Promise<number | null> | null = null;
  /**
   * The last failure text actually written to the log, so a slow retry loop reports a NEW problem and
   * stays quiet about an unchanged one. Without this, an hour of unreachable PostgreSQL would be
   * hundreds of identical lines and the one line that mattered would be buried.
   */
  private lastLoggedError: string | null = null;

  /** The epoch query. Production uses the real pool; tests inject to force failure modes. */
  private readonly runQuery: EpochQuery;

  constructor(opts?: {
    readonly instanceId?: string;
    readonly startedAt?: number;
    readonly query?: EpochQuery;
  }) {
    this.instanceId = opts?.instanceId ?? randomUUID();
    this.startedAt = opts?.startedAt ?? Date.now();
    this.runQuery = opts?.query ?? ((sql) => query<{ last_ordinal: string | number }>(sql));
  }

  identity(): BackendInstanceIdentity {
    return {
      instance_id: this.instanceId,
      boot_ordinal: this.bootOrdinal,
      started_at: this.startedAt,
    };
  }

  /** True once the durable ordinal has been established. */
  hasOrdinal(): boolean {
    return this.bootOrdinal !== null;
  }

  /** Why the ordinal could not be established, or null. Operator-visible; never a secret. */
  ordinalError(): string | null {
    return this.lastError;
  }

  /**
   * True when the ordinal will NEVER be established by this process, so retrying is pointless.
   *
   * Distinguishes the two failure kinds a caller must treat differently:
   *
   *   DEPLOYMENT ERROR — migration 009 not applied, or the row holds an unusable value. Both mark
   *                      themselves resolved, because no amount of retrying fixes an absent row.
   *   TRANSIENT        — PostgreSQL was unreachable. Deliberately NOT resolved, so a retry can
   *                      succeed and this process can stop being unorderable.
   *
   * Exposed so a retry driver can stop on the first kind instead of hammering the database forever
   * over a condition only a deployment can fix.
   */
  permanentlyUnavailable(): boolean {
    return this.resolved && this.bootOrdinal === null;
  }

  /**
   * Claim this boot's ordinal from PostgreSQL. Idempotent per process: the ordinal is claimed ONCE,
   * so a retried or repeated call cannot consume a second ordinal and make this process look newer
   * than itself.
   *
   * Never throws. A failure leaves the ordinal null, which the readiness decision publishes as
   * unorderable and which disables new entry — the same direction the rest of the system fails when
   * the authoritative store is unavailable.
   */
  async resolveBootOrdinal(): Promise<number | null> {
    if (this.resolved) return this.bootOrdinal;
    // Share one attempt. See `inFlight` for why `resolved` alone cannot guarantee this.
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.claimOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * One claim attempt. Never throws; the caller decides whether to try again.
   *
   * REPORTS ITSELF TO THE LOG, which it previously did not. The failure text was stored in
   * `lastError` and surfaced only inside the `instance_epoch_unknown` readiness blocker, so
   * `pm2 logs … | grep "boot ordinal"` found nothing and an operator investigating "new entry is
   * disabled" had no way to see the cause from the log at all. A fail-closed condition that refuses
   * trading must say so where failures are read.
   */
  private async claimOnce(): Promise<number | null> {
    try {
      // Atomic read-modify-write. Two concurrent boots serialise on the row lock and receive
      // DISTINCT ordinals; neither can observe the other's value or reuse it.
      const result = await this.runQuery(
        `UPDATE backend_instance_epoch
            SET last_ordinal = last_ordinal + 1,
                updated_at = now()
          WHERE id = 1
        RETURNING last_ordinal`,
      );
      const row = result.rows[0];
      if (!row) {
        // The seed row is created by migration 009. Its absence means the migration has not been
        // applied, which is a deployment error and must not be papered over with a fabricated 0.
        this.lastError =
          "backend_instance_epoch has no row: migration 009_backend_instance_epoch.sql has not been applied, " +
          "so readiness decisions from this process cannot be ordered against a previous instance";
        this.resolved = true;
        this.report();
        return null;
      }
      const ordinal = typeof row.last_ordinal === "number" ? row.last_ordinal : Number(row.last_ordinal);
      if (!Number.isFinite(ordinal) || ordinal <= 0) {
        this.lastError = `backend_instance_epoch returned an unusable ordinal (${String(row.last_ordinal)})`;
        this.resolved = true;
        this.report();
        return null;
      }
      this.bootOrdinal = ordinal;
      this.lastError = null;
      this.resolved = true;
      // Say so when a RETRY is what got us here, so the log shows entry becoming possible rather
      // than only showing that it was refused.
      if (this.lastLoggedError !== null) {
        console.log(
          `[Box] durable boot ordinal CLAIMED (${ordinal}) after an earlier failure — readiness ` +
            `decisions from this process are now orderable and new entry is no longer refused for ` +
            `this reason.`,
        );
        this.lastLoggedError = null;
      }
      return ordinal;
    } catch (err) {
      this.lastError =
        `could not claim a boot ordinal from PostgreSQL (${err instanceof Error ? err.message : String(err)}); ` +
        `readiness decisions from this process cannot be ordered against a previous instance`;
      // Deliberately NOT marked resolved: a later attempt may succeed once the database is reachable,
      // and this process should stop being unorderable as soon as it can. That sentence was aspirational
      // until BoxEngine.ensureBootOrdinalClaim() existed — there was one fire-and-forget call site, so
      // a single transient failure left the process unorderable, refusing entry, for its whole life.
      this.report();
      return null;
    }
  }

  /** Write a failure to the log, but only when it is not the one already reported. */
  private report(): void {
    if (this.lastError === null || this.lastError === this.lastLoggedError) return;
    this.lastLoggedError = this.lastError;
    console.warn(
      `[Box] NEW ENTRY IS REFUSED: ${this.lastError}. Exposure management is unaffected — exits, ` +
        `reductions and protective cancels do not depend on this. ` +
        (this.permanentlyUnavailable()
          ? "This will NOT retry: apply the migration and restart."
          : "This will keep retrying until PostgreSQL answers."),
    );
  }
}

/* ─────────────────────────── the ordering rule, shared with the frontend ─────────────────────────── */

/**
 * The ORDERING DECISION for one incoming readiness decision, as a closed union so every outcome is
 * named and handled rather than collapsed into a boolean.
 */
export type ReadinessOrderVerdict =
  /** First orderable decision, or a strictly newer generation from the SAME instance. */
  | { readonly kind: "accept"; readonly reason: string }
  /** A genuinely newer process. The client must rebase its sequence baseline onto this instance. */
  | { readonly kind: "adopt_new_instance"; readonly reason: string }
  /** Older, or a delayed response from a superseded instance. Discard without changing anything. */
  | { readonly kind: "reject_stale"; readonly reason: string }
  /**
   * Cannot be placed in the order at all: no ordinal, or two instances claiming one epoch. The client
   * must refuse it AND disable new entry, because "possibly older" must not overwrite "known
   * current", and an unorderable permission verdict is not a permission.
   */
  | { readonly kind: "reject_incompatible"; readonly reason: string };

/** What a client currently has rendered. Null instance ⇒ nothing rendered yet. */
export interface RenderedReadinessOrder {
  readonly instanceId: string | null;
  readonly bootOrdinal: number | null;
  readonly decisionGeneration: number | null;
}

/** The ordering fields of an incoming decision. */
export interface IncomingReadinessOrder {
  readonly instanceId: string | null;
  readonly bootOrdinal: number | null;
  readonly decisionGeneration: number | null;
}

/**
 * Decide whether an incoming readiness decision may replace what is rendered.
 *
 * PURE and clock-free, and deliberately exported from the backend so the frontend vendors the SAME
 * rule rather than reimplementing it. Two implementations of an ordering protocol is how the two
 * sides come to disagree about which verdict is current.
 */
export function orderReadinessDecision(
  rendered: RenderedReadinessOrder,
  incoming: IncomingReadinessOrder,
): ReadinessOrderVerdict {
  const inGen = incoming.decisionGeneration;
  if (inGen === null || !Number.isFinite(inGen)) {
    return {
      kind: "reject_incompatible",
      reason: "the incoming decision carries no usable decision_generation, so it cannot be ordered",
    };
  }
  if (incoming.instanceId === null || incoming.instanceId === "") {
    return {
      kind: "reject_incompatible",
      reason:
        "the incoming decision carries no backend instance identity, so it cannot be ordered across a " +
        "restart; this backend predates the instance-aware readiness contract",
    };
  }
  const inOrdinal = incoming.bootOrdinal;
  if (inOrdinal === null || !Number.isFinite(inOrdinal)) {
    return {
      kind: "reject_incompatible",
      reason:
        "the backend could not establish a durable boot ordinal (its authoritative store was " +
        "unreachable at startup), so its readiness decisions cannot be ordered against a previous " +
        "instance and must not authorise new entry",
    };
  }

  // Nothing rendered yet: any orderable decision is a legitimate first paint.
  if (rendered.instanceId === null || rendered.decisionGeneration === null) {
    return { kind: "accept", reason: "first orderable readiness decision" };
  }

  // SAME PROCESS — order by the per-instance sequence, strictly. Equal is refused: re-applying the
  // same generation adds no information and would reset any freshness timer built on top of it.
  if (incoming.instanceId === rendered.instanceId) {
    return inGen > rendered.decisionGeneration
      ? { kind: "accept", reason: `newer decision from the same instance (${inGen} > ${rendered.decisionGeneration})` }
      : {
          kind: "reject_stale",
          reason: `out-of-order response from the same instance (${inGen} <= ${rendered.decisionGeneration})`,
        };
    }

  // DIFFERENT PROCESS — the ordinal decides, never the generation and never a clock.
  const renderedOrdinal = rendered.bootOrdinal;
  if (renderedOrdinal === null || !Number.isFinite(renderedOrdinal)) {
    // What is on screen was itself unorderable, so an orderable decision is strictly better evidence.
    return {
      kind: "adopt_new_instance",
      reason: "adopting an orderable decision over an unorderable one already rendered",
    };
  }
  if (inOrdinal > renderedOrdinal) {
    return {
      kind: "adopt_new_instance",
      reason:
        `a newer backend instance (boot ordinal ${inOrdinal} > ${renderedOrdinal}); adopting it and ` +
        `rebasing the decision sequence, so a restart is picked up without a manual refresh`,
    };
  }
  if (inOrdinal < renderedOrdinal) {
    return {
      kind: "reject_stale",
      reason:
        `a delayed response from a superseded backend instance (boot ordinal ${inOrdinal} < ` +
        `${renderedOrdinal}); discarded so it cannot rewind the adopted instance`,
    };
  }
  // Equal ordinals, different instance ids. The atomic ordinal claim makes this impossible for two
  // healthy processes against one database, so it means something is wrong that must not be papered
  // over: two databases, a restored snapshot, or more than one process on a topology that assumes one.
  return {
    kind: "reject_incompatible",
    reason:
      `two backend instances report the SAME boot ordinal ${inOrdinal} with different identities; ` +
      `the supported topology is a single process (see ecosystem.config.cjs), so this is refused and ` +
      `new entry is disabled rather than interleaving two processes' verdicts`,
  };
}
