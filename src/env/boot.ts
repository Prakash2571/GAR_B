/**
 * SIDE-EFFECTING ENVIRONMENT BOOTSTRAP — import this FIRST, before anything else.
 *
 * WHY IT MUST BE A BARE SIDE-EFFECTING IMPORT AND NOT A FUNCTION CALL
 *
 * Some modules resolve environment variables while they are being EVALUATED, not when they are called.
 * `src/kite.ts` computes its HTTP timeout in a module-level IIFE; `src/box/localCharges.ts` and
 * `src/brokers/dhan/http.ts` do similar work at import time. ES module evaluation order means every
 * import of a module runs before the importing module's own first statement — so a
 * `loadEnvironment()` call placed at the top of `index.ts`'s body would run AFTER those IIFEs had
 * already read an unpopulated environment.
 *
 * A bare `import "./env/boot.js"` placed first in the import list is therefore not a style choice, it
 * is the only construction that works. This replaces the previous `import "dotenv/config"`, which was
 * correct for the same reason and is why it sat in that exact position.
 *
 * IDEMPOTENT. Re-importing is a no-op (ES modules evaluate once), and the guard makes a direct second
 * call harmless too, so a script that imports both this and a module that imports it cannot double-apply.
 *
 * THIS MODULE NEVER THROWS. Loading and VALIDATING are separate steps on purpose: if a missing
 * credential threw from an import, the failure would surface before `index.ts` had installed its
 * fatal-error reporting, and the operator would get a bare stack trace instead of the full list of
 * problems. `index.ts` calls `assertEnvironmentValid()` explicitly, after `loadAppConfig`, so every
 * configuration failure is reported through one path in one format.
 */

import { loadEnvironment, type EnvLoadReport } from "./load.js";

let report: EnvLoadReport | null = null;

/** Apply the environment files to `process.env`, exactly once per process. */
export function bootstrapEnvironment(): EnvLoadReport {
  if (report === null) report = loadEnvironment();
  return report;
}

/**
 * The report from the load that has already happened.
 *
 * Never triggers a load: a caller asking "what was loaded?" must not be the thing that causes loading,
 * because that would make the answer depend on import order.
 */
export function environmentLoadReport(): EnvLoadReport | null {
  return report;
}

bootstrapEnvironment();
