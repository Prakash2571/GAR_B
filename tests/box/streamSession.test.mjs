/**
 * AN OPEN STREAM MUST NOT OUTLIVE THE SESSION THAT OPENED IT.
 *
 * Every other route is authenticated per request, so revoking a session stops it working on the next
 * call. An SSE stream has ONE request and then runs for hours: the check at open was the only check, and
 * the engine afterwards held a bare response object with no idea whose session it belonged to. A client
 * that simply kept its connection open therefore kept receiving full state snapshots after logout and
 * after the session's hard expiry. A browser closing its own stream on logout is client-side courtesy,
 * not enforcement.
 *
 * The policy pinned here:
 *   · EXPIRY is decided locally and fails closed — knowable without a query, so it holds even when the
 *     session store is unreachable;
 *   · REVOCATION requires asking, and a definite "no" closes the stream at once;
 *   · a check that CANNOT COMPLETE is tolerated for a bounded grace window and then closes the stream,
 *     because past that point this process can no longer claim the session is valid.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { StreamSessionSentry, DEFAULT_STREAM_SESSION_GRACE_MS } = await import(
  "../../dist/box/streamSession.js"
);

function sentry({ expiresAtMs = 10_000, live = async () => true, graceMs = 1_000, clock } = {}) {
  const t = clock ?? { now: 0 };
  return {
    clock: t,
    sentry: new StreamSessionSentry({
      expiresAtMs,
      isSessionLive: live,
      now: () => t.now,
      graceMs,
    }),
  };
}

test("a live, unexpired session keeps streaming", async () => {
  const { sentry: s } = sentry({ live: async () => true });
  assert.deepEqual(await s.check(), { kind: "ok" });
});

test("a REVOKED session closes the stream", async () => {
  // What logout produces: the row is still there, with revoked_at set, so validateSession answers null.
  const { sentry: s } = sentry({ live: async () => false });
  const verdict = await s.check();
  assert.equal(verdict.kind, "revoked");
  assert.match(verdict.detail, /revoked/);
});

test("an EXPIRED session closes the stream, and does so without asking the database", async () => {
  let asked = false;
  const { sentry: s, clock } = sentry({
    expiresAtMs: 10_000,
    live: async () => {
      asked = true;
      return true;
    },
  });
  clock.now = 10_000;

  const verdict = await s.check();
  assert.equal(verdict.kind, "expired");
  assert.equal(
    asked,
    false,
    "expiry is knowable locally; requiring a query would let a database outage extend a session",
  );
});

test("expiry is checked at the boundary instant, not a moment later", async () => {
  const { sentry: s, clock } = sentry({ expiresAtMs: 10_000 });
  clock.now = 9_999;
  assert.equal((await s.check()).kind, "ok");
  clock.now = 10_000;
  assert.equal((await s.check()).kind, "expired", "expires_at is exclusive of the session");
});

test("a failed check is TOLERATED at first: an outage is not a revocation", async () => {
  // Disconnecting every operator the instant PostgreSQL hiccups would remove the live view exactly when
  // it is most needed, and an unreadable session store is not evidence that anybody was revoked.
  const { sentry: s } = sentry({
    live: async () => {
      throw new Error("connection terminated unexpectedly");
    },
    graceMs: 1_000,
  });
  assert.deepEqual(await s.check(), { kind: "ok" });
});

test("but a session that stays unverifiable past the grace window is closed", async () => {
  const { sentry: s, clock } = sentry({
    live: async () => {
      throw new Error("connection terminated unexpectedly");
    },
    graceMs: 1_000,
  });
  assert.equal((await s.check()).kind, "ok");
  clock.now = 999;
  assert.equal((await s.check()).kind, "ok", "still inside the tolerance");
  clock.now = 1_000;
  const verdict = await s.check();
  assert.equal(verdict.kind, "unverifiable");
  assert.match(verdict.detail, /could not be re-verified/);
});

test("the grace window RESETS after a successful check", async () => {
  // Otherwise a long-lived stream would accumulate unrelated blips and eventually be closed for no
  // current reason at all.
  let fail = true;
  const { sentry: s, clock } = sentry({
    live: async () => {
      if (fail) throw new Error("unreachable");
      return true;
    },
    graceMs: 1_000,
  });
  assert.equal((await s.check()).kind, "ok");
  clock.now = 900;
  fail = false;
  assert.equal((await s.check()).kind, "ok");

  fail = true;
  clock.now = 1_500;
  assert.equal((await s.check()).kind, "ok", "the window restarts from the last SUCCESS");
  clock.now = 2_500;
  assert.equal((await s.check()).kind, "unverifiable");
});

test("expiry outranks an unverifiable session store", async () => {
  const { sentry: s, clock } = sentry({
    expiresAtMs: 5_000,
    live: async () => {
      throw new Error("unreachable");
    },
    graceMs: 60_000,
  });
  clock.now = 5_000;
  assert.equal(
    (await s.check()).kind,
    "expired",
    "a database outage must not be able to extend a session past its hard expiry",
  );
});

test("the default grace window is bounded", () => {
  assert.equal(typeof DEFAULT_STREAM_SESSION_GRACE_MS, "number");
  assert.ok(DEFAULT_STREAM_SESSION_GRACE_MS > 0);
  assert.ok(
    DEFAULT_STREAM_SESSION_GRACE_MS <= 10 * 60_000,
    "an unverified stream must not be allowed to run indefinitely",
  );
});
