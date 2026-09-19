/**
 * TEST HARNESS for the operator-configuration modules.
 *
 * WHY THESE TESTS RUN AGAINST `src/**.ts` AND NOT `dist/**.js`
 *
 * Every other suite in this repository imports from `../../dist/` and is right to: asserting against
 * the built output proves the thing that ships. These modules get a second, narrower treatment
 * because their defining property is that they are PURE — no `express`, no `pg`, no `mongodb`, no
 * `node:fs`, nothing but types and arithmetic. Running them straight from source under
 * `--experimental-strip-types`, with no build and no devDependencies, is evidence of that purity
 * rather than a way around the toolchain. If someone later adds a database call to `policy.ts`, this
 * harness stops working, which is exactly the alarm we want.
 *
 * The resolve hook exists only because the repo compiles under NodeNext, so a `.ts` file importing a
 * sibling writes `./precedence.js`. See `tests/helpers/tsResolve.mjs`.
 *
 * Top-level `await` here is load-bearing: the dynamic imports must complete before the importing test
 * file's body runs, and a static re-export would be hoisted above `register()`.
 */

import { register } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(HERE, "..", "..");

register(pathToFileURL(resolvePath(REPO, "tests", "helpers", "tsResolve.mjs")).href);

const src = (rel) => pathToFileURL(resolvePath(REPO, "src", "box", "operatorConfig", rel)).href;

export const precedence = await import(src("precedence.ts"));
export const validate = await import(src("validate.ts"));
export const policy = await import(src("policy.ts"));
export const registry = await import(src("registry.ts"));
export const snapshot = await import(src("snapshot.ts"));

/** Absolute path to a file in the repo, for source-text assertions. */
export function repoPath(...parts) {
  return resolvePath(REPO, ...parts);
}

/**
 * A baseline system state: paper, disarmed, flat, clean, full admin.
 *
 * Tests override only the field under test, so a new field added to `SystemState` cannot silently
 * change the meaning of an existing assertion.
 */
export function baseState(overrides = {}) {
  return {
    executionMode: "paper_latency",
    entryArmed: false,
    sessionArmed: false,
    openBoxes: 0,
    residualLegs: 0,
    workingOrders: 0,
    inFlightExecutions: 0,
    reconciliationClean: true,
    operatorRole: "full",
    ...overrides,
  };
}

/** Look up a spec by key, failing loudly if the registry no longer has it. */
export function spec(key) {
  const found = registry.SETTINGS_BY_KEY.get(key);
  if (found === undefined) throw new Error(`test refers to unregistered setting "${key}"`);
  return found;
}
