/**
 * THE CONTRACT DIGEST THE RUNNING PROCESS PUBLISHES.
 *
 * `start.sh` has always tried to compare the RUNNING backend's contract digest against the digest the
 * frontend vendored, by reading `.contract?.schemas_sha256` from `/api/box/status`. Nothing ever
 * published a `contract` field: `schemas_sha256` appeared nowhere in `src/`, and `box-status.schema.json`
 * is `additionalProperties: false` so it could not have been added there without failing this very
 * suite. The read always produced the empty string, and a `[[ -n "$served" ]]` guard then silently
 * skipped the comparison.
 *
 * That matters most in `--frontend-only`, whose own comment calls that read "the check that makes
 * --frontend-only safe". It never ran — in the one mode that deliberately does not restart the
 * backend, and therefore the only mode where the live process can be older than the frontend being
 * published.
 *
 * These tests pin the replacement: an identity read that is correct, fail-safe, and agrees with
 * contract/version.json — the file the digest gate and the frontend pin both already use.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import {
  readContractIdentity,
  resetContractIdentityCache,
} from "../../dist/runtime/contractIdentity.js";

// Same derivation as every other test in this directory, so the suite has one way of finding the root.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

test("the published identity matches contract/version.json exactly", () => {
  resetContractIdentityCache();
  const onDisk = JSON.parse(readFileSync(join(ROOT, "contract", "version.json"), "utf8"));
  const identity = readContractIdentity();
  assert.equal(identity.version, onDisk.contract_version);
  assert.equal(identity.schemas_sha256, onDisk.schemas_sha256);
  // Guards the whole point: a null here would be published as "unverifiable" and the deployment gate
  // would skip, which is the silent-skip this replaces.
  assert.match(identity.schemas_sha256, /^[0-9a-f]{64}$/, "a real sha256 must be published");
  assert.match(identity.version, /^\d+\.\d+\.\d+$/);
});

test("the path is resolved from the MODULE, not the working directory", () => {
  // pm2 and systemd both start the process from a directory that is not the repository root. A
  // cwd-relative path would work in development and silently publish nulls in production — exactly
  // the failure this module exists to remove, so it is asserted rather than assumed.
  resetContractIdentityCache();
  const previous = process.cwd();
  try {
    process.chdir(tmpdir());
    const identity = readContractIdentity();
    assert.notEqual(identity.schemas_sha256, null, "must still resolve from an unrelated cwd");
  } finally {
    process.chdir(previous);
  }
});

test("UNKNOWN, never a false match, when the file cannot be read", () => {
  const missing = join(tmpdir(), "gts-contract-does-not-exist", "version.json");
  const identity = readContractIdentity(missing);
  assert.equal(identity.version, null);
  assert.equal(identity.schemas_sha256, null);
});

test("malformed JSON yields UNKNOWN rather than throwing into a health probe", () => {
  const dir = mkdtempSync(join(tmpdir(), "gts-contract-"));
  try {
    const bad = join(dir, "version.json");
    writeFileSync(bad, "{ this is not json");
    const identity = readContractIdentity(bad);
    assert.equal(identity.schemas_sha256, null);
    assert.equal(identity.version, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a half-valid file publishes the usable half and nulls the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "gts-contract-"));
  try {
    const partial = join(dir, "version.json");
    // Discarding both would hide a digest that is perfectly usable for the comparison.
    writeFileSync(partial, JSON.stringify({ contract_version: 42, schemas_sha256: "abc" }));
    const identity = readContractIdentity(partial);
    assert.equal(identity.version, null, "a non-string version is not a version");
    assert.equal(identity.schemas_sha256, "abc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/health in src/index.ts publishes the identity, and box-status still does NOT", () => {
  const index = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
  const health = index.slice(index.indexOf('app.get("/api/health"'));
  assert.match(
    health.slice(0, health.indexOf("});")),
    /contract:\s*readContractIdentity\(\)/,
    "the unauthenticated health endpoint is what a deployment can read without the access gate",
  );
  // And the shape that could NOT carry it must stay closed, so nobody re-adds it there.
  const schema = JSON.parse(
    readFileSync(join(ROOT, "contract", "schemas", "box-status.schema.json"), "utf8"),
  );
  assert.equal(schema.additionalProperties, false);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(schema.properties, "contract"),
    "box-status is closed; the digest belongs on the unauthenticated health route",
  );
});
