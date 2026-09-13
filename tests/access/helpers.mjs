/**
 * Shared harness for the access-gate tests.
 *
 * Plain ESM against the COMPILED output in dist/ (matching the box + projector
 * suites). Each test FILE gets a uniquely named PostgreSQL SCHEMA (pinned via the
 * connection's search_path) so files never collide and can run in any order.
 *
 * FAIL LOUDLY. PostgreSQL is required. If it is unreachable these helpers throw at
 * setup — the access tests are integration tests and must NEVER silently skip.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import pg from "pg";
import express from "express";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DIST = resolve(ROOT, "dist");
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://strikedge:strikedge@127.0.0.1:55432/strikedge";

/** Build a DATABASE_URL whose connections pin search_path to `schema`. */
function schemaScopedUrl(schema) {
  const sep = BASE_DATABASE_URL.includes("?") ? "&" : "?";
  return `${BASE_DATABASE_URL}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

/**
 * Create a per-file schema and apply migration 007 into it. Throws loudly if
 * PostgreSQL is unreachable, so a missing database is a hard test failure.
 */
export async function createDbSchema(label = "access") {
  const schema = `t_${label}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let boot;
  try {
    boot = new pg.Pool({ connectionString: BASE_DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
    await boot.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const ddl = await readFile(resolve(ROOT, "migrations", "007_access_sessions.sql"), "utf8");
    // Apply the migration inside the new schema by pinning search_path for this call.
    await boot.query(`SET search_path TO ${schema}`);
    await boot.query(ddl);
  } catch (err) {
    if (boot) await boot.end().catch(() => undefined);
    throw new Error(
      `Access tests require PostgreSQL at ${BASE_DATABASE_URL}. ` +
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

/**
 * Boot a real Express app on an ephemeral port with the access gate wired in.
 *
 * `opts.env` overrides process env for loadAppConfig (SITE_ACCESS_SECRET, etc.).
 * `opts.liveGate` is a spy the "arms nothing" test asserts was never called with
 * an enable. Stub box/runtime/export/broker routes are mounted behind
 * requireOperator so the protected-route behaviour can be exercised end to end.
 */
export async function startApp(dbUrl, opts = {}) {
  // dist modules are import()ed lazily so the DATABASE_URL is set before initPg.
  const env = {
    NODE_ENV: "test",
    FRONTEND_URL: "http://localhost:5173",
    CSRF_ALLOWED_ORIGIN: "http://localhost:5173",
    SESSION_COOKIE_NAME: "gts_session",
    SITE_SESSION_TTL_HOURS: "24",
    DATABASE_URL: dbUrl,
    ...opts.env,
  };

  const pool = await import(`${DIST}/pg/pool.js`);
  const configMod = await import(`${DIST}/config.js`);
  const mw = await import(`${DIST}/access/middleware.js`);
  const accessRoutes = await import(`${DIST}/access/routes.js`);
  const rl = await import(`${DIST}/access/rateLimit.js`);

  const config = configMod.loadAppConfig(env);
  const session = {
    siteAccessSecret: env.SITE_ACCESS_SECRET,
    ttlHours: config.siteSessionTtlHours,
  };

  // Fresh pool pinned to this file's schema.
  await pool.closePg().catch(() => undefined);
  await pool.initPg({
    connectionString: dbUrl,
    poolMax: 5,
    statementTimeoutMs: 5000,
    lockTimeoutMs: 2000,
    applicationName: "gts-access-test",
  });

  const app = express();
  app.disable("etag");
  app.use(mw.corsMiddleware(config));
  app.use(express.json());

  // Public health check.
  app.get("/api/health", (_req, res) => res.status(200).json({ status: "ok" }));

  // Access gate (public verify/status/logout).
  accessRoutes.registerAccessRoutes(app, {
    config,
    session,
    verifyRateLimit: rl.createVerifyRateLimit(),
  });

  const requireOperator = mw.createRequireOperator({ config });

  // A live-trading gate spy: the "arms nothing" test asserts verify never enabled it.
  const liveGate = opts.liveGate ?? { calls: [], enable() { this.calls.push("enable"); } };

  // Stub protected routes standing in for box / runtime / export / broker.
  app.get("/api/box/status", requireOperator, (_req, res) => res.status(200).json({ ok: true }));
  app.post("/api/box/start", requireOperator, (_req, res) => res.status(200).json({ ok: true }));
  app.get("/api/runtime/status", requireOperator, (_req, res) => res.status(200).json({ ok: true }));
  app.get("/api/export/status", requireOperator, (_req, res) => res.status(200).json({ ok: true }));
  app.get("/api/broker/status", requireOperator, (_req, res) => res.status(200).json({ ok: true }));

  // A route that deliberately throws, to prove the error handler leaks no internals.
  app.get("/api/boom", requireOperator, () => {
    throw new Error(
      'boom: SELECT token_hash FROM access_sessions WHERE token_hash = $1 -- secret sql\n    at Object.<anonymous>',
    );
  });

  // SSE stub mirroring box/routes.ts: cookie-only via requireOperator, never query.
  app.get("/api/box/stream", requireOperator, (req, res) => {
    if (mw.getOperatorRole(req) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.status(200);
    res.write(": ok\n\n");
    res.end();
  });

  app.use(mw.errorHandler());

  const server = createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    config,
    session,
    liveGate,
    pool,
    sessionStore: await import(`${DIST}/access/sessionStore.js`),
    async close() {
      await new Promise((r) => server.close(r));
      await pool.closePg().catch(() => undefined);
    },
  };
}

/** Parse Set-Cookie header(s) into a { name: { value, attrs } } map. */
export function parseSetCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const out = {};
  for (const line of raw) {
    const [pair, ...attrParts] = line.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const attrs = {};
    for (const a of attrParts) {
      const t = a.trim();
      const i = t.indexOf("=");
      if (i === -1) attrs[t.toLowerCase()] = true;
      else attrs[t.slice(0, i).toLowerCase()] = t.slice(i + 1);
    }
    out[name] = { value, attrs, raw: line };
  }
  return out;
}

/** Build a Cookie header from a { name: value } map. */
export function cookieHeader(map) {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** POST /api/access/verify and return { res, body, cookies }. */
export async function verify(origin, passcode, extraHeaders = {}) {
  const res = await fetch(`${origin}/api/access/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ passcode }),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body, cookies: parseSetCookies(res) };
}
