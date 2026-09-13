/**
 * MongoDB Atlas client lifecycle — the READ REPLICA side of the projection.
 *
 * WHY THIS IS ALLOWED TO BE ABSENT
 * MongoDB Atlas is a reporting replica, never part of the execution hot path and
 * never required before a broker POST. So this module is written so that a missing
 * `MONGODB_URI`, `MONGO_EXPORT_ENABLED=false`, or an Atlas outage is a NON-EVENT
 * for everything except the background projector:
 *
 *   * `exportConfigFromEnv` reports `enabled: false` when export is off or the URI
 *     is unset, and the projector simply never starts;
 *   * `connect()` is lazy and bounded — it is only ever called from the projector
 *     loop, never from an operational transaction, so a slow or failing Atlas can
 *     only ever slow the DRAIN, never a trade;
 *   * `close()` is idempotent so shutdown can always call it.
 *
 * There is exactly one shared client per process (the driver pools internally), so
 * repeated `connect()` calls reuse the same connection rather than opening more.
 */

import { MongoClient, type Collection, type Db, type Document } from "mongodb";

/** The Box-oriented collection names, mirrored from the legacy Mongoose models. */
export const MONGO_COLLECTIONS = {
  box_trade: "box_trades",
  box_trade_event: "box_trade_events",
  box_order_intent: "box_order_intents",
  box_execution_attempt: "box_execution_attempts",
  box_daily_pnl: "box_daily_pnl",
  box_calibration_sample: "box_calibration_samples",
} as const;

/** Aggregate types the projector knows how to route to a collection. */
export type ProjectableAggregate = keyof typeof MONGO_COLLECTIONS;

/**
 * Resolve an aggregate type to its target collection name, or `null` for an
 * aggregate the projector does not recognise (a poison row that must be
 * dead-lettered rather than routed).
 */
export function collectionForAggregate(aggregateType: string): string | null {
  return Object.prototype.hasOwnProperty.call(MONGO_COLLECTIONS, aggregateType)
    ? MONGO_COLLECTIONS[aggregateType as ProjectableAggregate]
    : null;
}

export interface MongoExportConfig {
  /** True only when export is on AND a URI is present. Drives whether the projector runs. */
  enabled: boolean;
  /** The Atlas connection string. Never logged, never exported in a status snapshot. */
  uri: string;
  /** Database name parsed from the URI path, or the explicit default. */
  dbName: string;
  batchSize: number;
  intervalMs: number;
  maxBackoffMs: number;
  /** Bounded server-selection timeout so a dead Atlas fails the drain quickly. */
  serverSelectionTimeoutMs: number;
  /** Attempt budget before a row is dead-lettered. */
  maxAttempts: number;
}

function intOr(raw: string | undefined, fallback: number, min = 1): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= min ? i : fallback;
}

function boolOr(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "") return fallback;
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return false;
}

/**
 * Parse the database name out of a mongodb URI. Defaults to `strikedge` when the
 * URI carries no path (which is common for Atlas SRV strings).
 *
 * THE FALLBACK DATABASE NAME IS COMPATIBILITY-SENSITIVE AND WAS NOT RENAMED WITH THE REBRAND.
 * It names a real MongoDB database that existing deployments already hold the reporting
 * replica in. Changing it would silently start writing projections into a NEW, empty database
 * while the populated one went stale — a data-loss-shaped failure that reports itself as
 * "everything is fine". Set MONGO_EXPORT_DB (or put the database in the URI path) to choose a
 * name explicitly; renaming a live database is a migration, not a rebrand.
 */
export function dbNameFromUri(uri: string, fallback = "strikedge"): string {
  try {
    // mongodb+srv and mongodb both parse as URLs; the pathname is `/<db>` or empty.
    const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, "");
    const afterHost = afterScheme.slice(afterScheme.indexOf("/") + 1);
    if (!afterScheme.includes("/")) return fallback;
    const db = afterHost.split("?")[0]?.trim() ?? "";
    return db.length > 0 ? decodeURIComponent(db) : fallback;
  } catch {
    return fallback;
  }
}

export function exportConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MongoExportConfig {
  const uri = (env.MONGODB_URI ?? "").trim();
  const explicitlyEnabled = boolOr(env.MONGO_EXPORT_ENABLED, true);
  const enabled = explicitlyEnabled && uri.length > 0;
  const dbName = (env.MONGO_EXPORT_DB ?? "").trim() || dbNameFromUri(uri);
  return {
    enabled,
    uri,
    dbName,
    batchSize: intOr(env.MONGO_EXPORT_BATCH_SIZE, 100),
    intervalMs: intOr(env.MONGO_EXPORT_INTERVAL_MS, 1_000),
    maxBackoffMs: intOr(env.MONGO_EXPORT_MAX_BACKOFF_MS, 60_000),
    serverSelectionTimeoutMs: intOr(env.MONGO_EXPORT_SERVER_SELECTION_TIMEOUT_MS, 5_000),
    maxAttempts: intOr(env.MONGO_EXPORT_MAX_ATTEMPTS, 10),
  };
}

/**
 * A thin, idempotent wrapper around one `MongoClient`.
 *
 * `connect()` is safe to call repeatedly; the first successful connect wins and
 * subsequent calls return the same handle. A failed connect resets state so the
 * next drain iteration retries rather than being wedged on a stale promise.
 */
export class MongoExportClient {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private connecting: Promise<Db> | null = null;
  private connectedFlag = false;

  constructor(private readonly cfg: MongoExportConfig) {}

  /** True once a live connection exists. Cheap; used by the status snapshot. */
  isConnected(): boolean {
    return this.connectedFlag;
  }

  /** Lazily connect (bounded) and return the database handle. */
  async connect(): Promise<Db> {
    if (this.db) return this.db;
    if (this.connecting) return this.connecting;

    const attempt = (async (): Promise<Db> => {
      const client = new MongoClient(this.cfg.uri, {
        serverSelectionTimeoutMS: this.cfg.serverSelectionTimeoutMs,
        connectTimeoutMS: this.cfg.serverSelectionTimeoutMs,
        // Keep the pool small: this is a low-rate background drain, not a hot path.
        maxPoolSize: 4,
        retryWrites: true,
      });
      try {
        await client.connect();
        // A round trip so "connected" means "usable", not merely "constructed".
        await client.db(this.cfg.dbName).command({ ping: 1 });
        this.client = client;
        this.db = client.db(this.cfg.dbName);
        this.connectedFlag = true;
        return this.db;
      } catch (err) {
        // Do not leak a half-open client if the ping failed.
        await client.close().catch(() => undefined);
        this.connectedFlag = false;
        throw err;
      } finally {
        this.connecting = null;
      }
    })();

    this.connecting = attempt;
    return attempt;
  }

  /** Get a typed collection handle, connecting first if necessary. */
  async collection<T extends Document = Document>(name: string): Promise<Collection<T>> {
    const db = await this.connect();
    return db.collection<T>(name);
  }

  /** Close the client. Idempotent, safe to call during shutdown even if never connected. */
  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.db = null;
    this.connecting = null;
    this.connectedFlag = false;
    if (c) await c.close().catch(() => undefined);
  }
}
