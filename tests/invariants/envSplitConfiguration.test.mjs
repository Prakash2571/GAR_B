/**
 * SPLIT ENVIRONMENT CONFIGURATION — the safety properties of secrets-vs-config separation.
 *
 * WHAT THESE TESTS ARE FOR
 *
 * The configuration layer decides two things that can lose real money or leak real credentials:
 * whether live order placement is enabled, and whether a secret can reach a log. Both fail silently
 * when they fail — a gate that resolved a typo to `true` looks identical to one an operator armed, and
 * a leaked key looks like a successful boot. So each property is asserted directly rather than being
 * left to reading the code.
 *
 * THE ASYMMETRY THAT SHAPES THE WHOLE DESIGN, RESTATED HERE BECAUSE IT IS WHAT MOST OF THESE PIN:
 *
 *   Redaction guesses FAIL-CLOSED. An unregistered name that merely looks like a credential is treated
 *   as one, because being wrong costs a hidden diagnostic line, while being wrong the other way prints
 *   an API key.
 *
 *   Requiredness NEVER guesses. It is explicit, because refusing to boot over a variable we merely
 *   suspected existed is its own outage — and "the process will not start and cannot tell you which
 *   real setting is wrong" is worse than the gap it was trying to close.
 *
 * Plain ESM against the COMPILED output in dist/, matching every other suite here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DIST = resolve(ROOT, "dist");

const { applyEnvLayer, hasUsableValue } = await import(`${DIST}/env/layer.js`);
const {
  classifyEnvVar,
  describeEnvValue,
  isSecretEnvVar,
  maskIdentity,
  redactEnvValue,
  registeredSecretNames,
  summariseDsn,
} = await import(`${DIST}/env/secrets.js`);
const { validateEnvironment, assertEnvironmentValid, parseGateBool, EnvValidationError } =
  await import(`${DIST}/env/validate.js`);
const { renderEnvDiagnostics } = await import(`${DIST}/env/diagnostics.js`);

/** An obviously-fake but structurally valid 32-byte key, so live validation can pass. */
const FAKE_KEY_32 = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

/** A minimal environment that satisfies live validation, for use as a baseline to break. */
function liveEnv(over = {}) {
  return {
    BOX_EXECUTION_MODE: "live",
    BOX_LIVE_TRADING_ENABLED: "true",
    ZERODHA_LIVE_TRADING_ENABLED: "true",
    DEFAULT_ACTIVE_BROKER: "zerodha",
    BROKER_LOGIN_MODE: "in_app",
    SITE_ACCESS_SECRET: "fake-passcode-not-real",
    DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
    BROKER_TOKEN_ENCRYPTION_KEY: FAKE_KEY_32,
    KITE_API_KEY: "fake-kite-key",
    KITE_API_SECRET: "fake-kite-secret",
    ...over,
  };
}

/* ══════════════════ 1-3. PRECEDENCE: process env > file > default ══════════════════ */

test("1. an explicit runtime value is NOT overwritten by a file layer", () => {
  const target = { BOX_MAX_OPEN_BOXES: "1" };
  const result = applyEnvLayer(target, { BOX_MAX_OPEN_BOXES: "9", BOX_STRIKE_LEVEL: "3" });
  assert.equal(target.BOX_MAX_OPEN_BOXES, "1", "the runtime value must win");
  assert.deepEqual(result.skipped, ["BOX_MAX_OPEN_BOXES"], "and the skip must be reported by name");
  assert.deepEqual(result.applied, ["BOX_STRIKE_LEVEL"]);
});

test("2. a file value IS used when nothing is set at runtime", () => {
  const target = {};
  applyEnvLayer(target, { BOX_MAX_OPEN_BOXES: "1" });
  assert.equal(target.BOX_MAX_OPEN_BOXES, "1");
});

test("2b. the FIRST layer applied wins, which is what makes the secrets file beat .env", () => {
  // The loader applies the protected secrets file before .env for exactly this reason: if the same
  // credential is in both, the one under rotation control must win over a stale paste.
  const target = {};
  applyEnvLayer(target, { KITE_API_SECRET: "from-secrets-file" });
  applyEnvLayer(target, { KITE_API_SECRET: "from-dotenv" });
  assert.equal(target.KITE_API_SECRET, "from-secrets-file");
});

test("3. BLANK is not a value — an injected empty variable does not mask a real file value", () => {
  // Process managers and CI runners routinely inject `FOO=` for something they have no value for.
  // Letting that blank win would produce a missing credential with no visible cause.
  const target = { KITE_API_SECRET: "", DHAN_API_SECRET: "   " };
  applyEnvLayer(target, { KITE_API_SECRET: "real", DHAN_API_SECRET: "real2" });
  assert.equal(target.KITE_API_SECRET, "real");
  assert.equal(target.DHAN_API_SECRET, "real2");
  assert.equal(hasUsableValue({ X: "" }, "X"), false);
  assert.equal(hasUsableValue({ X: " " }, "X"), false);
  assert.equal(hasUsableValue({}, "X"), false);
  assert.equal(hasUsableValue({ X: "v" }, "X"), true);
});

test("3b. a layer never invents a variable that was not in the file", () => {
  const target = {};
  applyEnvLayer(target, {});
  assert.deepEqual(Object.keys(target), []);
});

/* ══════════════════ 4-5. MODE-AWARE SECRET REQUIREMENTS ══════════════════ */

test("4. a missing required LIVE secret fails validation, naming the variable", () => {
  const report = validateEnvironment(liveEnv({ KITE_API_SECRET: undefined }));
  assert.equal(report.liveEnabled, true);
  const problem = report.problems.find((p) => p.includes("KITE_API_SECRET"));
  assert.ok(problem, `expected a problem naming KITE_API_SECRET; got ${JSON.stringify(report.problems)}`);
  assert.match(problem, /^Missing required environment variable: KITE_API_SECRET/);
});

test("4b. assertEnvironmentValid THROWS for live with missing credentials, and collects every problem", () => {
  // One pass, whole list: an operator fixing credentials before the open must not discover the second
  // missing key only after fixing the first and restarting.
  let thrown = null;
  try {
    assertEnvironmentValid(
      liveEnv({ KITE_API_KEY: undefined, KITE_API_SECRET: undefined, DATABASE_URL: undefined }),
    );
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof EnvValidationError, "must throw EnvValidationError");
  assert.ok(thrown.problems.length >= 3, `expected >=3 problems, got ${thrown.problems.length}`);
  for (const name of ["KITE_API_KEY", "KITE_API_SECRET", "DATABASE_URL"]) {
    assert.ok(
      thrown.problems.some((p) => p.includes(name)),
      `${name} must be named`,
    );
  }
});

test("4c. a present-but-MALFORMED encryption key fails at boot, not at the first token write", () => {
  // This used to be decoded lazily on the first store — i.e. after a successful broker login, mid
  // session. Shape is therefore validated here, not just presence.
  const report = validateEnvironment(liveEnv({ BROKER_TOKEN_ENCRYPTION_KEY: "too-short" }));
  assert.ok(
    report.problems.some((p) => p.includes("BROKER_TOKEN_ENCRYPTION_KEY")),
    `expected a shape problem; got ${JSON.stringify(report.problems)}`,
  );
  // And the failure must not quote the key material.
  for (const p of report.problems) assert.ok(!p.includes("too-short"), "must not echo the value");
});

test("5. PAPER mode requires NO broker credential and validates clean", () => {
  const report = validateEnvironment({
    BOX_EXECUTION_MODE: "paper_legging",
    SITE_ACCESS_SECRET: "fake-passcode-not-real",
  });
  assert.equal(report.liveEnabled, false);
  assert.deepEqual(report.problems, [], "paper must not require credentials it does not use");
});

test("5b. paper mode WITHOUT a site passcode warns but does not refuse to boot", () => {
  // The gate fails closed without it (every protected route 401s), so a developer gets a safe,
  // diagnosable process rather than one that will not start.
  const report = validateEnvironment({ BOX_EXECUTION_MODE: "paper_latency" });
  assert.deepEqual(report.problems, []);
  assert.ok(
    report.warnings.some((w) => w.includes("SITE_ACCESS_SECRET")),
    "but it must be said loudly",
  );
});

test("5c. live mode WITHOUT a site passcode is fatal — an unsupervisable live process", () => {
  const report = validateEnvironment(liveEnv({ SITE_ACCESS_SECRET: undefined }));
  assert.ok(report.problems.some((p) => p.includes("SITE_ACCESS_SECRET")));
});

test("5d. a feature-scoped secret is required ONLY when its feature is on", () => {
  const off = validateEnvironment({ BOX_EXECUTION_MODE: "paper_latency", MONGO_EXPORT_ENABLED: "false" });
  assert.equal(off.problems.some((p) => p.includes("MONGODB_URI")), false);
  const on = validateEnvironment({ BOX_EXECUTION_MODE: "paper_latency", MONGO_EXPORT_ENABLED: "true" });
  assert.ok(on.problems.some((p) => p.includes("MONGODB_URI")));
});

test("5e. provider login mode requires the provider endpoint and passcode, not the app keys", () => {
  const report = validateEnvironment(
    liveEnv({
      BROKER_LOGIN_MODE: "provider",
      KITE_API_KEY: undefined,
      KITE_API_SECRET: undefined,
      KITE_TOKEN_BROKER_URL: undefined,
      KITE_TOKEN_BROKER_PASSCODE: undefined,
    }),
  );
  assert.ok(report.problems.some((p) => p.includes("KITE_TOKEN_BROKER_URL")));
  assert.ok(report.problems.some((p) => p.includes("KITE_TOKEN_BROKER_PASSCODE")));
  assert.equal(
    report.problems.some((p) => p.includes("KITE_API_SECRET")),
    false,
    "the in-app keys are not needed when the token comes from a provider",
  );
});

/* ══════════════════ 6, 8. THE LIVE GATE CANNOT FAIL OPEN ══════════════════ */

test("8. LIVE TRADING CANNOT DEFAULT TO ENABLED — absent, blank and malformed all resolve FALSE", () => {
  // The single most important assertion in this file. A gate that turned a typo into "enabled" would
  // place real orders a supervised test never authorised.
  for (const raw of [
    undefined,
    "",
    "   ",
    "ture",
    "TRUE!",
    "yes please",
    "1 ",
    "enabled",
    "y",
    "t",
    "on ",
    "2",
    "-1",
    "null",
    "undefined",
  ]) {
    const gate = parseGateBool(raw);
    if (raw !== undefined && ["1 ", "on "].includes(raw)) {
      // Trimmed, then recognised — these ARE true, deliberately.
      assert.equal(gate.value, true, `${JSON.stringify(raw)} trims to a recognised true`);
      continue;
    }
    assert.equal(gate.value, false, `${JSON.stringify(raw)} must NOT enable live trading`);
  }
});

test("8b. only the documented spellings enable a gate", () => {
  for (const raw of ["true", "TRUE", "True", "1", "yes", "YES", "on", "ON"]) {
    assert.equal(parseGateBool(raw).value, true, `${raw} should be true`);
  }
  for (const raw of ["false", "FALSE", "0", "no", "off"]) {
    assert.equal(parseGateBool(raw).value, false, `${raw} should be false`);
  }
});

test("6. a malformed boolean resolves SAFELY and is REPORTED, not silently swallowed", () => {
  // Fail-safe alone is not enough: an operator whose typo disabled trading would otherwise get a paper
  // session they believed was live.
  const gate = parseGateBool("ture");
  assert.equal(gate.value, false);
  assert.equal(gate.malformed, true);
  const report = validateEnvironment({
    BOX_EXECUTION_MODE: "paper_latency",
    SITE_ACCESS_SECRET: "x",
    BOX_LIVE_TRADING_ENABLED: "ture",
  });
  assert.ok(
    report.warnings.some((w) => w.includes("BOX_LIVE_TRADING_ENABLED") && /fail-safe/i.test(w)),
    `expected a malformed-boolean warning; got ${JSON.stringify(report.warnings)}`,
  );
  assert.equal(report.liveEnabled, false);
});

test("6b. an unrecognised EXECUTION MODE is refused rather than resolved to a default", () => {
  const report = validateEnvironment({ BOX_EXECUTION_MODE: "livee", SITE_ACCESS_SECRET: "x" });
  assert.ok(report.problems.some((p) => p.includes("BOX_EXECUTION_MODE")));
  assert.equal(report.liveEnabled, false, "and it certainly must not be live");
});

test("6c. mode=live with the kill switch off is a refusal, never a silent downgrade to paper", () => {
  const report = validateEnvironment({
    BOX_EXECUTION_MODE: "live",
    BOX_LIVE_TRADING_ENABLED: "false",
    SITE_ACCESS_SECRET: "x",
  });
  assert.equal(report.liveEnabled, false);
  assert.ok(report.problems.some((p) => p.includes("BOX_LIVE_TRADING_ENABLED")));
});

/* ══════════════════ 7. MALFORMED SAFETY-CRITICAL NUMBERS FAIL ══════════════════ */

test("7. a malformed safety-critical numeric limit REFUSES to boot rather than defaulting", async () => {
  // BOX_MAX_OPEN_BOXES is the global inventory ceiling. Its loader is `strictLimitInt` precisely
  // because `clampInt` once turned a typo into "unlimited" — the default for that knob being 0, which
  // means no cap. This asserts the strictness is still in place, through the real loader.
  const { loadBoxConfig } = await import(`${DIST}/box/config.js`);
  const saved = { ...process.env };
  try {
    process.env.BOX_EXECUTION_MODE = "paper_latency";
    for (const bad of ["one", "1.5", "-1", "abc"]) {
      process.env.BOX_MAX_OPEN_BOXES = bad;
      assert.throws(
        () => loadBoxConfig(),
        /BOX_MAX_OPEN_BOXES/,
        `BOX_MAX_OPEN_BOXES=${bad} must be refused, not defaulted to unlimited`,
      );
    }
    // And a valid value still loads.
    process.env.BOX_MAX_OPEN_BOXES = "1";
    const cfg = loadBoxConfig();
    assert.equal(cfg.maxOpenBoxes, 1);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

/* ══════════════════ 9-10. DIAGNOSTICS LEAK NOTHING, SHOW WHAT MATTERS ══════════════════ */

test("9. NO SECRET VALUE APPEARS IN THE DIAGNOSTIC — not the value, not a prefix, not a length", () => {
  const canaries = {
    SITE_ACCESS_SECRET: "CANARY-site-passcode-9f3a",
    BROKER_TOKEN_ENCRYPTION_KEY: FAKE_KEY_32,
    KITE_API_KEY: "CANARY-kite-key-771b",
    KITE_API_SECRET: "CANARY-kite-secret-22de",
    DHAN_API_KEY: "CANARY-dhan-key-55aa",
    DHAN_API_SECRET: "CANARY-dhan-secret-66bb",
    KITE_TOKEN_BROKER_PASSCODE: "CANARY-kite-passcode-88cc",
    DHAN_TOKEN_BROKER_PASSCODE: "CANARY-dhan-passcode-99dd",
    TOKEN_EXPOSURE_KEY: "CANARY-exposure-key-abcd",
    DATABASE_URL: "postgres://dbuser:CANARY-db-password@db.internal:5432/gts",
    MONGODB_URI: "mongodb://mguser:CANARY-mongo-password@mongo.internal:27017/gts",
  };
  const target = { ...liveEnv(), ...canaries };
  const validation = validateEnvironment(target);
  const text = renderEnvDiagnostics({ target, load: null, validation }).join("\n");

  for (const [name, value] of Object.entries(canaries)) {
    assert.ok(text.includes(name), `${name} should be reported by NAME`);
    assert.ok(!text.includes(value), `${name}'s VALUE must never appear in the diagnostic`);
  }
  // Nor any embedded password from a DSN, even though the DSN's host is legitimately shown.
  assert.ok(!text.includes("CANARY-db-password"), "the DSN password must be stripped");
  assert.ok(!text.includes("CANARY-mongo-password"));
  assert.ok(!text.includes("dbuser"), "the DSN user must be stripped too");
  // The host IS shown, because "which database am I pointed at?" is an operational question.
  assert.ok(text.includes("db.internal:5432/gts"), "the DSN target should be visible");
  // And presence is reported.
  assert.match(text, /SITE_ACCESS_SECRET\s+configured/);
});

test("9b. a MISSING secret reports `missing` and still leaks nothing", () => {
  const target = { BOX_EXECUTION_MODE: "paper_latency" };
  const text = renderEnvDiagnostics({
    target,
    load: null,
    validation: validateEnvironment(target),
  }).join("\n");
  assert.match(text, /SITE_ACCESS_SECRET\s+missing/);
  assert.match(text, /KITE_API_SECRET\s+missing/);
});

test("9c. describeEnvValue reveals only presence for a secret, and never its length", () => {
  const short = describeEnvValue("KITE_API_SECRET", "a");
  const long = describeEnvValue("KITE_API_SECRET", "a".repeat(500));
  assert.equal(short, "configured");
  assert.equal(long, "configured", "a 1-char and a 500-char secret must be indistinguishable");
  assert.equal(describeEnvValue("KITE_API_SECRET", undefined), "missing");
  assert.equal(describeEnvValue("KITE_API_SECRET", "   "), "missing");
});

test("9d. an IDENTITY is masked to its last 4, not hidden and not exposed", () => {
  // Deliberately different from a secret: an operator must be able to confirm WHICH account is
  // connected without the value being quotable.
  // Up to 8 bullets, so a 10-char id shows 6 of them: the mask never reveals the original length by
  // padding to it. Matches `redactIdentity` in src/runtime/projections.ts.
  assert.equal(describeEnvValue("DHAN_CLIENT_ID", "1100998877"), "••••••8877");
  assert.equal(describeEnvValue("DHAN_CLIENT_ID", "A".repeat(60)), `${"•".repeat(8)}AAAA`);
  assert.equal(maskIdentity("abcd"), "••••", "a value of <=4 chars is masked entirely");
  assert.equal(maskIdentity(""), "");
});

test("9e. redactEnvValue returns a fixed placeholder for a secret — nothing derived from the input", () => {
  assert.equal(redactEnvValue("KITE_API_SECRET", "anything-at-all"), "[redacted]");
  assert.equal(redactEnvValue("KITE_API_SECRET", "x"), "[redacted]");
  assert.equal(redactEnvValue("BOX_MAX_OPEN_BOXES", "1"), "1", "config passes through");
});

test("10. NON-SECRET BOX configuration remains fully visible", () => {
  const target = {
    ...liveEnv(),
    BOX_MAX_OPEN_BOXES: "1",
    BOX_MAX_UNDERLYINGS: "0",
    BOX_STRIKE_LEVEL: "1",
    BOX_LIVE_MAX_OPEN_LEG_QUANTITY: "75",
    BOX_FEED_MAX_AGE_MS: "5000",
  };
  const text = renderEnvDiagnostics({
    target,
    load: null,
    validation: validateEnvironment(target),
  }).join("\n");
  // The real values, because hiding them would remove the one check that catches an unapplied .env.
  assert.match(text, /BOX_MAX_OPEN_BOXES\s+1\b/);
  assert.match(text, /BOX_MAX_UNDERLYINGS\s+0\b/);
  assert.match(text, /BOX_LIVE_MAX_OPEN_LEG_QUANTITY\s+75\b/);
  assert.match(text, /BOX_FEED_MAX_AGE_MS\s+5000\b/);
  assert.match(text, /live trading ENABLED/);
});

test("10b. an unset config knob says so rather than showing a blank", () => {
  const target = { BOX_EXECUTION_MODE: "paper_latency", SITE_ACCESS_SECRET: "x" };
  const text = renderEnvDiagnostics({
    target,
    load: null,
    validation: validateEnvironment(target),
  }).join("\n");
  assert.match(text, /BOX_MAX_OPEN_BOXES\s+\(unset — code default applies\)/);
});

/* ══════════════════ CLASSIFICATION: fail-closed for unknown names ══════════════════ */

test("classification is FAIL-CLOSED: an unregistered credential-shaped name is treated as secret", () => {
  // A variable added next year must be redacted from the moment it exists, without anyone remembering
  // to register it.
  for (const name of [
    "NEW_BROKER_API_SECRET",
    "SOME_SERVICE_PASSCODE",
    "WEBHOOK_SIGNING_KEY",
    "ANOTHER_DB_URI",
    "VENDOR_PASSWORD",
  ]) {
    assert.equal(classifyEnvVar(name), "secret", `${name} must default to secret`);
    assert.equal(isSecretEnvVar(name), true);
    // The value itself must never survive. A DSN-shaped name may additionally report its host, so the
    // assertion is "the value is gone", not a literal string match.
    const described = describeEnvValue(name, "SENTINEL-unregistered-value");
    assert.ok(described.startsWith("configured"), `${name} -> ${described}`);
    assert.equal(described.includes("SENTINEL"), false, `${name} leaked its value`);
  }
  // A name that cannot be parsed as a DSN reports bare `configured`, with no confusing nested note.
  assert.equal(describeEnvValue("ANOTHER_DB_URI", "not-a-url"), "configured");
  assert.equal(
    describeEnvValue("ANOTHER_DB_URI", "postgres://u:p@h:5432/d"),
    "configured (h:5432/d)",
    "but a real DSN still names its target",
  );
});

test("classification does NOT over-reach: real config with credential-ish words stays visible", () => {
  // Each of these exists in this repo and is plainly not a credential. A substring rule would have
  // swallowed all four.
  for (const name of [
    "BOX_MAX_SUBSCRIBED_TOKENS",
    "BROKER_TOKEN_POLL_INTERVAL_MS",
    "BROKER_TOKEN_REQUEST_TIMEOUT_MS",
    "BROKER_TOKEN_POLL_START",
    "DHAN_AUTH_SECRET_HEADER",
    "KITE_TOKEN_BROKER_URL",
    "DHAN_TOKEN_URL",
    "KITE_REDIRECT_URL",
    "FRONTEND_URL",
  ]) {
    assert.equal(classifyEnvVar(name), "config", `${name} must stay visible`);
    assert.equal(describeEnvValue(name, "shown"), "shown");
  }
});

test("every registered secret is genuinely redacted, with no accidental gaps", () => {
  const names = registeredSecretNames();
  assert.ok(names.length >= 12, `expected the full secret set, got ${names.length}`);
  for (const name of names) {
    assert.equal(describeEnvValue(name, "SENTINEL-VALUE").includes("SENTINEL-VALUE"), false, name);
    assert.equal(redactEnvValue(name, "SENTINEL-VALUE"), "[redacted]", name);
  }
});

test("summariseDsn keeps the target and drops the credentials, and never echoes an unparseable string", () => {
  assert.equal(summariseDsn("postgres://u:p@h.example:5432/db"), "h.example:5432/db");
  assert.equal(summariseDsn("mongodb://u:p@m.example:27017/x"), "m.example:27017/x");
  // An unparseable DSN is exactly the string we must not print: we cannot know which part is secret.
  assert.equal(summariseDsn("this is not a url with a p@ssword in it"), "(configured)");
  assert.equal(summariseDsn(""), "");
});

/* ══════════════════ 11-12. THE DEPLOYMENT SURFACE ══════════════════ */

test("12. the committed PM2 ecosystem file contains no credential assignment", () => {
  const raw = readFileSync(resolve(ROOT, "ecosystem.config.cjs"), "utf8");
  // Comments are stripped: the file's own prose has to be able to NAME these variables in order to
  // explain why they must not be assigned there.
  const code = raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  for (const name of registeredSecretNames()) {
    const assigned = new RegExp(`${name}\\s*:\\s*["'][^"']`);
    assert.equal(assigned.test(code), false, `${name} must not be assigned in ecosystem.config.cjs`);
  }
  // And the env block must still exist with NODE_ENV, so this test cannot pass by the file being empty.
  assert.match(code, /NODE_ENV:\s*"production"/);
});

test("12b. the PM2 env block exposes only non-secret names", async () => {
  const { default: eco } = await import(`${ROOT}/ecosystem.config.cjs`);
  const env = eco.apps[0].env ?? {};
  for (const [name, value] of Object.entries(env)) {
    assert.equal(
      isSecretEnvVar(name),
      false,
      `PM2 env must not carry the secret ${name} — 'pm2 save' would copy it into ~/.pm2/dump.pm2`,
    );
    assert.equal(typeof value, "string");
  }
});

test("11. no deployment script overwrites, truncates or deletes the server .env", () => {
  // The server .env holds risk limits and the execution mode — state an operator tuned for a live
  // system. A deploy that recreated it from a template would silently reset all of it.
  const files = ["start.sh", ".github/workflows/ci.yml", ".github/workflows/sync-secrets.yml"];
  for (const rel of files) {
    const raw = readFileSync(resolve(ROOT, rel), "utf8");
    const code = raw
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.equal(
      /(cp|mv|install)[^|;&\n]*\.env\.example[^|;&\n]*\.env([^.]|$)/m.test(code),
      false,
      `${rel} must not copy .env.example over .env`,
    );
    assert.equal(
      /rm\s+(-[a-zA-Z]+\s+)*[^|;&\n]*(^|\/|\s)\.env(\s|$)/m.test(code),
      false,
      `${rel} must not delete a .env`,
    );
    assert.equal(
      />\s*"?[^"\n]*\/?\.env"?(\s|$)/m.test(code),
      false,
      `${rel} must not redirect output over a .env`,
    );
  }
});

test("11b. .gitignore excludes .env and the secrets file pattern, but keeps .env.example", () => {
  const ignore = readFileSync(resolve(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /^\.env$/m, ".env must be ignored");
  assert.match(ignore, /^!\.env\.example$/m, ".env.example must stay tracked");
});

test("11c. the secrets file default lives OUTSIDE the repository", async () => {
  // A path inside the working tree is one `git add -A` from being committed, and would be destroyed by
  // a deploy that re-clones.
  const { DEFAULT_SECRETS_FILE } = await import(`${DIST}/env/load.js`);
  assert.ok(DEFAULT_SECRETS_FILE.startsWith("/"), "must be an absolute path, not relative to cwd");
  assert.ok(
    !DEFAULT_SECRETS_FILE.startsWith(ROOT),
    "must not be inside the repository: a path in the working tree is one `git add -A` from being " +
      "committed, and would be destroyed by a deploy that re-clones",
  );
});

/* ══════════════════ THE LOADER: refuses an over-permissive secrets file ══════════════════ */

test("the loader REFUSES a group/world-readable secrets file and loads nothing from it", async () => {
  const { loadEnvironment } = await import(`${DIST}/env/load.js`);
  const target = {};
  const report = loadEnvironment({
    target,
    secretsFilePath: "/fake/secrets.env",
    envFilePath: "/fake/.env",
    statMode: (p) => (p === "/fake/secrets.env" ? 0o100644 : null),
    readFile: () => "KITE_API_SECRET=should-never-be-loaded",
    parse: (t) => Object.fromEntries(t.split("\n").filter(Boolean).map((l) => l.split("=", 2))),
    enforceSecretsFileMode: true,
  });
  assert.equal(report.secretsFile.present, true);
  assert.equal(report.secretsFile.read, false, "an over-permissive file must not be read");
  assert.equal(target.KITE_API_SECRET, undefined, "and nothing from it may reach the environment");
  assert.match(report.problems[0], /readable beyond its owner/);
  assert.match(report.problems[0], /chmod 600/);
  assert.equal(report.problems[0].includes("should-never-be-loaded"), false, "no value in the problem");
});

test("the loader accepts 0600 and 0400, and reports a credential sitting in .env", async () => {
  const { loadEnvironment } = await import(`${DIST}/env/load.js`);
  for (const mode of [0o100600, 0o100400]) {
    const target = {};
    const report = loadEnvironment({
      target,
      secretsFilePath: "/fake/secrets.env",
      envFilePath: "/fake/.env",
      statMode: (p) => (p === "/fake/secrets.env" ? mode : 0o100644),
      readFile: (p) =>
        p === "/fake/secrets.env" ? "KITE_API_SECRET=from-file" : "SITE_ACCESS_SECRET=in-dotenv\nBOX_STRIKE_LEVEL=1",
      parse: (t) => Object.fromEntries(t.split("\n").filter(Boolean).map((l) => l.split("=", 2))),
      enforceSecretsFileMode: true,
    });
    assert.equal(report.secretsFile.read, true, `mode 0${mode.toString(8)} must be accepted`);
    assert.equal(target.KITE_API_SECRET, "from-file");
    assert.equal(target.BOX_STRIKE_LEVEL, "1", "the .env still supplies operational config");
    // A credential in .env works but is called out every start, by name only.
    assert.deepEqual(report.secretsFoundInEnvFile, ["SITE_ACCESS_SECRET"]);
    const note = report.problems.find((p) => p.includes("SITE_ACCESS_SECRET"));
    assert.ok(note, "a credential in .env must be reported");
    assert.equal(note.includes("in-dotenv"), false, "but never its value");
  }
});

test("an absent secrets file is NOT an error — a paper dev machine has none", async () => {
  const { loadEnvironment } = await import(`${DIST}/env/load.js`);
  const target = {};
  const report = loadEnvironment({
    target,
    secretsFilePath: "/fake/secrets.env",
    envFilePath: "/fake/.env",
    statMode: () => null,
    readFile: () => "",
    parse: () => ({}),
  });
  assert.equal(report.secretsFile.present, false);
  assert.deepEqual(report.problems, []);
});

test("a parse failure names the FILE and the error class, never a line of its contents", async () => {
  const { loadEnvironment } = await import(`${DIST}/env/load.js`);
  const report = loadEnvironment({
    target: {},
    secretsFilePath: "/fake/secrets.env",
    envFilePath: "/fake/.env",
    statMode: (p) => (p === "/fake/secrets.env" ? 0o100600 : null),
    readFile: () => "KITE_API_SECRET=secret-material-here",
    parse: () => {
      throw new SyntaxError("unexpected token in KITE_API_SECRET=secret-material-here");
    },
  });
  assert.equal(report.secretsFile.read, false);
  assert.match(report.problems[0], /could not be parsed \(SyntaxError\)/);
  assert.equal(
    report.problems[0].includes("secret-material-here"),
    false,
    "a parser message can quote the offending LINE, which for a secrets file is a value",
  );
});
