/**
 * The PostgreSQL connection pool — this backend's single operational authority.
 *
 * WHY THIS FILE IS SMALL AND EXPLICIT
 * the predecessor codebase's Box module reached Mongo through Mongoose models, which meant a
 * compare-and-set was expressed as a `findOneAndUpdate` filter and the durable
 * pre-write value had to be inferred from the returned document. GTS Algo Research
 * replaces that with real SQL transactions and `UPDATE ... RETURNING`, so the
 * pre-write and post-write values are both authoritative and both come back from
 * the same statement. An ORM would obscure exactly the behaviour that matters, so
 * there is not one: this module owns a `pg.Pool` and nothing else.
 *
 * DURABILITY
 * `synchronous_commit` is deliberately NOT touched. Order-intent transitions must
 * be durable before a broker POST, so the session keeps the server default (`on`).
 * A per-session `SET synchronous_commit = off` would make every guarantee in
 * `docs/EXTRACTION_MANIFEST.md` false, so no code path here may set it.
 *
 * TIMEOUTS
 * Every pooled connection gets `statement_timeout` and `lock_timeout` applied on
 * connect. A wedged statement inside the execution path is worse than a failed
 * one: the caller can fail closed on an error, but it cannot fail closed on a
 * promise that never settles.
 */

import pg from "pg";

/** Statement/lock timeout and pool sizing, all overridable per deployment. */
export interface PgConfig {
  connectionString: string;
  poolMax: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  /** Applied to `application_name`, so `pg_stat_activity` names the deployment. */
  applicationName: string;
}

export function pgConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PgConfig {
  const connectionString = (env.DATABASE_URL ?? "").trim();
  return {
    connectionString,
    poolMax: positiveInt(env.PG_POOL_MAX, 10),
    statementTimeoutMs: positiveInt(env.PG_STATEMENT_TIMEOUT_MS, 5_000),
    lockTimeoutMs: positiveInt(env.PG_LOCK_TIMEOUT_MS, 2_000),
    applicationName: (env.PG_APPLICATION_NAME ?? "gts").trim() || "gts",
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * `pg` returns `numeric` as a string to avoid silent float truncation. Every
 * money column in this backend is `numeric`, and the Box code expects JS numbers
 * with the rounding the strategy already applied, so the parse is registered
 * once here rather than at each call site.
 *
 * This is safe for this schema specifically: the largest magnitudes stored are
 * rupee amounts and quantities well inside IEEE-754 exact-integer range, and the
 * values were produced by the very same double arithmetic on the way in. The
 * strategy mathematics is therefore unchanged — this is a round trip, not a
 * recomputation.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

let pool: pg.Pool | null = null;
let configured: PgConfig | null = null;
let readyState: "unconfigured" | "connecting" | "ready" | "failed" = "unconfigured";
let lastError: string | null = null;

export class PgUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgUnavailableError";
  }
}

/** True once a live pool exists and its first probe succeeded. */
export function isPgReady(): boolean {
  return readyState === "ready" && pool !== null;
}

export function pgStatus(): {
  state: "unconfigured" | "connecting" | "ready" | "failed";
  /** Redacted: host/database only, never user or password. */
  target: string | null;
  last_error: string | null;
  pool_total: number;
  pool_idle: number;
  pool_waiting: number;
} {
  return {
    state: readyState,
    target: configured ? redactConnectionString(configured.connectionString) : null,
    last_error: lastError,
    pool_total: pool?.totalCount ?? 0,
    pool_idle: pool?.idleCount ?? 0,
    pool_waiting: pool?.waitingCount ?? 0,
  };
}

/**
 * Strip credentials from a libpq URL so a status endpoint or log line can name
 * the target without leaking the password. Unparseable strings collapse to a
 * constant rather than being echoed.
 */
export function redactConnectionString(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const db = u.pathname.replace(/^\//, "");
    const host = u.hostname || "(socket)";
    return `${host}${u.port ? `:${u.port}` : ""}/${db}`;
  } catch {
    return "(configured)";
  }
}

/**
 * Create the pool. Idempotent: a second call with the pool already up is a no-op,
 * so boot and a lazily-initialising test helper cannot open two pools.
 */
export async function initPg(cfg: PgConfig = pgConfigFromEnv()): Promise<void> {
  if (pool) return;
  if (!cfg.connectionString) {
    readyState = "failed";
    lastError = "DATABASE_URL is not set";
    throw new PgUnavailableError(
      "DATABASE_URL is not set. PostgreSQL is this backend's operational authority; it is not optional.",
    );
  }
  configured = cfg;
  readyState = "connecting";
  const p = new pg.Pool({
    connectionString: cfg.connectionString,
    max: cfg.poolMax,
    application_name: cfg.applicationName,
    // Deliberately generous: a slow first connection during boot must not be read
    // as an outage, and every statement is separately bounded below.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  /**
   * Applied per PHYSICAL connection, so a pool that grows later inherits them.
   *
   * WHY THE UN-AWAITED `void` IS CORRECT — DO NOT "FIX" IT
   * `pg` does not await this handler, so it looks like the first caller query could run
   * before the timeouts land. It cannot: the handler runs synchronously during the
   * `connect` event and `client.query` ENQUEUES on the client's FIFO query queue, which
   * `pg` drains in order. The SET is therefore always ahead of the caller's first
   * statement. Verified empirically against five simultaneously-created connections, all
   * of which reported `statement_timeout = 5s` on their very first query.
   *
   * A libpq `options=-c statement_timeout=…` startup parameter would be stronger still
   * (server-side, before any query), but it is deliberately NOT used here: a config-level
   * `options` takes precedence over one in the connection string, and
   * `tests/pg/helpers.mjs` puts `options=-csearch_path=<schema>` in the URL to isolate each
   * test file. Setting it here would silently drop that search_path and collapse every pg
   * test into the `public` schema. Merging the two is possible but buys nothing over the
   * ordering guarantee above.
   *
   * The `.catch` is a swallow of last resort: on a healthy connection a `SET` does not
   * fail, and if it somehow did, throwing inside an event handler would take the process
   * down rather than degrade one connection.
   */
  p.on("connect", (client) => {
    void client
      .query(
        `SET statement_timeout = ${cfg.statementTimeoutMs}; SET lock_timeout = ${cfg.lockTimeoutMs}; SET idle_in_transaction_session_timeout = ${Math.max(cfg.statementTimeoutMs * 4, 20_000)};`,
      )
      .catch(() => undefined);
  });

  // A pool-level error with no listener would take the process down. Trading
  // state is durable, but an unhandled 'error' during a broker round trip would
  // kill the process at the worst possible moment.
  p.on("error", (err) => {
    lastError = boundedError(err);
  });

  pool = p;
  try {
    await p.query("SELECT 1");
    readyState = "ready";
    lastError = null;
  } catch (err) {
    readyState = "failed";
    lastError = boundedError(err);
    throw new PgUnavailableError(`PostgreSQL is not reachable: ${lastError}`);
  }
}

/** The live pool, or a typed failure. Never returns a half-initialised handle. */
export function getPool(): pg.Pool {
  if (!pool) throw new PgUnavailableError("PostgreSQL pool is not initialised");
  return pool;
}

/** Close the pool. Idempotent, and always the LAST thing shutdown does. */
export async function closePg(): Promise<void> {
  const p = pool;
  pool = null;
  readyState = "unconfigured";
  if (p) await p.end().catch(() => undefined);
}

/** One-shot query against the pool. */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<pg.QueryResult<R>> {
  return getPool().query<R>(text, values as unknown[]);
}

/**
 * Run `fn` inside a single transaction on a single pooled connection.
 *
 * This is the ONLY way the repository layer writes. Every operational mutation
 * that also needs a Mongo projection enqueues its outbox row through the same
 * `client`, which is what makes the outbox transactional rather than best-effort.
 *
 * Rollback is attempted on any throw and its own failure is swallowed — the
 * original error is what the caller must see.
 */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Borrow a connection without a transaction (multi-statement reads, advisory work). */
export async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** PostgreSQL unique-violation. */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505";
}

/** PostgreSQL check-constraint violation. */
export function isCheckViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23514";
}

/** PostgreSQL serialisation failure / deadlock — safe to retry. */
export function isRetryableTxError(err: unknown): boolean {
  const code = pgErrorCode(err);
  return code === "40001" || code === "40P01";
}

export function pgErrorCode(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/**
 * A short, non-leaking error string.
 *
 * Deliberately drops the SQL text: `pg` attaches the failing statement to the
 * error, and a status endpoint or log line that echoed it would publish schema
 * internals and, in a parameterised-but-inlined case, values.
 */
export function boundedError(err: unknown, max = 200): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
