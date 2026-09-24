/**
 * SERVER-SIDE OPERATION IDENTITY FOR EXPOSURE-REDUCING ACTIONS.
 *
 * WHY THIS EXISTS, AND WHY THE OBVIOUS FIX IS WRONG
 *
 * A browser that gives up on a request does NOT cancel the server operation. `AbortController` closes
 * the client's end of the socket; the handler keeps running, the broker calls keep going, and the
 * reduction keeps happening. So bounding the client's wait — which the frontend now does — creates a
 * new hazard rather than removing one: the operator sees a timeout, presses the button again, and a
 * SECOND cancellation or flatten begins while the first is still working. Two flattens racing the same
 * exposure can double-close it; two cancels racing the same order interleave with its fills.
 *
 * The tempting fix on the client — release the in-flight lock so the second click is allowed — makes
 * this strictly worse. The lock has to be released (otherwise the panic button is dead, which was the
 * original defect) AND the server has to refuse to perform the work twice. This module is the server
 * half.
 *
 * WHAT IT DOES
 *
 * One named slot per operation KIND. A second caller arriving while a slot is occupied does not start a
 * second operation and is not given a fabricated failure: it JOINS the operation already running and
 * receives that operation's real result, tagged with the shared `operation_id` and `deduplicated:
 * true`. The operator therefore learns what actually happened rather than being told "no" about work
 * that is in fact in progress.
 *
 * WHY JOIN RATHER THAN REFUSE. A refusal would be a lie by omission — it reports nothing about the
 * exposure, which is the one thing the operator needs. Joining cannot cause a second broker action, and
 * if the first operation never settles the joiner waits exactly as long as the original would have,
 * which the client's own deadline already bounds.
 *
 * KINDS ARE INDEPENDENT ON PURPOSE. A wedged `cancel_working` must not block `flatten` — that coupling
 * is precisely the frontend defect this work also fixes. The one deliberate exception is that flatten's
 * INTERNAL cancellation sweep joins an in-flight external sweep instead of issuing a duplicate, which
 * is dedup rather than blocking.
 *
 * WHAT IT IS NOT. It is not a distributed lock. It bounds duplicate work within ONE process. Two
 * processes are bounded by the account-scoped execution lease (`executionLease.ts`), which is a
 * different mechanism for a different problem.
 */

import { randomUUID } from "node:crypto";

/** The exposure-reducing operations that must not be performed twice concurrently. */
export type ExposureOperationKind = "cancel_working" | "flatten";

export interface ExposureOperationOutcome<T> {
  /** Stable identity for this unit of work. Shared by every caller that joined it. */
  readonly operation_id: string;
  /** Wall clock when the operation actually began. */
  readonly started_at: number;
  /** True when this caller did NOT start the work and instead joined one already running. */
  readonly deduplicated: boolean;
  readonly result: T;
}

interface InFlight {
  readonly operationId: string;
  readonly startedAt: number;
  readonly promise: Promise<unknown>;
}

export class ExposureOperationRegistry {
  private readonly inFlight = new Map<ExposureOperationKind, InFlight>();

  constructor(
    private readonly deps: {
      readonly now?: () => number;
      readonly newId?: () => string;
      readonly log?: (message: string) => void;
    } = {},
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private mint(kind: ExposureOperationKind): string {
    const id = this.deps.newId ? this.deps.newId() : randomUUID();
    return `${kind}:${id}`;
  }

  /**
   * Run `fn` under the slot for `kind`, or join the operation already there.
   *
   * REJECTIONS PROPAGATE TO EVERY JOINER. A caller that joined a failing operation must see the same
   * failure: reporting success to the joiner because it personally did nothing would be exactly the
   * misreporting this whole change set is about. The slot is released in a `finally`, so a rejection
   * cannot wedge it.
   */
  async run<T>(kind: ExposureOperationKind, fn: () => Promise<T>): Promise<ExposureOperationOutcome<T>> {
    const existing = this.inFlight.get(kind);
    if (existing !== undefined) {
      this.deps.log?.(
        `[Box] a ${kind} operation (${existing.operationId}) started ${this.now() - existing.startedAt}ms ` +
          "ago is still running; this request JOINS it rather than starting a second one. No additional " +
          "broker action will be taken.",
      );
      // Await the SAME promise. No second `fn()` is invoked, so no second broker action occurs.
      const result = (await existing.promise) as T;
      return {
        operation_id: existing.operationId,
        started_at: existing.startedAt,
        deduplicated: true,
        result,
      };
    }

    const operationId = this.mint(kind);
    const startedAt = this.now();
    // Register BEFORE the first await inside `fn` can yield, so two synchronous callers cannot both
    // find the slot empty. `fn()` is invoked after the map is written for the same reason.
    let settle: (value: unknown) => void = () => {};
    let fail: (reason: unknown) => void = () => {};
    const gate = new Promise<unknown>((res, rej) => { settle = res; fail = rej; });
    // The gate exists only so a JOINER can await this operation. When nobody joins and the operation
    // fails, rejecting it would be an unhandled rejection — a process-level warning (and a crash under
    // `--unhandled-rejections=strict`) caused purely by the bookkeeping. Attaching an inert handler
    // marks it handled without affecting any real consumer: a joiner that awaits `gate` still sees the
    // rejection, because `catch` returns a NEW promise and does not disarm this one.
    gate.catch(() => undefined);
    this.inFlight.set(kind, { operationId, startedAt, promise: gate });

    try {
      const result = await fn();
      settle(result);
      return { operation_id: operationId, started_at: startedAt, deduplicated: false, result };
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      // Only clear OUR registration. A slot re-taken by a later operation must not be removed by this
      // one's completion — the same fence-pinning discipline the execution lease uses for release.
      const current = this.inFlight.get(kind);
      if (current !== undefined && current.operationId === operationId) this.inFlight.delete(kind);
    }
  }

  /** Whether an operation of this kind is running, for status projections. */
  isRunning(kind: ExposureOperationKind): boolean {
    return this.inFlight.has(kind);
  }

  /** The in-flight operation's identity and age, or null. For status and for operator messages. */
  describe(kind: ExposureOperationKind): { operation_id: string; age_ms: number } | null {
    const existing = this.inFlight.get(kind);
    if (existing === undefined) return null;
    return { operation_id: existing.operationId, age_ms: Math.max(0, this.now() - existing.startedAt) };
  }

  /** Every running operation, for the status projection. */
  snapshot(): { kind: ExposureOperationKind; operation_id: string; age_ms: number }[] {
    const out: { kind: ExposureOperationKind; operation_id: string; age_ms: number }[] = [];
    for (const [kind, entry] of this.inFlight) {
      out.push({
        kind,
        operation_id: entry.operationId,
        age_ms: Math.max(0, this.now() - entry.startedAt),
      });
    }
    return out;
  }
}
