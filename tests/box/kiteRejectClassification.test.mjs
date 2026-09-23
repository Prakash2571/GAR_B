/**
 * KITE REJECT CLASSIFICATION — the operator's last diagnostic signal.
 *
 * `classifyKiteReject` feeds `ExecutionOutcomeStore`'s counters. Nothing branches on the family, so
 * a misclassification never changes execution behaviour — which is exactly why it went unnoticed and
 * exactly why it matters. When a session dies, the market-data health machine degrades and entries
 * stop, but the reject STATISTICS are the surface an operator reads to find out WHY. Reporting a dead
 * access token as "instrument unavailable" sends them to look at the option chain instead of at their
 * session.
 *
 * THE DEFECT THIS PINS. The instrument pattern used to include a bare `token`:
 *
 *     if (/instrument|contract|token|scrip.*not/.test(message)) return "instrument_unavailable";
 *     ...
 *     if (/auth|token|permission|401|403/.test(message)) return "auth";
 *
 * Kite's TokenException body is literally "Invalid `api_key` or `access_token`." — it contains
 * "token", so it matched the instrument branch and RETURNED before the auth branch was ever reached.
 * Every dead-token and static-IP 403 rejection was filed as an instrument problem.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { classifyKiteReject } from "../../dist/box/kiteBrokerAdapter.js";

/* ── the regression: real Kite auth bodies must classify as auth ────────────────────────────── */

test("Kite's real TokenException body classifies as auth, not instrument_unavailable", () => {
  // Verbatim shapes Kite returns. The backtick-quoted field names are Kite's own formatting.
  const bodies = [
    "Invalid `api_key` or `access_token`.",
    "Invalid `api_key` or `access_token`",
    "TokenException: Invalid access token",
    "Incorrect `api_key` or `access_token`.",
  ];
  for (const body of bodies) {
    assert.equal(
      classifyKiteReject(new Error(body)), "auth",
      `"${body}" must be reported as an auth failure — it contains the word "token", which used to ` +
        `match the instrument pattern first and hide every dead session behind "instrument unavailable"`,
    );
  }
});

test("a static-IP / permission 403 classifies as auth", () => {
  for (const body of [
    "403 Forbidden",
    "Request forbidden: your IP is not whitelisted",
    "Insufficient permission for that call.",
    "401 Unauthorized",
  ]) {
    assert.equal(classifyKiteReject(new Error(body)), "auth", body);
  }
});

/* ── the instrument family still works, on the messages Kite actually sends ─────────────────── */

test("genuine instrument problems still classify as instrument_unavailable", () => {
  // Kite names an instrument problem by tradingsymbol / contract / scrip — never as a bare "token".
  for (const body of [
    "Invalid tradingsymbol",
    "The contract has expired",
    "Scrip is not available for trading",
    "instrument not found",
  ]) {
    assert.equal(classifyKiteReject(new Error(body)), "instrument_unavailable", body);
  }
});

/* ── the other families, so reordering auth to the front broke nothing ──────────────────────── */

test("the remaining families are unchanged by the reordering", () => {
  const cases = [
    ["Insufficient margin for this order", "margin"],
    ["RMS: margin shortfall", "margin"], // margin still wins over rms; more actionable
    ["funds unavailable", "margin"],
    ["Order price is outside the daily price band", "price_band"],
    ["circuit limit breached", "price_band"],
    ["Markets are closed", "market_closed"],
    ["order placed outside market hours", "market_closed"],
    ["Too many requests", "rate_limit"],
    ["429", "rate_limit"],
    ["RMS: Rule blocked for this security", "rms"],
    ["risk management check failed", "rms"],
    ["Quantity exceeds the freeze limit", "quantity_freeze"],
    ["invalid lot size", "quantity_freeze"],
    ["something entirely unexpected happened", "generic"],
  ];
  for (const [body, expected] of cases) {
    assert.equal(classifyKiteReject(new Error(body)), expected, body);
  }
});

test("an F&O ban-period refusal classifies as rms", () => {
  /*
   * NSE bans FRESH positions in a stock underlying once open interest crosses 95% of market-wide
   * position limits, and Zerodha refuses those orders with a ban-period message. It is an RMS
   * refusal, and the family matters because it is per-UNDERLYING and persists for the day — quite
   * unlike a transient margin blip.
   */
  for (const body of [
    "RMS: Rule: Check if ban period security exists",
    "This security is banned for new positions today",
  ]) {
    assert.equal(classifyKiteReject(new Error(body)), "rms", body);
  }
});

test("classification never throws on a non-Error input", () => {
  // It runs inside the order path's catch blocks, so it must be total.
  for (const input of [null, undefined, 0, "", {}, [], new Error("")]) {
    assert.doesNotThrow(() => classifyKiteReject(input), `input ${JSON.stringify(input)}`);
  }
});
