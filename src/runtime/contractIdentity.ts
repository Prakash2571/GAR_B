/**
 * WHICH WIRE CONTRACT THIS PROCESS SPEAKS — published so a deployment can verify it.
 *
 * WHY THIS EXISTS. `start.sh` has, since it was written, tried to compare the RUNNING backend's
 * contract digest against the digest the frontend vendored:
 *
 *     curl .../api/box/status | node -pe '….contract?.schemas_sha256 ?? ""'
 *
 * Nothing ever published a `contract` field. `schemas_sha256` did not appear anywhere in `src/`, and
 * `box-status.schema.json` is `additionalProperties: false`, so it could not have been added there
 * without failing the contract suite. That read therefore ALWAYS evaluated to the empty string, and
 * because the comparison was guarded by `[[ -n "$served" ]]`, it always silently skipped.
 *
 * The consequence that matters is in `--frontend-only`, a mode whose own comment calls that read
 * "the check that makes --frontend-only safe". It never ran. That mode deliberately does NOT restart
 * the backend, so it is exactly the case where the live process can be older than the frontend being
 * published — the one situation the check existed to catch, and the check was inert.
 *
 * WHY /api/health IS THE RIGHT HOME, given that endpoint's "NOTHING else" rule.
 *
 * `/api/health` deliberately carries only `service`, `state`, `ready` and `shutting_down`, because a
 * health check that reported broker, token, position, exposure or migration state would be a public
 * readout of a trading system. A contract digest is categorically not that: it is a hash over
 * JSON-Schema files that describe response SHAPES, it says nothing about an account, a position or a
 * credential, and the same value is already vendored into the frontend that any authorised operator
 * loads. What it buys is the ability to verify a deployment WITHOUT the access gate — which is
 * precisely why the previous attempt, pointed at an authenticated route, could not work even once the
 * field existed.
 *
 * FAIL-SAFE, NEVER FATAL. A health endpoint must not be able to fail because a JSON file moved. Every
 * error resolves to nulls, and the caller then reports "unverified" rather than crashing or, worse,
 * claiming a match it did not make.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The contract this build speaks. Nulls mean UNKNOWN — never "matches". */
export interface ContractIdentity {
  /** Semver from contract/version.json, or null when it could not be read. */
  readonly version: string | null;
  /** The digest the frontend pins, or null when it could not be read. */
  readonly schemas_sha256: string | null;
}

/**
 * Where `contract/version.json` sits relative to this module.
 *
 * Resolved from the module's own URL rather than `process.cwd()`, because pm2 and systemd both start
 * the process from directories that are not the repository root, and a cwd-relative path would work in
 * development and silently return nulls in production — the failure mode this whole module exists to
 * remove. `dist/runtime/` and `src/runtime/` are the same depth, so one expression serves the compiled
 * build and a direct `--experimental-strip-types` run alike.
 */
const VERSION_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "contract",
  "version.json",
);

const UNKNOWN: ContractIdentity = { version: null, schemas_sha256: null };

/** Read once. The file cannot change without a redeploy, and a health probe must stay cheap. */
let cached: ContractIdentity | null = null;

/**
 * The contract identity of this build.
 *
 * @param versionFile overridable for tests only; production always uses the resolved path.
 */
export function readContractIdentity(versionFile: string = VERSION_FILE): ContractIdentity {
  if (versionFile === VERSION_FILE && cached !== null) return cached;
  let identity: ContractIdentity;
  try {
    const parsed: unknown = JSON.parse(readFileSync(versionFile, "utf8"));
    if (parsed === null || typeof parsed !== "object") {
      identity = UNKNOWN;
    } else {
      const record = parsed as Record<string, unknown>;
      // Each field is validated independently: a file carrying one usable value and one malformed one
      // should publish the good half rather than discarding both.
      identity = {
        version: typeof record["contract_version"] === "string" ? record["contract_version"] : null,
        schemas_sha256:
          typeof record["schemas_sha256"] === "string" ? record["schemas_sha256"] : null,
      };
    }
  } catch {
    // Missing, unreadable or malformed. Unknown is the honest answer and the safe one.
    identity = UNKNOWN;
  }
  if (versionFile === VERSION_FILE) cached = identity;
  return identity;
}

/** Test seam: drop the memoised value so a fixture path can be exercised. */
export function resetContractIdentityCache(): void {
  cached = null;
}
