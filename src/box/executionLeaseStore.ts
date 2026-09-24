/**
 * THE DURABLE HALF OF THE ACCOUNT-SCOPED EXECUTION LEASE.
 *
 * `executionLease.ts` holds the policy, the cached state and the heartbeat. This module holds the
 * SQL, and nothing else — every function here is one statement's worth of decision so that the
 * database, not this process, is what serialises contenders.
 *
 * Three rules shape every statement below:
 *
 *   1. THE SERVER'S CLOCK DECIDES EXPIRY. Every predicate compares against `clock_timestamp()`
 *      evaluated inside PostgreSQL, never against a timestamp a caller computed. Two processes with
 *      skewed clocks must still agree on whether a lease has lapsed, and the only clock they share is
 *      the database's. This is the same choice `reservations/pgStore.ts` makes for `serverTimeMs()`.
 *
 *   2. OWNERSHIP IS PROVED, NEVER ASSUMED. Renewal and release are pinned to `owner` AND `fence` AND
 *      an unexpired row. A lapsed lease cannot be renewed back to life, because by then a successor
 *      may hold it — resurrecting it would produce two owners. A release that is not fence-pinned
 *      would let a dead predecessor delete its successor's row, which is the exact hazard
 *      `reservations/port.ts` warns about for key-scoped deletes.
 *
 *   3. A ZERO `rowCount` IS AN ANSWER. It is never treated as "probably fine". Renewal returning zero
 *      rows means the lease is LOST, and the caller must stop dispatching.
 *
 * WHAT NONE OF THIS CAN DO. Acquiring the row bounds who may BEGIN a broker mutation. It cannot
 * retract an HTTP request that is already on the wire, and neither broker accepts a fencing token
 * that would let it reject one. See `docs/EXECUTION_OWNERSHIP.md`.
 */

import { boundedError, isUniqueViolation, query, withClient } from "../pg/pool.js";

/** The live state of one lease row, as the database has it. */
export interface ExecutionLeaseRow {
  readonly scope: string;
  readonly deployment: string;
  readonly broker: string;
  readonly account: string;
  readonly owner: string;
  readonly instance: string;
  readonly fence: number;
  readonly acquired_at: number;
  readonly renewed_at: number;
  readonly expires_at: number;
  /** Null until this owner reconciled the previous owner's pending broker operations. */
  readonly takeover_reconciled_at: number | null;
  readonly takeover_reason: string;
  /** The authority's clock at the instant this row was read. Lets a caller compute remaining TTL. */
  readonly server_now: number;
}

export type AcquireExecutionLeaseResult =
  | { readonly ok: true; readonly lease: ExecutionLeaseRow; readonly took_over: boolean }
  | {
      readonly ok: false;
      readonly reason: "held_by_other" | "unavailable";
      readonly detail: string;
      /** Present for `held_by_other`, so the operator can be told WHO holds it. */
      readonly holder: ExecutionLeaseRow | null;
    };

/** Build the durable scope key. Materialised so stored and requested scope cannot diverge. */
export function executionLeaseScope(args: {
  readonly deployment: string;
  readonly broker: string;
  readonly account: string;
}): string {
  return `${args.deployment}|${args.broker}|${args.account}`;
}

function ms(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value as string).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function msOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const at = ms(value);
  return at === 0 ? null : at;
}

function toRow(row: Record<string, unknown>): ExecutionLeaseRow {
  return {
    scope: String(row.scope ?? ""),
    deployment: String(row.deployment ?? ""),
    broker: String(row.broker ?? ""),
    account: String(row.account ?? ""),
    owner: String(row.owner ?? ""),
    instance: String(row.instance ?? ""),
    fence: Number(row.fence ?? 0),
    acquired_at: ms(row.acquired_at),
    renewed_at: ms(row.renewed_at),
    expires_at: ms(row.expires_at),
    takeover_reconciled_at: msOrNull(row.takeover_reconciled_at),
    takeover_reason: String(row.takeover_reason ?? "fresh"),
    server_now: ms(row.server_now),
  };
}

/** The projection every statement returns, so `server_now` is always the authority's clock. */
const RETURNING = `scope, deployment, broker, account, owner, instance, fence,
   acquired_at, renewed_at, expires_at, takeover_reconciled_at, takeover_reason,
   clock_timestamp() AS server_now`;

/**
 * Verify the lease table and the fence sequence exist.
 *
 * Refusing loudly here is the point: a build that enforces exclusivity must not silently degrade to
 * "no lease table, so everybody owns everything". The caller turns this into a readiness blocker.
 *
 * SCOPED THROUGH `search_path` VIA `to_regclass`, NOT by name through `pg_class`. `pg_class.relname`
 * is cluster-wide and only unique per schema, so `WHERE relname = 'box_execution_leases'` asks "does
 * any object anywhere in this database carry that name?" when it means "does the schema I am actually
 * running against have it?". That is precisely the defect migration 014 exists to repair, and it
 * reproduces here: with several test schemas in one database the probe passed while the table this
 * connection would use was absent. `to_regclass` resolves the name the way every other statement in
 * this module does.
 */
export async function ensureExecutionLeaseStoreReady(): Promise<void> {
  const { rows } = await query<{ tbl: string | null; seq: string | null }>(
    `SELECT to_regclass('box_execution_leases')::text AS tbl,
            to_regclass('box_reservation_fence_seq')::text AS seq`,
  );
  const probe = rows[0];
  if (!probe?.tbl) {
    throw new Error(
      "box_execution_leases is missing — run migrations. Without it, exclusive execution ownership " +
        "cannot be established and live entry must stay refused.",
    );
  }
  if (!probe.seq) {
    throw new Error("box_reservation_fence_seq is missing — run migrations");
  }
}

/**
 * ACQUIRE OR TAKE OVER the lease for one account.
 *
 * Three outcomes, decided by ONE statement so no window exists between checking and claiming:
 *
 *   · no row            → insert, `took_over = false`, reason 'fresh'
 *   · our own row       → renew it in place, fence UNCHANGED, reconciled flag PRESERVED. A process
 *                         reacquiring after a reconnect must not have to re-reconcile, and must not
 *                         bump its own fence (which would invalidate the fence its own in-flight
 *                         guards captured).
 *   · a LAPSED row      → take over: new owner, NEW fence, `takeover_reconciled_at` RESET TO NULL.
 *                         Null is what withholds new entry until pending broker work is reconciled.
 *   · a LIVE foreign row → refused. This is the case that stops a second process trading an account
 *                         that is already owned.
 *
 * The `WHERE box_execution_leases.expires_at <= clock_timestamp() OR .owner = EXCLUDED.owner` clause
 * on the conflict target is the whole safety property: a live foreign row matches neither disjunct, so
 * the UPDATE touches nothing and `rowCount` is 0.
 */
export async function acquireExecutionLease(args: {
  readonly deployment: string;
  readonly broker: string;
  readonly account: string;
  readonly owner: string;
  readonly instance: string;
  readonly ttlMs: number;
}): Promise<AcquireExecutionLeaseResult> {
  const scope = executionLeaseScope(args);
  const ttl = Math.max(1000, Math.floor(args.ttlMs));
  try {
    // The fence is drawn BEFORE the upsert. Drawing one we may not use is harmless (the sequence is
    // monotonic, not gapless, by design); drawing it inside the statement would require a CTE that
    // consumes a value on every renewal, which would make an owner's own fence change under it.
    const { rows: fenceRows } = await query<{ seq: string }>(
      `SELECT nextval('box_reservation_fence_seq') AS seq`,
    );
    const fence = Number(fenceRows[0]?.seq);
    if (!Number.isFinite(fence) || fence <= 0) {
      return {
        ok: false,
        reason: "unavailable",
        detail: "PostgreSQL did not return a fencing token for the execution lease",
        holder: null,
      };
    }

    const { rows } = await query<Record<string, unknown>>(
      `INSERT INTO box_execution_leases
         (scope, deployment, broker, account, owner, instance, fence,
          acquired_at, renewed_at, expires_at, takeover_reconciled_at, takeover_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               clock_timestamp(), clock_timestamp(),
               clock_timestamp() + ($8::bigint * interval '1 millisecond'),
               NULL, 'fresh')
       ON CONFLICT (scope) DO UPDATE SET
         owner      = EXCLUDED.owner,
         instance   = EXCLUDED.instance,
         -- OUR OWN row keeps its fence and its reconciled stamp; a takeover gets the new fence and a
         -- cleared stamp, which is what withholds new entry until reconciliation.
         fence      = CASE WHEN box_execution_leases.owner = EXCLUDED.owner
                           THEN box_execution_leases.fence ELSE EXCLUDED.fence END,
         acquired_at = CASE WHEN box_execution_leases.owner = EXCLUDED.owner
                            THEN box_execution_leases.acquired_at ELSE clock_timestamp() END,
         renewed_at = clock_timestamp(),
         expires_at = clock_timestamp() + ($8::bigint * interval '1 millisecond'),
         takeover_reconciled_at = CASE WHEN box_execution_leases.owner = EXCLUDED.owner
                                       THEN box_execution_leases.takeover_reconciled_at ELSE NULL END,
         takeover_reason = CASE WHEN box_execution_leases.owner = EXCLUDED.owner
                                THEN box_execution_leases.takeover_reason ELSE 'expired' END
       WHERE box_execution_leases.expires_at <= clock_timestamp()
          OR box_execution_leases.owner = EXCLUDED.owner
       RETURNING ${RETURNING}`,
      [scope, args.deployment, args.broker, args.account, args.owner, args.instance, fence, ttl],
    );

    const row = rows[0];
    if (row) {
      const lease = toRow(row);
      return { ok: true, lease, took_over: lease.fence === fence && lease.takeover_reason !== "fresh" };
    }

    // Nothing updated ⇒ a LIVE row owned by somebody else. Read it so the refusal can name the holder.
    const holder = await readExecutionLease(scope);
    return {
      ok: false,
      reason: "held_by_other",
      detail:
        `the execution lease for ${args.broker} account ${args.account} is held by another live ` +
        `instance (${holder?.owner ?? "unknown owner"}` +
        (holder ? `, expires in ${Math.max(0, holder.expires_at - holder.server_now)}ms` : "") +
        "). This process will NOT submit orders for that account. Exactly one instance may execute " +
        "per account; stop the other instance or wait for its lease to lapse.",
      holder,
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Two fresh inserts raced and the other won between our conflict check and write. Treat exactly
      // as a live foreign holder: we did not get it.
      const holder = await readExecutionLease(scope).catch(() => null);
      return {
        ok: false,
        reason: "held_by_other",
        detail:
          "another instance acquired the execution lease for this account at the same instant; " +
          "this process will NOT submit orders for it",
        holder,
      };
    }
    return {
      ok: false,
      reason: "unavailable",
      detail: `the execution lease could not be acquired (${boundedError(err)})`,
      holder: null,
    };
  }
}

/**
 * RENEW a lease we believe we hold. Returns null when we do NOT hold it any more.
 *
 * `owner = $2 AND fence = $3 AND expires_at > clock_timestamp()` makes this a genuine ownership test.
 * Null means one of: it lapsed and somebody took it, it was force-released, or the row is gone. The
 * caller must treat all three identically — as LOST — and stop dispatching.
 */
export async function renewExecutionLease(args: {
  readonly scope: string;
  readonly owner: string;
  readonly fence: number;
  readonly ttlMs: number;
}): Promise<ExecutionLeaseRow | null> {
  const ttl = Math.max(1000, Math.floor(args.ttlMs));
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE box_execution_leases
        SET renewed_at = clock_timestamp(),
            expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond')
      WHERE scope = $1
        AND owner = $2
        AND fence = $3
        AND expires_at > clock_timestamp()
      RETURNING ${RETURNING}`,
    [args.scope, args.owner, args.fence, ttl],
  );
  const row = rows[0];
  return row ? toRow(row) : null;
}

/**
 * Record that this owner has reconciled the previous owner's pending and ambiguous broker operations.
 *
 * Only then may it start NEW entry. Pinned to owner+fence+unexpired for the same reason renewal is:
 * a predecessor must not be able to stamp a successor's row as reconciled.
 */
export async function markExecutionLeaseReconciled(args: {
  readonly scope: string;
  readonly owner: string;
  readonly fence: number;
}): Promise<ExecutionLeaseRow | null> {
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE box_execution_leases
        SET takeover_reconciled_at = clock_timestamp()
      WHERE scope = $1
        AND owner = $2
        AND fence = $3
        AND expires_at > clock_timestamp()
      RETURNING ${RETURNING}`,
    [args.scope, args.owner, args.fence],
  );
  const row = rows[0];
  return row ? toRow(row) : null;
}

/**
 * RELEASE a lease at shutdown. FENCE-PINNED, deliberately.
 *
 * A process whose lease already lapsed and was taken over must not delete its successor's row. The
 * fence predicate is what makes that impossible: the successor's fence is strictly greater, drawn from
 * the same monotonic sequence.
 *
 * Returns the number of rows removed — 0 is normal and not an error (we had already lost it).
 */
export async function releaseExecutionLease(args: {
  readonly scope: string;
  readonly owner: string;
  readonly fence: number;
}): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM box_execution_leases WHERE scope = $1 AND owner = $2 AND fence = $3`,
    [args.scope, args.owner, args.fence],
  );
  return rowCount ?? 0;
}

/** Read one lease row, with the authority's clock alongside it. Null when there is none. */
export async function readExecutionLease(scope: string): Promise<ExecutionLeaseRow | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${RETURNING} FROM box_execution_leases WHERE scope = $1`,
    [scope],
  );
  const row = rows[0];
  return row ? toRow(row) : null;
}

/**
 * Remove LAPSED rows. Called at boot only, and it is purely hygiene.
 *
 * It is NOT how a takeover happens — `acquireExecutionLease` takes over a lapsed row atomically
 * without needing it deleted first, precisely so a reap and an acquire cannot race. Reaping keeps the
 * table from accumulating rows for accounts nobody trades any more.
 */
export async function reapExpiredExecutionLeases(): Promise<number> {
  return withClient(async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM box_execution_leases WHERE expires_at <= clock_timestamp()`,
    );
    return rowCount ?? 0;
  });
}

/** Every live lease held by one owner. Used by the broker-switch path to release its own rows. */
export async function listExecutionLeasesByOwner(owner: string): Promise<ExecutionLeaseRow[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${RETURNING} FROM box_execution_leases WHERE owner = $1`,
    [owner],
  );
  return rows.map(toRow);
}
