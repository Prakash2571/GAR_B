/**
 * THE LIVE ENTRY ALLOWLIST — IDENTITY, NOT COUNT.
 *
 * `BOX_MAX_UNDERLYINGS=1` bounds HOW MANY names are considered, not WHICH. The surviving name is
 * chosen by the board's own priority order, so a universe change, an index reshuffle or a
 * newly-listed name can silently move which instrument a supervised trial actually trades. The
 * operator blocklist is the wrong tool for the inverse problem: it requires naming every instrument
 * you do NOT want, which is unbounded and fails OPEN on anything added after you wrote it.
 *
 * An allowlist fails CLOSED on exactly that case, and this file pins three things about it:
 *   1. it normalises identically to the blocklist, so the two layers cannot disagree about what a
 *      symbol is;
 *   2. an unusable or unlisted symbol is refused, while an EMPTY list means unconstrained — because
 *      unset is how every existing deployment is configured, and reading it as "nothing may trade"
 *      would silently convert an upgrade into a total halt;
 *   3. it is composed into the SAME verdict function the blocklist uses, which is what makes it
 *      entry-only and impossible to bypass at any of the four enforcement points.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadBoxConfig } from "../../dist/box/config.js";
import { allowlistEntryRefusal, normaliseAllowlist } from "../../dist/box/underlyingExclusions.js";

function withEnv(vars, body) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const PAPER = { BOX_EXECUTION_MODE: "paper_latency" };

/* ───────────────────────────── normalisation ───────────────────────────── */

test("the configured list is normalised, de-duplicated and sorted at load", () => {
  const cases = [
    [undefined, []],
    ["", []],
    ["   ", []],
    ["NIFTY", ["NIFTY"]],
    [" nifty ", ["NIFTY"]],
    ["nifty,banknifty", ["BANKNIFTY", "NIFTY"]],
    ["NIFTY,NIFTY", ["NIFTY"]],
    ["NIFTY,,BANKNIFTY", ["BANKNIFTY", "NIFTY"]],
    // Junk that could never match any real symbol is dropped rather than retained as dead config.
    ["NIFTY,!!,##", ["NIFTY"]],
  ];
  for (const [raw, expected] of cases) {
    withEnv({ ...PAPER, BOX_LIVE_ALLOWED_UNDERLYINGS: raw }, () => {
      assert.deepEqual(
        [...loadBoxConfig().liveAllowedUnderlyings],
        expected,
        `BOX_LIVE_ALLOWED_UNDERLYINGS=${JSON.stringify(raw)}`,
      );
    });
  }
});

test("normaliseAllowlist uses the SAME symbol rules as the blocklist", () => {
  // If these two disagreed, " nifty " could pass one layer and fail the other.
  assert.deepEqual(normaliseAllowlist([" nifty "]), ["NIFTY"]);
  assert.deepEqual(normaliseAllowlist(["NIFTY", "nifty", "NiFtY"]), ["NIFTY"]);
  assert.deepEqual(normaliseAllowlist([""]), []);
  assert.deepEqual(normaliseAllowlist([null, undefined, 42]), [], "non-strings are not symbols");
});

/* ───────────────────────────── the verdict ───────────────────────────── */

test("an EMPTY allowlist permits everything — unset must not become a trading halt", () => {
  for (const name of ["NIFTY", "PAYTM", "anything"]) {
    assert.equal(allowlistEntryRefusal([], name), null);
  }
});

test("a listed symbol is permitted, case-insensitively", () => {
  for (const name of ["NIFTY", "nifty", " NiFtY "]) {
    assert.equal(allowlistEntryRefusal(["NIFTY"], name), null, `"${name}" must match NIFTY`);
  }
  assert.equal(allowlistEntryRefusal(["BANKNIFTY", "NIFTY"], "BANKNIFTY"), null);
});

test("an UNLISTED symbol is refused, and the refusal names the effective list", () => {
  const refusal = allowlistEntryRefusal(["NIFTY"], "PAYTM");
  assert.ok(refusal, "PAYTM must be refused when only NIFTY is allowed");
  assert.equal(refusal.code, "underlying_not_allowlisted");
  assert.match(refusal.detail, /PAYTM/);
  assert.match(refusal.detail, /NIFTY/, "the operator must be told what IS allowed");
  assert.match(
    refusal.detail,
    /still exit, reduce and protectively cancel/,
    "and must be told that exposure already owned is unaffected",
  );
});

test("an UNUSABLE symbol fails CLOSED — the opposite call to the blocklist, deliberately", () => {
  /*
   * The allowlist exists so that only named instruments are traded, so "I cannot tell what this is"
   * must refuse. The blocklist makes the opposite call on the same input and is also right: there,
   * an unrecognised name simply is not on the blocklist.
   */
  for (const bad of ["", "   ", "!!", null, undefined]) {
    const refusal = allowlistEntryRefusal(["NIFTY"], bad);
    assert.ok(refusal, `${JSON.stringify(bad)} must be refused, not passed`);
    assert.equal(refusal.code, "underlying_not_allowlisted");
  }
});

/* ──────── entry-only, by composition rather than by a promise in a comment ──────── */

/**
 * The allowlist is wired by being composed into `underlyingExclusionRefusal` — the single function
 * already injected into all four entry enforcement points (the cheap scanner filter and three
 * authoritative lower layers). That is what makes it unbypassable and simultaneously incapable of
 * blocking a reduction.
 *
 * This is asserted STRUCTURALLY over the source because the alternative — a second, separately
 * wired check — is exactly the mistake it avoids: it would have to re-earn all four enforcement
 * points and could be silently forgotten at any of them.
 */
test("the allowlist is composed into the SHARED entry verdict, not wired separately", () => {
  const engine = readFileSync(new URL("../../src/box/engine.ts", import.meta.url), "utf8");

  const chokepoint = engine.slice(
    engine.indexOf("private underlyingExclusionRefusal"),
    engine.indexOf("/** The blocklist as the API reports it. */"),
  );
  assert.ok(chokepoint.length > 0, "fixture: the shared verdict function must be locatable");
  assert.match(chokepoint, /allowlistEntryRefusal\(/, "the allowlist must be evaluated in the shared verdict");
  assert.match(chokepoint, /exclusionEntryRefusal\(/, "...alongside the blocklist");

  // The allowlist must be checked FIRST: it is the cheaper, more fundamental question, and it must
  // not depend on the blocklist being readable or a database outage could widen what is tradable.
  assert.ok(
    chokepoint.indexOf("allowlistEntryRefusal(") < chokepoint.indexOf("exclusionEntryRefusal("),
    "the allowlist must be evaluated before the blocklist",
  );

  // And it must be reached ONLY through that shared function — never called directly from elsewhere
  // in the engine, which is how a caller could accidentally consult it on a reduction path.
  const directCalls = engine.split("allowlistEntryRefusal(").length - 1;
  assert.equal(directCalls, 1, "the allowlist must have exactly one call site: the shared verdict");
});

test("the shared verdict is injected only as an ENTRY dependency", () => {
  const engine = readFileSync(new URL("../../src/box/engine.ts", import.meta.url), "utf8");
  const sites = [...engine.matchAll(/^\s*(\w+):\s*\((\w+)\) =>\s*this\.underlyingExclusionRefusal/gm)].map(
    (m) => m[1],
  );
  const cheap = [...engine.matchAll(/^\s*(\w+):\s*\((\w+)\) =>\s*this\.underlyingExclusionRefusal\(\w+\) !== null/gm)]
    .map((m) => m[1]);
  const all = new Set([...sites, ...cheap]);
  assert.ok(all.size >= 2, `expected multiple enforcement points, found ${[...all].join(", ")}`);
  for (const name of all) {
    assert.match(
      name,
      /^(underlyingExclusion|isUnderlyingExcluded)$/,
      `the verdict is injected as "${name}" — every injection name must be an entry-side dependency, ` +
        `because a reduction path receiving it could refuse to reduce`,
    );
  }
});

/* ─────────────── the shipped supervised profile constrains identity ─────────────── */

test("the final one-box profile allowlists exactly NIFTY", () => {
  const text = readFileSync(new URL("../../deploy/FINAL-one-box-live.env.template", import.meta.url), "utf8");
  const match = text.match(/^BOX_LIVE_ALLOWED_UNDERLYINGS=(\S+)/m);
  assert.ok(match, "the supervised profile must constrain identity, not only count");
  assert.deepEqual(normaliseAllowlist(match[1].split(",")), ["NIFTY"]);

  // Count and identity are different controls and the profile needs both.
  assert.match(text, /^BOX_MAX_UNDERLYINGS=1$/m, "the count cap must remain alongside the allowlist");
});
