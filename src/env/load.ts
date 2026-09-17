/**
 * THE ONE ENVIRONMENT-LOADING PATH.
 *
 * Two files, one order, no overriding:
 *
 *     explicit process environment  >  protected secrets file  >  server .env  >  code default
 *
 * WHY TWO FILES INSTEAD OF ONE
 *
 * The two halves of this configuration have completely different lifecycles and completely different
 * blast radii, and a single `.env` forced them to share both.
 *
 *   The server `.env` is OPERATIONAL: risk limits, feed freshness, execution mode, strike level. An
 *   operator edits it between sessions, it is worth reading in full in a diagnostic, and it must
 *   survive a deployment untouched — losing it means losing the tuning of a live trading system.
 *
 *   The secrets file is CREDENTIAL material: broker keys, the token-encryption key, the site
 *   passcode, database DSNs. It is written once per rotation, must never be printed, and must be
 *   readable only by the account that runs the process.
 *
 * Keeping them apart means a deployment can replace credentials without touching risk configuration,
 * and an operator can edit risk configuration without ever opening a file that contains a broker
 * secret. It also makes the file permissions honest: `.env` can be group-readable for debugging while
 * the secrets file is 0600.
 *
 * WHY THE SECRETS FILE IS A FILE AND NOT PM2's `env` BLOCK
 *
 * PM2's `env` block would be the obvious place, and it is the wrong one. `pm2 save` serialises the
 * running process's environment into `~/.pm2/dump.pm2` so it can be resurrected after a reboot — which
 * means every secret would be written, in clear text, into a second file whose permissions nobody
 * audits, and would then be restored by `pm2 resurrect` from that copy rather than from the
 * authoritative one. Rotating a key would leave the old value live in the dump. A file read by the
 * process at startup has none of those properties: there is exactly one copy, `pm2 restart` re-reads
 * it, and a reboot re-reads it too.
 *
 * IDEMPOTENT AND SIDE-EFFECT-FREE BY DEFAULT. `loadEnvironment` takes its target and its paths, so a
 * test can drive it against a scratch object. `./boot.ts` is the module that applies it to the real
 * `process.env`, exactly once.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as dotenvParse } from "dotenv";

import { applyEnvLayer, hasUsableValue, type EnvRecord, type EnvTarget } from "./layer.js";
import { classifyEnvVar } from "./secrets.js";

/**
 * Where the protected secrets file lives by default.
 *
 * Outside the repository on purpose: a path under the working tree is one `git add -A` away from being
 * committed, and it would be destroyed by a deployment that re-clones. `/etc/gts/` is root-owned,
 * survives every deploy and reboot, and is where an auditor expects to find machine credentials.
 *
 * Overridable with `GTS_SECRETS_FILE` for containers and for tests. That variable is itself read from
 * the real process environment only — it cannot be set from inside either file, because the file that
 * would set it has not been read yet.
 */
export const DEFAULT_SECRETS_FILE = "/etc/gts/secrets.env";

/** Where the operational configuration lives, relative to the process working directory. */
export const DEFAULT_ENV_FILE = ".env";

/** One file's contribution to the environment, described without values. */
export interface EnvFileOutcome {
  readonly path: string;
  /** Whether the file exists at all. Absent is normal for the secrets file on a dev machine. */
  readonly present: boolean;
  /** Whether we actually read it. False with `present: true` means it was refused — see `problem`. */
  readonly read: boolean;
  /** Names this file supplied. */
  readonly applied: string[];
  /** Names it defined but which a higher-precedence source had already set. */
  readonly overriddenByHigherPrecedence: string[];
  /** Why the file was refused or could not be parsed. Never contains a value. */
  readonly problem: string | null;
}

/** The whole load, reported by name only. Safe to log verbatim. */
export interface EnvLoadReport {
  readonly secretsFile: EnvFileOutcome;
  readonly envFile: EnvFileOutcome;
  /**
   * SECRET-classified names found in the server `.env`.
   *
   * Not fatal — a single-machine deployment that keeps everything in `.env` still works, and refusing
   * to boot over file layout would be a poor trade. But it is reported loudly every start, because a
   * credential in `.env` is a credential in the file people open, paste from and copy to a laptop for
   * debugging.
   */
  readonly secretsFoundInEnvFile: string[];
  /** Problems worth surfacing at boot. Names only, never values. */
  readonly problems: string[];
}

/** Injectable so tests need neither a real filesystem nor an installed dotenv. */
export interface EnvLoadOptions {
  readonly target?: EnvTarget;
  readonly secretsFilePath?: string;
  readonly envFilePath?: string;
  /** Parse an env file's text into a record. Defaults to dotenv's parser. */
  readonly parse?: (text: string) => EnvRecord;
  /** Read a file as UTF-8, or throw ENOENT. Defaults to `readFileSync`. */
  readonly readFile?: (path: string) => string;
  /** Return the file mode bits, or null when the file does not exist. */
  readonly statMode?: (path: string) => number | null;
  /**
   * Enforce that the secrets file is not group/world readable.
   *
   * Defaults to true, and to false on Windows where POSIX mode bits are not meaningful.
   */
  readonly enforceSecretsFileMode?: boolean;
}

/**
 * dotenv's parser — borrowed deliberately, and ONLY the parser.
 *
 * `dotenv.parse` is a pure string→record function: it touches no global, reads no file and mutates no
 * `process.env`. That makes it the one part of dotenv safe to depend on here, since the precedence
 * rule stays in `./layer.ts` where it can be tested and cannot be changed by a package upgrade.
 */
function defaultParse(text: string): EnvRecord {
  return dotenvParse(text);
}

function defaultStatMode(path: string): number | null {
  try {
    return statSync(path).mode;
  } catch {
    return null;
  }
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Load one env file as a lower-precedence layer.
 *
 * `requireOwnerOnly` refuses a file that any group or other user can read. The refusal is deliberately
 * NOT a thrown error: in paper mode the process should still start (it needs no credentials) so the
 * operator can read the diagnostic and fix the mode, and in live mode the missing secrets then fail
 * startup through the normal validation path. One fatal path is easier to reason about than two.
 */
function loadFile(
  target: EnvTarget,
  path: string,
  opts: {
    parse: (text: string) => EnvRecord;
    readFile: (path: string) => string;
    statMode: (path: string) => number | null;
    requireOwnerOnly: boolean;
  },
): EnvFileOutcome {
  const mode = opts.statMode(path);
  if (mode === null) {
    return {
      path,
      present: false,
      read: false,
      applied: [],
      overriddenByHigherPrecedence: [],
      problem: null,
    };
  }

  if (opts.requireOwnerOnly && (mode & 0o077) !== 0) {
    const octal = (mode & 0o777).toString(8).padStart(3, "0");
    return {
      path,
      present: true,
      read: false,
      applied: [],
      overriddenByHigherPrecedence: [],
      problem:
        `${path} is mode 0${octal}, which is readable beyond its owner, so it was REFUSED and no ` +
        `credential was loaded from it. A secrets file must be 0600 (or 0400). Fix with ` +
        `\`chmod 600 ${path}\` and restart. Nothing was read, so no value can have leaked through ` +
        `this process — but assume the contents are compromised and rotate.`,
    };
  }

  let text: string;
  try {
    text = opts.readFile(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      path,
      present: true,
      read: false,
      applied: [],
      overriddenByHigherPrecedence: [],
      problem: `${path} exists but could not be read: ${reason}`,
    };
  }

  let parsed: EnvRecord;
  try {
    parsed = opts.parse(text);
  } catch (err) {
    // The message from a parser can quote the offending LINE, which for a secrets file is a value.
    // Only the file name and the error class escape here.
    const kind = err instanceof Error ? err.name : "Error";
    return {
      path,
      present: true,
      read: false,
      applied: [],
      overriddenByHigherPrecedence: [],
      problem: `${path} could not be parsed (${kind}). No value from it is reported, by design.`,
    };
  }

  const result = applyEnvLayer(target, parsed);
  return {
    path,
    present: true,
    read: true,
    applied: result.applied,
    overriddenByHigherPrecedence: result.skipped,
    problem: null,
  };
}

/**
 * Populate `target` from the protected secrets file and then the server `.env`.
 *
 * The secrets file is applied FIRST, which — because no layer ever overwrites — is what makes it win
 * over `.env`. That ordering is intentional and is the safer of the two options: if the same
 * credential somehow appears in both, the protected file is the one under rotation control, while the
 * `.env` copy is most likely a stale paste that a rotation would not have updated.
 */
export function loadEnvironment(options: EnvLoadOptions = {}): EnvLoadReport {
  const target = options.target ?? (process.env as EnvTarget);
  const parse = options.parse ?? defaultParse;
  const readFile = options.readFile ?? defaultReadFile;
  const statMode = options.statMode ?? defaultStatMode;
  const enforceMode = options.enforceSecretsFileMode ?? process.platform !== "win32";

  // Resolved from the REAL process environment, never from a file: the file that could set it has not
  // been read yet, so honouring it from there would be a bootstrap paradox.
  const secretsPath =
    options.secretsFilePath ??
    (hasUsableValue(process.env as EnvTarget, "GTS_SECRETS_FILE")
      ? String(process.env.GTS_SECRETS_FILE)
      : DEFAULT_SECRETS_FILE);
  const envPath = options.envFilePath ?? resolve(process.cwd(), DEFAULT_ENV_FILE);

  const secretsFile = loadFile(target, secretsPath, {
    parse,
    readFile,
    statMode,
    requireOwnerOnly: enforceMode,
  });
  const envFile = loadFile(target, envPath, {
    parse,
    readFile,
    statMode,
    // The operational file is allowed to be group-readable: it holds no credential, and an operator
    // reading risk limits over a shared account is a legitimate workflow.
    requireOwnerOnly: false,
  });

  const secretsFoundInEnvFile = [...envFile.applied, ...envFile.overriddenByHigherPrecedence]
    .filter((name) => classifyEnvVar(name) === "secret")
    .sort();

  const problems: string[] = [];
  if (secretsFile.problem !== null) problems.push(secretsFile.problem);
  if (envFile.problem !== null) problems.push(envFile.problem);
  if (secretsFoundInEnvFile.length > 0) {
    problems.push(
      `${secretsFoundInEnvFile.length} credential(s) are defined in ${envPath} rather than in the ` +
        `protected secrets file (${secretsPath}): ${secretsFoundInEnvFile.join(", ")}. This works, ` +
        `but ${envPath} is the file that gets opened, pasted from and copied to a laptop while ` +
        `debugging. Move them and \`chmod 600\` the secrets file.`,
    );
  }

  return { secretsFile, envFile, secretsFoundInEnvFile, problems };
}
