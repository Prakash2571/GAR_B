/**
 * A Dhan token acquired AFTER boot must reach the RUNNING manager.
 *
 * THE BUG THIS PINS
 * This backend performs no broker OAuth: `BrokerTokenAcquisitionService` fetches the Dhan
 * token from the predecessor codebase at 09:00 IST, persists it encrypted to `broker_sessions`, and
 * then calls `callbacks.installDhanToken()`.
 *
 * `ActiveBrokerManager` read `broker_sessions` in exactly one place — inlined inside
 * `restore()`, which runs ONCE at boot — and `installDhanToken` was wired as a no-op on
 * the (incorrect) reasoning that the Dhan client re-read its session on demand.
 *
 * So on a completely ordinary morning:
 *   08:50  process starts, restore() finds no Dhan session, dhanAccessToken = null
 *   09:00  token acquired and written to PostgreSQL, install callback does nothing
 *   all day  healthFor("dhan").authenticated === false
 *
 * The token was durable and the running process could not use it. Dhan could not be
 * selected as the active broker until someone restarted the process — and nothing in the
 * status output would have explained why, because the stored session was perfectly fine.
 *
 * `adoptStoredDhanSession()` closes it. These tests drive the REAL compiled manager
 * against the REAL encrypted PostgreSQL store, because the whole failure was that a
 * durable write did not become in-memory state — a mock of either half would have hidden
 * it exactly as the original reasoning did.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createPgHarness, TEST_KEY_HEX } from "./helpers.mjs";

process.env.BROKER_TOKEN_ENCRYPTION_KEY ??= TEST_KEY_HEX;

const registry = await import("../../dist/brokers/registry.js");
const sessions = await import("../../dist/brokerState/brokerSessions.js");

/** IST day key, matching src/boxSupport.ts so the fixture looks like a real morning. */
const istDayKey = (at = Date.now()) => new Date(at + 5.5 * 3600_000).toISOString().slice(0, 10);

/** A manager with the collaborators these paths touch and nothing else. */
function manager() {
  return new registry.ActiveBrokerManager({
    kite: {
      getApiKey: () => "",
      getAccessToken: () => null,
      clearSession: () => {},
      getInstruments: async () => [],
      getQuoteFull: async () => ({}),
    },
    tickerHub: {
      addTickListener: () => () => {},
      addConnectionListener: () => () => {},
      retain: () => () => {},
      seed: () => {},
      ingestExternalTicks: () => {},
      setExternalConnected: () => {},
      getLatestTick: () => null,
      subscribeTokens: () => {},
      unsubscribeTokens: () => {},
      subscribedCount: () => 0,
      isConnected: () => false,
    },
    boxConfig: () => ({}),
    istDayKey,
    zerodhaCredentials: () => ({ apiKey: "", accessToken: null }),
    onDhanTicks: () => {},
  });
}

let harness;

before(async () => {
  harness = await createPgHarness("dhanadopt");
});

after(async () => {
  await harness.cleanup();
});

test("BASELINE: with nothing stored, a booted manager reports Dhan unauthenticated", async () => {
  const m = manager();
  await m.restore();
  assert.equal(
    m.healthFor("dhan").authenticated,
    false,
    "no stored session means Dhan must report itself unauthenticated",
  );
});

test("a token persisted AFTER boot is adopted into the running manager", async () => {
  // 08:50 — the process is already up and has seen no Dhan session.
  const m = manager();
  await m.restore();
  assert.equal(m.healthFor("dhan").authenticated, false, "precondition: starts unauthenticated");

  // 09:00 — the acquisition service persists today's token. Expiry is explicitly in the
  // future, which is the case Dhan's contract says to honour.
  await sessions.saveDhanSession({
    access_token: "dhan-token-acquired-at-0900",
    dhan_client_id: "DHAN-CLIENT-1",
    dhan_client_name: "Test Account",
    dhan_client_ucc: "UCC1",
    given_power_of_attorney: false,
    expiry_time: Date.now() + 8 * 3600_000,
    login_date: istDayKey(),
  });

  // THE FIX: the install callback's real work. Before this existed, the assertion below
  // failed and the only remedy was a process restart.
  const adopted = await m.adoptStoredDhanSession();
  assert.equal(adopted, true, "a valid stored session must be adoptable");
  assert.equal(
    m.healthFor("dhan").authenticated,
    true,
    "the running manager must see a token acquired after boot, with no restart",
  );
});

test("adoption is idempotent — a repeated install callback changes nothing", async () => {
  const m = manager();
  await m.restore();
  assert.equal(m.healthFor("dhan").authenticated, true, "boot adopts the stored session");
  for (let i = 0; i < 3; i++) {
    assert.equal(await m.adoptStoredDhanSession(), true, `call ${i + 1} still adopts`);
  }
  assert.equal(m.healthFor("dhan").authenticated, true, "still authenticated, not corrupted");
});

test("an EXPIRED stored session is refused, not installed", async () => {
  // Installing a dead token would make `authenticated` true until the next expiry check
  // and then fail at the broker — strictly worse than reporting the truth.
  await sessions.saveDhanSession({
    access_token: "dhan-token-already-dead",
    dhan_client_id: "DHAN-CLIENT-1",
    dhan_client_name: "Test Account",
    dhan_client_ucc: "UCC1",
    given_power_of_attorney: false,
    expiry_time: Date.now() - 60_000,
    login_date: istDayKey(),
  });

  const m = manager();
  const adopted = await m.adoptStoredDhanSession();
  assert.equal(adopted, false, "an expired session must not be adopted");
  assert.equal(
    m.healthFor("dhan").authenticated,
    false,
    "an expired token must never make Dhan look authenticated",
  );
});

test("adopting a Dhan session does not make Dhan the active broker", async () => {
  // Acquiring or installing a token must never change broker selection: that is the
  // guarded switch's job, and a standby broker holding a valid token stays standby.
  await sessions.saveDhanSession({
    access_token: "dhan-token-standby",
    dhan_client_id: "DHAN-CLIENT-1",
    dhan_client_name: "Test Account",
    dhan_client_ucc: "UCC1",
    given_power_of_attorney: false,
    expiry_time: Date.now() + 8 * 3600_000,
    login_date: istDayKey(),
  });

  const m = manager();
  await m.restore();
  const before = m.activeBroker;
  await m.adoptStoredDhanSession();
  assert.equal(m.activeBroker, before, "installing a token must not switch the active broker");
});

test("the boot wiring's installDhanToken callback actually installs the session", async () => {
  /**
   * The tests above prove `adoptStoredDhanSession()` works. They would ALL still pass if
   * `src/index.ts` reverted `installDhanToken` to the no-op it originally was, because
   * they call the method directly rather than through the callback. The broken WIRING was
   * the actual bug, so it needs its own assertion.
   *
   * Importing `src/index.ts` would start a server and open a pool, so the wiring is
   * pinned by reading the source — the same approach `tests/shutdown/` uses to pin an
   * ordering it cannot practically execute. It is a weaker form of evidence than
   * execution and is used only because execution is not available here.
   */
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

  // Isolate the callback body: from `installDhanToken:` to the start of the next
  // callback key at the same nesting level.
  const start = src.indexOf("installDhanToken:");
  assert.ok(start > -1, "src/index.ts must still wire installDhanToken");
  const rest = src.slice(start);
  const end = rest.indexOf("isActiveBroker:");
  assert.ok(end > -1, "expected isActiveBroker to follow installDhanToken in the callbacks object");
  const body = rest.slice(0, end);

  assert.match(
    body,
    /adoptStoredDhanSession\(\)/,
    "installDhanToken must call brokerManager.adoptStoredDhanSession(); a no-op leaves a token " +
      "durable in PostgreSQL but invisible to the running process for the rest of the day",
  );
  assert.match(body, /await/, "the adoption is asynchronous and must be awaited");
});
