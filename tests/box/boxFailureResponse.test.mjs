/**
 * A FAILING BOX ROUTE MUST NOT PUBLISH THE SERVER'S INTERNALS.
 *
 * The box boundary used to answer any `Error` with `err.message` and log the whole error object. Several
 * box routes are backed by PostgreSQL, and `pg` attaches the failing statement to its errors — SQL text,
 * bound parameters, table and constraint names. So a database fault could put schema internals, and
 * whatever values were being bound, into an authenticated HTTP response and into the process logs, while
 * every other route in the application answered through the sanitized `errorHandler()`.
 *
 * Being authenticated does not entitle a caller to the server's internals: an operator session is shared
 * by everyone holding the passcode, browser devtools keep response bodies, and logs get shipped and
 * pasted into tickets.
 *
 * These tests use SENTINEL values — a fake credential and a fake SQL statement — and assert they appear
 * NOWHERE in what a client or a log line receives.
 */

import test from "node:test";
import assert from "node:assert/strict";

const {
  GENERIC_BOX_FAILURE,
  MAX_BROKER_DETAIL_CHARS,
  boxFailureLogLine,
  brokerFailureResponse,
} = await import("../../dist/box/failureResponse.js");

/** A realistically-shaped `pg` error: the driver puts the failing statement on the message. */
function pgError() {
  const err = new Error(
    'duplicate key value violates unique constraint "box_trades_pkey"\n' +
      'INSERT INTO box_trades (id, account, access_token) VALUES ($1, $2, $3)\n' +
      "parameters: id=abc, account=SENTINEL_ACCOUNT_9931, access_token=SENTINEL_TOKEN_e7f1a2",
  );
  err.name = "error";
  err.code = "23505";
  err.table = "box_trades";
  err.constraint = "box_trades_pkey";
  err.query = "INSERT INTO box_trades (id, account, access_token) VALUES ($1, $2, $3)";
  return err;
}

const SENTINELS = ["SENTINEL_TOKEN_e7f1a2", "INSERT INTO", "box_trades_pkey", "23505"];

test("an UNEXPECTED failure tells the client nothing about itself", () => {
  // Not "shorter" and not "redacted" — an unexpected error is one nobody vetted, so the only safe
  // amount to forward is none of it.
  assert.equal(GENERIC_BOX_FAILURE.status, 500);
  assert.equal(GENERIC_BOX_FAILURE.code, "internal_error");
  assert.equal(GENERIC_BOX_FAILURE.message, "Unexpected server error.");

  const serialised = JSON.stringify(GENERIC_BOX_FAILURE);
  for (const sentinel of SENTINELS) {
    assert.ok(!serialised.includes(sentinel), `the generic body must not carry ${sentinel}`);
  }
});

test("the LOG line for a pg failure carries no SQL, no parameters and no credential", () => {
  const line = boxFailureLogLine(pgError());

  assert.ok(!line.includes("INSERT INTO"), "the failing statement must not be logged");
  assert.ok(!line.includes("SENTINEL_TOKEN_e7f1a2"), "a credential-shaped value must be redacted");
  assert.ok(!line.includes("\n"), "one line, so a stack or a multi-line SQL block cannot sneak in");
  assert.ok(line.length <= 320, `the log line must be bounded, got ${line.length} chars`);
  // It still has to be USEFUL: an operator needs to know what class of thing broke.
  assert.match(line, /duplicate key value/);
});

test("a credential in ANY error message is redacted before it is logged", () => {
  const line = boxFailureLogLine(
    new Error("broker call failed: access_token=SENTINEL_TOKEN_e7f1a2 api_key=SENTINEL_KEY_4410"),
  );
  assert.ok(!line.includes("SENTINEL_TOKEN_e7f1a2"));
  assert.ok(!line.includes("SENTINEL_KEY_4410"));
  assert.match(line, /\[redacted\]/);
});

test("a JWT-shaped value is redacted too", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTRU5UMSIsImEiOjF9.c2lnbmF0dXJlX3NlbnRpbmVs";
  const line = boxFailureLogLine(new Error(`session rejected for ${jwt}`));
  assert.ok(!line.includes(jwt), "a bearer token pasted into a message must not reach the log");
  assert.match(line, /redacted-jwt/);
});

test("a non-Error throw does not become the string 'undefined' or a crash", () => {
  assert.equal(typeof boxFailureLogLine(undefined), "string");
  assert.equal(boxFailureLogLine(undefined), "unknown error");
  assert.equal(boxFailureLogLine({ secret: "SENTINEL_TOKEN_e7f1a2" }), "unknown error");
  assert.equal(boxFailureLogLine("plain string failure"), "plain string failure");
});

/* ──────────────── the broker's own words: useful, but not trusted ──────────────── */

test("a broker rejection keeps its reason, because a generic message would be undiagnosable", () => {
  const response = brokerFailureResponse(400, "Insufficient margin for this order");
  assert.equal(response.status, 400);
  assert.equal(response.code, "broker_error");
  assert.match(response.message, /Insufficient margin/);
});

test("but a broker message is redacted and bounded first", () => {
  const response = brokerFailureResponse(
    400,
    `rejected (api_key=SENTINEL_KEY_4410 access_token=SENTINEL_TOKEN_e7f1a2) ${"x".repeat(2_000)}`,
  );
  assert.ok(!response.message.includes("SENTINEL_KEY_4410"));
  assert.ok(!response.message.includes("SENTINEL_TOKEN_e7f1a2"));
  assert.ok(
    response.message.length <= MAX_BROKER_DETAIL_CHARS + 60,
    `broker prose must be bounded, got ${response.message.length} chars`,
  );
});

test("a broker cannot choose a nonsense HTTP status", () => {
  assert.equal(brokerFailureResponse(0, "x").status, 502);
  assert.equal(brokerFailureResponse(200, "x").status, 502, "a failure must not answer 2xx");
  assert.equal(brokerFailureResponse(999, "x").status, 502);
  assert.equal(brokerFailureResponse(503, "x").status, 503, "a sane status is preserved");
});

test("an empty broker message still produces a usable sentence", () => {
  const response = brokerFailureResponse(502, "   ");
  assert.equal(response.message, "The broker rejected the request.");
});

/* ──────────────── every failing box response carries a stable code ──────────────── */

test("the generic failure has a machine-readable code, not only prose", () => {
  // A client that has to match on English to tell failures apart will get it wrong on the first
  // wording change. `code` is the contract; `error` is for the human.
  assert.equal(typeof GENERIC_BOX_FAILURE.code, "string");
  assert.ok(GENERIC_BOX_FAILURE.code.length > 0);
  assert.equal(typeof brokerFailureResponse(502, "x").code, "string");
});
