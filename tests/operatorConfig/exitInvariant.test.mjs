/**
 * THE EXIT / RISK-REDUCTION INVARIANT — asserted against the real backend source.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PROPERTY
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Configuration may block speculative ENTRY. It must NEVER block risk reduction. After ownership or
 * exposure exists, all of these must remain possible regardless of how restrictive entry
 * configuration has become:
 *
 *     EXIT · protective cancellation · emergency residual flatten ·
 *     reconciliation-required reduction · recovery / unwind
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE SOURCE ASSERTIONS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The invariant is STRUCTURAL: it holds because the entry gates are consulted on entry-only code
 * paths, not because a runtime check happens to return the right answer. A behavioural test would
 * need the engine, a broker adapter and a database; a structural test can assert the property that
 * actually makes it true — that the reduction paths do not reference the configuration at all.
 *
 * This is also the regression the codebase has already suffered once. `exposureReductionBlockReason`
 * carries a long comment recording that `box_live_order_enabled` used to disable every reduction path
 * at once, with `cancelWorkingBoxOrders()` returning an empty SUCCESS indistinguishable from "nothing
 * was working". These assertions are what stop the configuration refactor from reintroducing the same
 * shape of defect through a different door.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { registry, repoPath } from "./_harness.mjs";

const { OPERATOR_SETTINGS } = registry;

const read = (...parts) => readFileSync(repoPath(...parts), "utf8");

/**
 * Extract one function body, given a fragment of its signature.
 *
 * SUBTLETY THAT MATTERS: several of these functions take an inline object type —
 * `refsForExit(position: {` , `evaluateExitDecision(args: {`. Brace-counting from the first `{`
 * after the signature therefore captures the PARAMETER TYPE, not the body. For an
 * assert-this-is-absent test that is a silent false pass, which is worse than a failure.
 *
 * So the parameter list is skipped by matching parentheses first, and only then is the opening brace
 * of the body located. `assertRealBody` below is the tripwire that keeps this honest.
 */
function functionBody(source, signatureFragment) {
  const at = source.indexOf(signatureFragment);
  assert.notEqual(at, -1, `could not find "${signatureFragment}" — the test needs updating`);

  // Walk the parameter list from its opening paren to its matching close.
  const paren = source.indexOf("(", at);
  assert.notEqual(paren, -1, `no parameter list after "${signatureFragment}"`);
  let pdepth = 0;
  let afterParams = -1;
  for (let i = paren; i < source.length; i++) {
    if (source[i] === "(") pdepth++;
    else if (source[i] === ")") {
      pdepth--;
      if (pdepth === 0) {
        afterParams = i + 1;
        break;
      }
    }
  }
  assert.notEqual(afterParams, -1, `unbalanced parens after "${signatureFragment}"`);

  const open = source.indexOf("{", afterParams);
  assert.notEqual(open, -1, `no body brace after "${signatureFragment}"`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after "${signatureFragment}"`);
}

/**
 * Guard against the extraction silently returning something trivial.
 *
 * Every "this function does not mention X" assertion is only as good as the body it was handed, so
 * each one names a token it KNOWS the real body contains.
 */
function assertRealBody(body, mustContain, label) {
  assert.ok(
    body.includes(mustContain),
    `extracted body for ${label} does not contain "${mustContain}" — the extraction is wrong, so any absence assertion against it would be a false pass`,
  );
}

/** Source with comments stripped, so the prose explaining a gate is not mistaken for the gate. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/* ═════════════════ 1. The reduction gate consults no operator configuration ═════════════════ */

test("exposureReductionBlockReason references no runtime-configurable setting", () => {
  const raw = functionBody(
    read("src", "box", "orderManager.ts"),
    "exposureReductionBlockReason(): string | null",
  );
  assertRealBody(raw, "disposed", "exposureReductionBlockReason");
  const body = stripComments(raw);

  for (const s of OPERATOR_SETTINGS) {
    assert.equal(
      body.includes(s.boxConfigField),
      false,
      `the reduction gate consults ${s.boxConfigField} (${s.key}) — a config change could block getting flat`,
    );
    assert.equal(body.includes(s.envVar), false, `the reduction gate references ${s.envVar}`);
  }
  // Nor any limit at all: the whole `limits` copy is entry-side authority.
  assert.equal(body.includes("deps.limits"), false, "the reduction gate reads an entry limit");
});

test("the reduction gate depends only on whether this process can still act", () => {
  const raw = functionBody(
    read("src", "box", "orderManager.ts"),
    "exposureReductionBlockReason(): string | null",
  );
  assertRealBody(raw, "disposed", "exposureReductionBlockReason");
  const body = stripComments(raw);
  // Not disposed, and the broker session is not KNOWN-bad. `=== "unhealthy"` rather than
  // `!== "healthy"` is deliberate: an UNVERIFIED session must still be able to get flat.
  assert.match(body, /disposed/);
  assert.match(body, /"unhealthy"/);
  assert.equal(/!==\s*"healthy"/.test(body), false, "an unverified broker session would block reduction");
});

/* ═════════════════ 2. The capital cap is entry-only ═════════════════ */

test("the per-Box capital cap is reached only for an ENTRY", () => {
  const source = read("src", "box", "orderManager.ts");

  // Every call site lives inside a method; within that method the `purpose === "ENTRY"` guard must
  // come BEFORE the call. A character window would be fragile, so the enclosing body is extracted and
  // the two positions compared inside it.
  const CALLERS = [
    { signature: "private queuedActionBlockReason(action: QueueAction): string | null", token: "entryBlockReason" },
  ];

  let checked = 0;
  for (const caller of CALLERS) {
    const raw = functionBody(source, caller.signature);
    assertRealBody(raw, caller.token, caller.signature);
    const body = stripComments(raw);
    if (!body.includes("capitalBlockReason(")) continue;

    const guardAt = body.indexOf('purpose === "ENTRY"');
    const callAt = body.indexOf("capitalBlockReason(");
    assert.notEqual(guardAt, -1, `${caller.signature} calls capitalBlockReason with no ENTRY guard`);
    assert.ok(
      guardAt < callAt,
      `${caller.signature} calls capitalBlockReason before its ENTRY guard`,
    );
    checked++;
  }
  assert.equal(checked, 1, "expected exactly one guarded caller of capitalBlockReason");

  // And no OTHER method may call it. Anything new must be added to CALLERS deliberately.
  const callLines = [...source.matchAll(/^.*capitalBlockReason\(.*$/gm)]
    .map((m) => m[0].trim())
    .filter((line) => !line.startsWith("private capitalBlockReason"))
    .filter((line) => !line.startsWith("*"));
  assert.equal(callLines.length, 1, `unexpected capitalBlockReason call sites: ${callLines.join(" | ")}`);
});

test("the capital cap's own body states and keeps its entry-only scope", () => {
  const source = read("src", "box", "orderManager.ts");
  const doc = source.slice(Math.max(0, source.indexOf("private capitalBlockReason") - 1200),
    source.indexOf("private capitalBlockReason"));
  assert.match(doc, /ENTRY/);
  assert.match(doc, /EXIT|PROTECTIVE_CANCEL|EMERGENCY_RESIDUAL/);
});

/* ═════════════════ 3. The coordinator's entry gates have no exit counterpart ═════════════════ */

test("the exit reservation path applies none of the entry admission gates", () => {
  const source = read("src", "box", "executionCoordinator.ts");
  const rawExit = functionBody(
    source,
    "private async acquireForExit(executionId: string, refs: InstrumentLegRef[])",
  );
  assertRealBody(rawExit, "acquireWith", "acquireForExit");
  const exitBody = stripComments(rawExit);

  const rawRefs = functionBody(source, "private refsForExit");
  assertRealBody(rawRefs, "boxInstrumentRefs", "refsForExit");
  const refsExit = stripComments(rawRefs);

  // The five entry-only gates named in the audit.
  const ENTRY_GATES = [
    "sessionEntryGate",
    "sessionConsumeAttempt",
    "underlyingExclusion",
    "maxOpenBoxes",
    "boxInventory",
    "oneActiveBoxPerUnderlying",
    "liveMaxOpenLegQuantity",
    "liveMaxGrossOpenLegQuantity",
  ];
  for (const gate of ENTRY_GATES) {
    assert.equal(exitBody.includes(gate), false, `acquireForExit consults the entry gate ${gate}`);
    assert.equal(refsExit.includes(gate), false, `refsForExit consults the entry gate ${gate}`);
  }
});

test("no registered setting is consulted on the exit reservation path", () => {
  const source = read("src", "box", "executionCoordinator.ts");
  const rawExit = functionBody(
    source,
    "private async acquireForExit(executionId: string, refs: InstrumentLegRef[])",
  );
  assertRealBody(rawExit, "acquireWith", "acquireForExit");
  const exitBody = stripComments(rawExit);
  for (const s of OPERATOR_SETTINGS) {
    assert.equal(
      exitBody.includes(s.boxConfigField),
      false,
      `acquireForExit consults ${s.boxConfigField} (${s.key})`,
    );
  }
});

/* ═════════════════ 4. The emergency expiry exit is not gated by a profit target ═════════════════ */

test("EXPIRY_SAFETY overrides profitability and is not gated by minExitNetPnl", () => {
  const source = read("src", "box", "math.ts");
  const body = functionBody(source, "export function evaluateExitDecision");
  assertRealBody(body, "EXPIRY_SAFETY", "evaluateExitDecision");
  assertRealBody(body, "clearsFloor", "evaluateExitDecision");
  const code = stripComments(body);

  // The emergency reason is selected as a fallback when no profit rule fired — it does not pass
  // through `clearsFloor`, which is the only place minExitNetPnl is consulted.
  assert.match(code, /ruleReason \?\? \(expirySafety \? "EXPIRY_SAFETY" : null\)/);

  const floorLine = /const clearsFloor = .*minExitNetPnl/.exec(code);
  assert.notEqual(floorLine, null, "minExitNetPnl is no longer read where this test expects");

  // `clearsFloor` must only ever contribute to the two VOLUNTARY rules.
  for (const m of code.matchAll(/^.*clearsFloor.*$/gm)) {
    const line = m[0];
    if (line.includes("const clearsFloor")) continue;
    assert.match(
      line,
      /EDGE_CONVERGED|PROFIT_CAPTURE|blocked/,
      `clearsFloor influences something other than a voluntary profit rule: ${line.trim()}`,
    );
  }
});

test("minExitNetPnl is not referenced by any protective or emergency path", () => {
  // Its only consumers should be the exit ARITHMETIC, the published config view and the per-trade
  // snapshot — never the order manager, the coordinator or the flatten path.
  for (const file of ["orderManager.ts", "executionCoordinator.ts", "executionGateway.ts"]) {
    const source = read("src", "box", file);
    assert.equal(
      source.includes("minExitNetPnl"),
      false,
      `${file} references minExitNetPnl, which would put a profit target on an execution path`,
    );
  }
});

/* ═════════════════ 5. The configuration subsystem is nowhere near an order path ═════════════════ */

test("no execution module imports the operator-config policy or validation modules", () => {
  // These decide whether a CONFIGURATION WRITE is permitted. If an order path ever imported them, the
  // structural guarantee above would become a runtime question.
  const FILES = [
    "orderManager.ts",
    "executionCoordinator.ts",
    "executionGateway.ts",
    "positionMonitor.ts",
    "executionSimulator.ts",
    "scanner.ts",
  ];
  for (const file of FILES) {
    const source = read("src", "box", file);
    for (const module of ["operatorConfig/policy", "operatorConfig/validate"]) {
      assert.equal(source.includes(module), false, `${file} imports ${module}`);
    }
  }
});

test("the settings most likely to be misread as exit gates say plainly that they are not", () => {
  // Deliberately a NAMED list rather than a keyword heuristic. Several descriptions mention "exit"
  // entirely benignly — expected exit slippage, the convergence exit rule, the profit-capture exit
  // rule — and flagging those taught nothing. These three are the ones an operator could genuinely
  // mistake for a permission to get flat.
  const MUST_DISCLAIM = ["minExitNetPnl", "liveMaxBoxCapitalRupees", "maxOpenBoxes"];
  for (const key of MUST_DISCLAIM) {
    const s = OPERATOR_SETTINGS.find((x) => x.key === key);
    assert.notEqual(s, undefined, `${key} is no longer registered`);
    const text = `${s.description} ${s.caveat ?? ""}`;
    assert.match(
      text,
      /never|not an exit permission|unaffected|ignore/i,
      `${key} does not state that risk reduction is unaffected`,
    );
  }
});
