/**
 * THE PREFLIGHT'S VERDICT AND EXIT CODE MUST AGREE WITH ITS OWN ARITHMETIC.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * With the four one-shot bounds correctly set to 1 and `--lot-size=101`, the preflight printed:
 *
 *     per-leg cap  BOX_LIVE_MAX_OPEN_LEG_QUANTITY=100 -> 101 <= 100 ? REFUSED
 *     gross cap    BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=400 -> 404 <= 400 ? REFUSED
 *
 * and then finished with
 *
 *     VERDICT: the four required settings are satisfied and the quantity arithmetic is shown above.
 *
 * and **exit code 0**. Every individual line was true. The verdict and the exit status were not: no
 * leg of a one-lot box could be sent, so the trial could not run at all. A preflight that exits 0
 * while stating that is worse than no preflight, because a wrapper script reads the exit code and a
 * tired operator reads the last line.
 *
 * Separately, `--lot-size=65.5` was silently floored to 65 and then reported as
 * "one lot (live instrument master) = 65 unit(s)" — a fabricated figure presented as a reading taken
 * from the broker, in the one report whose entire purpose is that the lot size is not invented.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THESE TESTS SPAWN THE REAL CLI
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The defect lived in the seam between the report and the process: the pure function was fine, the
 * CLI discarded its outcome. Only running `node dist/box/effectiveConfig.js` as a PROCESS and reading
 * its actual exit status can catch that. Calling the function and asserting the returned string would
 * have passed against the broken build.
 *
 * Exit codes: 0 = PASS, 1 = preflight did not pass, 2 = unusable input or a config that cannot boot.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/box/effectiveConfig.js", import.meta.url));

/** The four one-shot bounds, correctly set. Every case below starts from a VALID profile. */
const TRIAL_ENV = {
  BOX_SUPERVISED_ONE_LOT_TRIAL: "true",
  BOX_MAX_OPEN_BOXES: "1",
  BOX_LIVE_MAX_OPEN_BOXES: "1",
  BOX_SESSION_MAX_COMPLETED_TRADES: "1",
  BOX_SESSION_MAX_ENTRY_ATTEMPTS: "1",
};

/**
 * Run the real preflight as a child process.
 *
 * The environment is built from a COPY of `process.env` with every `BOX_`/`ZERODHA_`/`DHAN_` key
 * stripped first, so an ambient value cannot supply a setting the case means to leave unset and make
 * the test lie about what the CLI guarantees.
 */
function preflight(args = [], env = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("BOX_") || key.startsWith("ZERODHA_") || key.startsWith("DHAN_")) delete clean[key];
  }
  const result = spawnSync(process.execPath, [CLI, "--supervised-trial", ...args], {
    env: { ...clean, ...TRIAL_ENV, ...env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/* ═══════════════════ 1. VALID lot sizes pass, and say what passed ═══════════════════ */

test("a valid lot size that fits both caps PASSES with exit 0", () => {
  const r = preflight(["--lot-size=75"]);

  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.output}`);
  assert.match(r.stdout, /VERDICT: PASS/);
  assert.match(r.stdout, /one lot of 75 unit\(s\) is admissible under both quantity caps/);
  // The arithmetic is still shown — a pass must remain auditable, not just asserted.
  assert.match(r.stdout, /gross quantity {5}= 75 x 4 legs = 300/);
  assert.match(r.stdout, /75 <= 100 \? PASS/);
  assert.match(r.stdout, /300 <= 400 \? PASS/);
  assert.doesNotMatch(r.stdout, /REFUSED/, "nothing is refused at a lot size that fits");
});

test("a DIFFERENT valid lot size recomputes everything — nothing is hardcoded", () => {
  const r = preflight(["--lot-size=65"]);

  assert.equal(r.status, 0);
  assert.match(r.stdout, /VERDICT: PASS/);
  assert.match(r.stdout, /one lot \(live instrument master\) = 65 unit\(s\)/);
  assert.match(r.stdout, /gross quantity {5}= 65 x 4 legs = 260/);
  assert.doesNotMatch(r.stdout, /= 75 unit/, "75 must not leak in from a fixture");
});

test("the largest lot that still fits passes, and the first that does not fails", () => {
  // The boundary, asserted from both sides so an off-by-one in the comparison cannot hide.
  assert.equal(preflight(["--lot-size=100"]).status, 0, "100 == the per-leg cap, so it fits");
  assert.equal(preflight(["--lot-size=101"]).status, 1, "101 exceeds it");
});

/* ═══════════════════ 2. A REJECTED PER-LEG CAP IS A FAILURE ═══════════════════ */

test("THE DEFECT: --lot-size=101 now FAILS with exit 1 and a verdict that says so", () => {
  const r = preflight(["--lot-size=101"]);

  // The exit status is the half the original defect got wrong.
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.output}`);

  // The arithmetic still reports both refusals...
  assert.match(r.stdout, /BOX_LIVE_MAX_OPEN_LEG_QUANTITY=100 -> 101 <= 100 \? REFUSED/);
  assert.match(r.stdout, /BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=400 -> 404 <= 400 \? REFUSED/);

  // ...and the verdict no longer contradicts it.
  assert.match(r.stdout, /VERDICT: FAILED/);
  assert.match(r.stdout, /ONE LOT CANNOT BE SENT/);
  assert.match(r.stdout, /per-leg quantity 101 exceeds BOX_LIVE_MAX_OPEN_LEG_QUANTITY=100/);
  assert.match(r.stdout, /gross quantity 404 exceeds BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=400/);
  assert.match(r.stdout, /the trial cannot run/);

  // The exact reassuring sentence that shipped must never come back.
  assert.doesNotMatch(
    r.stdout,
    /VERDICT: the four required settings are satisfied and the quantity arithmetic is shown above/,
  );
});

test("a per-leg cap rejection ALONE fails, even when the gross cap is generous", () => {
  // Isolates the per-leg rule: gross is raised so only the per-leg comparison can refuse.
  const r = preflight(["--lot-size=150"], { BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY: "10000" });

  assert.equal(r.status, 1);
  assert.match(r.stdout, /per-leg quantity 150 exceeds BOX_LIVE_MAX_OPEN_LEG_QUANTITY=100/);
  assert.doesNotMatch(r.stdout, /gross quantity \d+ exceeds/, "the gross cap is satisfied here");
  assert.match(r.stdout, /VERDICT: FAILED/);
});

/* ═══════════════════ 3. A REJECTED GROSS CAP IS A FAILURE ═══════════════════ */

test("a gross cap rejection ALONE fails — four legs is what breaches it", () => {
  /*
   * This case is UNREACHABLE at the shipped defaults, and that is worth knowing: the gross cap (400)
   * is exactly 4x the per-leg cap (100), so any lot that breaches gross has already breached per-leg.
   * Raising the per-leg cap is what exposes the gross rule on its own — and an operator who raises
   * one cap without the other lands here for real.
   */
  const r = preflight(["--lot-size=120"], { BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "200" });

  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.output}`);
  assert.match(r.stdout, /120 <= 200 \? PASS/, "the per-leg cap is satisfied");
  assert.match(r.stdout, /480 <= 400 \? REFUSED/, "the gross cap is not");
  assert.match(r.stdout, /gross quantity 480 exceeds BOX_LIVE_MAX_GROSS_OPEN_LEG_QUANTITY=400/);
  assert.doesNotMatch(r.stdout, /per-leg quantity \d+ exceeds/);
  assert.match(r.stdout, /VERDICT: FAILED/);
});

/* ═══════════════════ 4. BAD INPUT IS REJECTED, NEVER COERCED ═══════════════════ */

test("THE DEFECT: --lot-size=65.5 is REJECTED, not floored to 65", () => {
  const r = preflight(["--lot-size=65.5"]);

  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.output}`);
  assert.match(r.stderr, /must be a POSITIVE INTEGER/);
  assert.match(r.stderr, /refused rather than rounded/);
  assert.match(r.stderr, /Do not assume 75 or 65/);

  // THE HEADLINE: no arithmetic may be computed or printed from a value nobody read.
  assert.doesNotMatch(r.output, /one lot \(live instrument master\) = 65 unit/);
  assert.doesNotMatch(r.output, /= 65 x 4 legs/);
  assert.doesNotMatch(r.output, /VERDICT: PASS/);
});

test("other fractional values are rejected too, including ones that would round UP", () => {
  // `.5` and above would round up under `Math.round` and down under `Math.floor`; neither is
  // acceptable, so the test covers both sides of the midpoint.
  for (const value of ["65.5", "74.9", "75.1", "0.5", "1e2.5"]) {
    const r = preflight([`--lot-size=${value}`]);
    assert.equal(r.status, 2, `--lot-size=${value} must be rejected, got exit ${r.status}`);
    assert.match(r.stderr, /POSITIVE INTEGER/);
  }
});

test("zero is rejected", () => {
  const r = preflight(["--lot-size=0"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /POSITIVE INTEGER/);
  assert.match(r.stderr, /got "0"/);
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/);
});

test("a negative lot size is rejected", () => {
  const r = preflight(["--lot-size=-75"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /POSITIVE INTEGER/);
  assert.match(r.stderr, /got "-75"/);
});

test("a non-numeric lot size is rejected", () => {
  for (const value of ["abc", "seventy-five", "75units", "NaN", "Infinity", " "]) {
    const r = preflight([`--lot-size=${value}`]);
    assert.equal(r.status, 2, `--lot-size=${value} must be rejected, got exit ${r.status}`);
    assert.match(r.stderr, /POSITIVE INTEGER/);
    assert.doesNotMatch(r.stdout, /VERDICT: PASS/);
  }
});

test("an EMPTY --lot-size= is rejected rather than treated as absent", () => {
  // `Number("")` is 0, so an empty value used to slip through the finite check. It is also the most
  // likely shell accident (`--lot-size=$LOT` with LOT unset), and silently reading it as "not
  // supplied" would turn a mistake into an UNVERIFIED pass-looking report.
  const r = preflight(["--lot-size="]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /POSITIVE INTEGER/);
});

/* ═══════════════════ 5. MISSING lot size stays UNVERIFIED — and is not a pass ═══════════════════ */

test("no lot size at all reports UNVERIFIED and does NOT exit 0", () => {
  const r = preflight([]);

  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.output}`);
  assert.match(r.stdout, /UNVERIFIED — no lot size supplied/);
  assert.match(r.stdout, /Do not assume 75 or 65/);
  assert.match(r.stdout, /VERDICT: NOT VERIFIED/);
  // The four bounds ARE satisfied, and the report says so — it just does not call that a pass.
  assert.match(r.stdout, /the four required settings are satisfied/);
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/);
  // And no arithmetic is invented in the absence of a reading.
  assert.doesNotMatch(r.stdout, /gross quantity {5}=/);
});

/* ═══════════════════ 6. THE STARTUP RULE IS UNCHANGED ═══════════════════ */

test("the four one-shot bounds are still REQUIRED to be 1", () => {
  // Each one, dropped individually, must still stop the preflight — with a valid lot size supplied,
  // so the failure can only be the bound.
  for (const key of [
    "BOX_MAX_OPEN_BOXES",
    "BOX_LIVE_MAX_OPEN_BOXES",
    "BOX_SESSION_MAX_COMPLETED_TRADES",
    "BOX_SESSION_MAX_ENTRY_ATTEMPTS",
  ]) {
    const r = preflight(["--lot-size=75"], { [key]: "2" });
    assert.notEqual(r.status, 0, `${key}=2 must not pass`);
    assert.ok(r.output.includes(key), `${key} must be named in the output`);
    assert.doesNotMatch(r.stdout, /VERDICT: PASS/);
  }
});

test("a bound left UNSET (code default 0 = unlimited) refuses to boot, exit 2", () => {
  const r = preflight(["--lot-size=75"], { BOX_SESSION_MAX_ENTRY_ATTEMPTS: undefined });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.output}`);
  assert.match(r.stderr, /configuration would NOT boot/);
  assert.match(r.stderr, /BOX_SESSION_MAX_ENTRY_ATTEMPTS=0/);
  assert.match(r.stderr, /UNLIMITED/);
});

test("with the profile OFF the report says NOT CONFIGURED and does not pass", () => {
  const r = preflight(["--lot-size=75"], {
    BOX_SUPERVISED_ONE_LOT_TRIAL: "false",
    BOX_MAX_OPEN_BOXES: undefined,
    BOX_SESSION_MAX_COMPLETED_TRADES: undefined,
    BOX_SESSION_MAX_ENTRY_ATTEMPTS: undefined,
  });

  assert.notEqual(r.status, 0, "a host that is not configured for the trial is not a pass");
  assert.match(r.stdout, /NOT CONFIGURED FOR THE SUPERVISED TRIAL/);
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/);
  assert.doesNotMatch(r.stdout, /FAIL/, "the general-purpose defaults are not failures");
});

/* ═══════════════════ 7. the plain report is untouched ═══════════════════ */

test("the ordinary effective-config report still works and exits 0", () => {
  // `--supervised-trial` is an added mode, not a replacement. A regression here would break the
  // existing pre-flight command operators already use.
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("BOX_") || key.startsWith("ZERODHA_") || key.startsWith("DHAN_")) delete clean[key];
  }
  const r = spawnSync(process.execPath, [CLI], { env: clean, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /BOX_SUPERVISED_ONE_LOT_TRIAL/, "the flag appears with its provenance");
  assert.doesNotMatch(r.stdout, /SUPERVISED ONE-LOT TRIAL PREFLIGHT/, "not the preflight block");
});
