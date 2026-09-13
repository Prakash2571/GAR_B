/**
 * Shared fixtures for the broker-token acquisition tests.
 *
 * Plain ESM against the COMPILED output in dist/, matching the box and projector
 * suites. Each test FILE gets a uniquely named PostgreSQL SCHEMA so files run in
 * any order without colliding. A FAKE CLOCK and a LOCAL MOCK HTTP SERVER
 * (127.0.0.1, node:http) stand in for the wall clock and calspread.online — the
 * tests NEVER contact the real provider.
 *
 * FAIL LOUDLY. If PostgreSQL is missing these helpers throw at setup; the token
 * tests are integration tests and must never silently skip.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import pg from "pg";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://strikedge:strikedge@127.0.0.1:55432/strikedge";

/** 32-byte key as 64-char hex, used by every token test. */
export const TEST_KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

/** broker_sessions + active_broker DDL inlined so a test schema needs no runner. */
const BROKER_DDL = `
CREATE TABLE broker_sessions (
  broker                 text        PRIMARY KEY,
  encrypted_access_token bytea       NOT NULL,
  encryption_iv          bytea       NOT NULL,
  encryption_auth_tag    bytea       NOT NULL,
  credential_version     integer     NOT NULL DEFAULT 1,
  broker_identity        text        NOT NULL DEFAULT '',
  api_key_or_client_id   text        NOT NULL DEFAULT '',
  login_date             text        NOT NULL,
  expires_at             timestamptz,
  acquired_at            timestamptz NOT NULL DEFAULT now(),
  last_validated_at      timestamptz,
  source_url_hash        text        NOT NULL DEFAULT '',
  status                 text        NOT NULL DEFAULT 'active',
  invalidated_at         timestamptz,
  invalidation_reason    text,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broker_sessions_broker_valid CHECK (broker IN ('zerodha', 'dhan')),
  CONSTRAINT broker_sessions_status_valid CHECK (status IN ('active', 'invalidated')),
  CONSTRAINT broker_sessions_credential_version_positive CHECK (credential_version >= 1),
  CONSTRAINT broker_sessions_reason_bounded CHECK (invalidation_reason IS NULL OR length(invalidation_reason) <= 500)
);
CREATE SEQUENCE active_broker_generation_seq AS bigint START 1;
CREATE TABLE active_broker (
  id            text        PRIMARY KEY DEFAULT 'current',
  broker        text        NOT NULL,
  generation    bigint      NOT NULL,
  selected_at   timestamptz NOT NULL DEFAULT now(),
  selected_by   text        NOT NULL DEFAULT 'system',
  reason        text,
  trading_day   text        NOT NULL DEFAULT '',
  CONSTRAINT active_broker_singleton CHECK (id = 'current'),
  CONSTRAINT active_broker_valid CHECK (broker IN ('zerodha', 'dhan')),
  CONSTRAINT active_broker_generation_positive CHECK (generation > 0),
  CONSTRAINT active_broker_selected_by_bounded CHECK (length(selected_by) <= 200),
  CONSTRAINT active_broker_reason_bounded CHECK (reason IS NULL OR length(reason) <= 500)
);
`;

/**
 * Create a per-file PG schema, apply the broker DDL, and initialise the shared
 * pool from dist with search_path pinned to that schema. Returns handles plus a
 * cleanup. Throws loudly if PostgreSQL is unreachable.
 */
export async function createPgHarness(label = "tokens") {
  const schema = `t_${label}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let bootstrap;
  try {
    bootstrap = new pg.Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.query(`SET search_path = ${schema}`);
    await bootstrap.query(BROKER_DDL.replaceAll("CREATE TABLE", `CREATE TABLE ${schema}.`).replaceAll("CREATE SEQUENCE", `CREATE SEQUENCE ${schema}.`));
  } catch (err) {
    if (bootstrap) await bootstrap.end().catch(() => undefined);
    throw new Error(
      `PostgreSQL is required for the token tests and is not reachable at ${DATABASE_URL}: ${
        err && err.message ? err.message : err
      }`,
    );
  }
  await bootstrap.end().catch(() => undefined);

  // Init the shared dist pool with search_path pinned per connection.
  const pool = await import("../../dist/pg/pool.js");
  process.env.DATABASE_URL = DATABASE_URL;
  await pool.initPg({
    connectionString: DATABASE_URL,
    poolMax: 6,
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 2_000,
    applicationName: "gts-token-tests",
  });
  // Pin search_path on the shared pool.
  const raw = pool.getPool();
  raw.on("connect", (client) => {
    client.query(`SET search_path = ${schema}`).catch(() => undefined);
  });
  // Ensure existing idle connections use the schema too.
  await raw.query(`SET search_path = ${schema}`);

  return {
    schema,
    pool,
    /** A raw client on the schema for direct assertions. */
    async raw() {
      const c = await pool.getPool().connect();
      await c.query(`SET search_path = ${schema}`);
      return c;
    },
    async cleanup() {
      const drop = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
      await drop.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await drop.end().catch(() => undefined);
      await pool.closePg().catch(() => undefined);
    },
  };
}

/** A controllable clock. `set`/`advance` move the frozen instant. */
export function makeFakeClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/**
 * Compute an epoch-ms instant for a given IST wall time on a fixed date.
 * `istHhMm` like "09:30". Uses the fixed +5:30 offset the app uses.
 */
export function istInstant(dateYyyyMmDd, istHhMm) {
  const [h, m] = istHhMm.split(":").map(Number);
  const [y, mo, d] = dateYyyyMmDd.split("-").map(Number);
  // The UTC instant that reads as `istHhMm` IST is (IST wall) - 5:30.
  const utcMs = Date.UTC(y, mo - 1, d, h, m, 0) - 5.5 * 60 * 60 * 1000;
  return utcMs;
}

/**
 * A local mock provider. `handler(broker, req)` returns { status, body } where
 * body is an object (JSON) or a string. Tracks per-broker request counts and can
 * introduce a delay to simulate a slow provider.
 */
export function makeMockProvider() {
  const state = {
    zerodha: { count: 0, respond: null, delayMs: 0 },
    dhan: { count: 0, respond: null, delayMs: 0 },
    passcodesSeen: [],
    queryStringsSeen: [],
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const broker = url.pathname.includes("dhan") ? "dhan" : "zerodha";
    state[broker].count += 1;
    state.passcodesSeen.push(req.headers["x-token-passcode"] ?? null);
    state.queryStringsSeen.push(url.search);

    const send = () => {
      const spec = state[broker].respond ? state[broker].respond(broker, req) : { status: 409, body: {} };
      res.statusCode = spec.status;
      if (spec.headers) for (const [k, v] of Object.entries(spec.headers)) res.setHeader(k, v);
      res.setHeader("content-type", "application/json");
      if (spec.status >= 300 && spec.status < 400) {
        res.end();
        return;
      }
      const payload = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body ?? {});
      res.end(payload);
    };

    if (state[broker].delayMs > 0) setTimeout(send, state[broker].delayMs);
    else send();
  });

  return {
    state,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address();
      return {
        zerodhaUrl: `http://127.0.0.1:${port}/api/kite/token`,
        dhanUrl: `http://127.0.0.1:${port}/api/dhan/token`,
      };
    },
    setResponder(broker, fn) {
      state[broker].respond = fn;
    },
    setDelay(broker, ms) {
      state[broker].delayMs = ms;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A no-op feed probe for the acquisition service status object. */
export function nullFeedProbe() {
  return {
    feedConnected: () => false,
    wantedTokenCount: () => 0,
    subscribedTokenCount: () => 0,
    lastAuthoritativeDepthAgeMs: () => null,
    reconnectCount: () => 0,
  };
}
