/**
 * Shared harness for the CONTRACT suite.
 *
 * The contract tests validate REAL SERIALIZED RESPONSES against the schemas in
 * contract/schemas/. "Real" means one of two things, and every test says which:
 *
 *   (A) REAL HTTP — the actual route registrar from src/ is mounted on a real
 *       express app, wired with INERT/STUB providers (no engine, no broker, no
 *       network), and driven over a real 127.0.0.1 loopback listener with fetch.
 *       Where the route is behind requireOperator we mint a REAL PG-backed session
 *       exactly as tests/access/helpers.mjs does. This is used for every route we
 *       can drive hermetically: access verify/status, runtime status, export
 *       status, and the whole broker surface (status / switch-blockers / select
 *       success / select refusal).
 *
 *   (B) DIRECT SERIALIZER — the real pure serializer function from src/ is called
 *       and its output is JSON round-tripped (JSON.parse(JSON.stringify(...))) to
 *       get exactly the bytes a client would receive. This is used for shapes whose
 *       route cannot be driven without a live engine + database + market feed
 *       (box status/config/execution-control/opportunities/open-trades/history/
 *       events/execution-attempts and the SSE snapshot envelope): standing those up
 *       hermetically would require a real BoxEngine, which needs Mongo, PG and a
 *       broker feed. The serializer is the authoritative producer of the wire shape
 *       either way, so calling it directly validates the SAME bytes the HTTP route
 *       would emit.
 *
 * Plain ESM against the COMPILED output in dist/, matching the access/readiness
 * suites. PostgreSQL is required for the HTTP-with-session paths and FAILS LOUDLY
 * if unreachable — these are integration tests and must never silently skip.
 */

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";

import { validate } from "../../contract/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DIST = resolve(ROOT, "dist");
const SCHEMAS_DIR = resolve(ROOT, "contract", "schemas");

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://strikedge:strikedge@127.0.0.1:55432/strikedge";

/* ─────────────────────────────── schema registry ─────────────────────────────── */

let _registry = null;

/** Load every contract/schemas/*.schema.json into a { "<file>.schema.json": schema } map. */
export async function loadSchemas() {
  if (_registry) return _registry;
  const names = (await readdir(SCHEMAS_DIR)).filter((n) => n.endsWith(".schema.json")).sort();
  const registry = {};
  for (const name of names) {
    const raw = await readFile(resolve(SCHEMAS_DIR, name), "utf8");
    registry[name] = JSON.parse(raw);
  }
  _registry = registry;
  return registry;
}

/**
 * Validate `value` against the named schema (e.g. "access-verify.schema.json").
 * Returns the error list (empty === valid). $ref siblings resolve from the registry.
 */
export async function check(value, schemaName) {
  const registry = await loadSchemas();
  const schema = registry[schemaName];
  if (!schema) throw new Error(`no such schema: ${schemaName}`);
  return validate(value, schema, { registry });
}

/** JSON round-trip: exactly the bytes a client receives from res.json(value). */
export function wire(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ──────────────────────────────── PG session ──────────────────────────────── */

function schemaScopedUrl(schema) {
  const sep = BASE_DATABASE_URL.includes("?") ? "&" : "?";
  return `${BASE_DATABASE_URL}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

/** Create a per-file PG schema with migration 007 (access_sessions) applied. */
export async function createDbSchema(label = "contract") {
  const schema = `t_${label}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let boot;
  try {
    boot = new pg.Pool({ connectionString: BASE_DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
    await boot.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const ddl = await readFile(resolve(ROOT, "migrations", "007_access_sessions.sql"), "utf8");
    await boot.query(`SET search_path TO ${schema}`);
    await boot.query(ddl);
  } catch (err) {
    if (boot) await boot.end().catch(() => undefined);
    throw new Error(
      `Contract tests require PostgreSQL at ${BASE_DATABASE_URL}. ` +
        `Could not create schema ${schema}: ${err && err.message ? err.message : err}`,
    );
  } finally {
    if (boot) await boot.end().catch(() => undefined);
  }
  return {
    schema,
    databaseUrl: schemaScopedUrl(schema),
    async drop() {
      const p = new pg.Pool({ connectionString: BASE_DATABASE_URL, max: 1 });
      await p.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await p.end().catch(() => undefined);
    },
  };
}

/* ─────────────────────────── stub providers (INERT) ─────────────────────────── */

/** A redacted-by-contract ActiveBrokerProvider that touches no broker and no network. */
export function makeBrokerProvider(opts = {}) {
  const state = { active: opts.active ?? "zerodha", generation: opts.generation ?? 3 };
  const blockers = opts.blockers ?? [];
  return {
    _state: state,
    activeBroker: () => state.active,
    generation: () => state.generation,
    sessionFor: (broker) => ({
      broker,
      connected: broker === state.active,
      state: broker === state.active ? "ready" : "standby",
      account_label: broker === state.active ? "OPERATOR-ACC" : null,
      established_at: broker === state.active ? "2026-09-09T03:15:00.000Z" : null,
      expires_at: broker === state.active ? "2026-09-09T18:30:00.000Z" : null,
    }),
    healthFor: (broker) => ({
      broker,
      authenticated: broker === state.active,
      data_ready: broker === state.active,
      trading_ready: broker === state.active,
      problems: broker === state.active ? [] : ["not the active broker"],
    }),
    switchBlockers: () => blockers.slice(),
    selectBroker: (broker) => {
      if (blockers.length > 0) return { ok: false, broker, blockers: blockers.slice() };
      state.active = broker;
      state.generation += 1;
      return { ok: true, broker, blockers: [] };
    },
  };
}

/** A RuntimeStatusProvider returning a fully-populated, secret-free snapshot. */
export function makeRuntimeProvider(overrides = {}) {
  return {
    getRuntimeStatus: () => ({
      brokers: [
        {
          broker: "zerodha",
          token_state: "ready",
          ist_day: "2026-09-09",
          last_attempt_at: "2026-09-09T03:14:00.000Z",
          last_success_at: "2026-09-09T03:14:02.000Z",
          last_error: null,
          feed_connected: true,
          wanted_token_count: 42,
          subscribed_token_count: 42,
          last_depth_age_ms: 120,
          reconnect_count: 0,
        },
        {
          broker: "dhan",
          token_state: "waiting",
          ist_day: "2026-09-09",
          last_attempt_at: null,
          last_success_at: null,
          last_error: null,
          feed_connected: false,
          wanted_token_count: 0,
          subscribed_token_count: 0,
          last_depth_age_ms: null,
          reconnect_count: 0,
        },
      ],
      active_broker: "zerodha",
      pg_ready: true,
      migration_state: { applied: 8, pending: 0 },
      recovery_ready: true,
      live_entry: { blocked: true, reasons: ["paper mode"] },
      recovery_pending: false,
      residual_exposure: false,
      ...overrides,
    }),
  };
}

/** An ExportStatusProvider returning a secret-free backlog snapshot. */
export function makeExportProvider(overrides = {}) {
  return {
    getExportStatus: () => ({
      enabled: true,
      connected: true,
      backlog_count: 0,
      oldest_pending_age_ms: null,
      last_success_at: "2026-09-09T03:20:00.000Z",
      last_error: null,
      dead_letter_count: 0,
      ...overrides,
    }),
  };
}

/* ─────────────────────────────── HTTP harness ─────────────────────────────── */

/**
 * Boot a real express app with the REAL access, runtime-status and broker route
 * registrars mounted, wired to inert stub providers. Returns helpers to mint a
 * real session and drive the routes over loopback.
 */
export async function startApp(dbUrl, opts = {}) {
  const env = {
    NODE_ENV: "test",
    FRONTEND_URL: "http://localhost:5173",
    CSRF_ALLOWED_ORIGIN: "http://localhost:5173",
    SESSION_COOKIE_NAME: "gts_session",
    SITE_SESSION_TTL_HOURS: "24",
    SITE_ACCESS_SECRET: process.env.SITE_ACCESS_SECRET ?? "ci-fake-site-access-secret-not-a-real-passcode",
    DATABASE_URL: dbUrl,
    ...opts.env,
  };

  const pool = await import(`${DIST}/pg/pool.js`);
  const configMod = await import(`${DIST}/config.js`);
  const mw = await import(`${DIST}/access/middleware.js`);
  const accessRoutes = await import(`${DIST}/access/routes.js`);
  const rl = await import(`${DIST}/access/rateLimit.js`);
  const statusRoutes = await import(`${DIST}/runtime/statusRoutes.js`);
  const brokerRoutes = await import(`${DIST}/brokerRoutes.js`);

  const config = configMod.loadAppConfig(env);
  const session = { siteAccessSecret: env.SITE_ACCESS_SECRET, ttlHours: config.siteSessionTtlHours };

  await pool.closePg().catch(() => undefined);
  await pool.initPg({
    connectionString: dbUrl,
    poolMax: 5,
    statementTimeoutMs: 5000,
    lockTimeoutMs: 2000,
    applicationName: "gts-contract-test",
  });

  const app = express();
  app.disable("etag");
  app.use(mw.corsMiddleware(config));
  app.use(express.json());

  accessRoutes.registerAccessRoutes(app, { config, session, verifyRateLimit: rl.createVerifyRateLimit() });

  const requireOperator = mw.createRequireOperator({ config });

  const broker = opts.brokerProvider ?? makeBrokerProvider();
  statusRoutes.registerRuntimeStatusRoutes(app, {
    requireOperator,
    runtime: opts.runtimeProvider ?? makeRuntimeProvider(),
    exportStatus: opts.exportProvider ?? makeExportProvider(),
  });
  brokerRoutes.registerBrokerRoutes(app, { requireOperator, manager: broker });

  app.use(mw.errorHandler());

  const server = createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    config,
    broker,
    async close() {
      await new Promise((r) => server.close(r));
      await pool.closePg().catch(() => undefined);
    },
  };
}

/** Parse Set-Cookie header(s) into a { name: value } map. */
export function cookiesOf(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const out = {};
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

function cookieHeader(map) {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Mint a real session via POST /api/access/verify and return the pieces needed to
 * make authenticated calls: the Cookie header and the CSRF token + verify body.
 */
export async function login(origin, passcode) {
  const res = await fetch(`${origin}/api/access/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
  const body = await res.json();
  const cookies = cookiesOf(res);
  return {
    res,
    body,
    cookies,
    cookieHeader: cookieHeader(cookies),
    csrf: body.csrf_token,
  };
}

/** Authenticated GET returning { res, body }. */
export async function authGet(origin, path, cookieHeaderStr) {
  const res = await fetch(`${origin}${path}`, { headers: { cookie: cookieHeaderStr } });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

/** Authenticated POST (CSRF + Origin) returning { res, body }. */
export async function authPost(origin, path, cookieHeaderStr, csrf, payload) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      cookie: cookieHeaderStr,
      "content-type": "application/json",
      "x-csrf-token": csrf,
      origin: "http://localhost:5173",
    },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}
