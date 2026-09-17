/**
 * ENVIRONMENT LAYERING — the precedence rule, as one pure function.
 *
 * WHY THE PRECEDENCE LIVES HERE AND NOT IN dotenv's OPTIONS
 *
 * The rule this file enforces is the safety-critical part of the whole configuration story:
 *
 *     explicit process environment  >  protected secrets file  >  server .env  >  code default
 *
 * dotenv can express "do not overwrite what is already set" via its own default behaviour, and the
 * loader could have leaned on that. It deliberately does not. A silent, library-owned default is
 * exactly the kind of thing a future dependency bump can change underneath a deployment, and the
 * failure would be invisible: a stale `.env` value quietly winning over the credential the deployment
 * just injected. Owning the merge in eleven lines of our own code makes the rule explicit, testable
 * without a network or a node_modules, and impossible to change by upgrading a package.
 *
 * dotenv is still used to PARSE (see ./load.ts), because the production `.env` and the deploy
 * templates were authored against its rules — several lines carry trailing `# comments` after an
 * unquoted value, and re-implementing that lexer would risk turning `false   # shadow can never place
 * an order` into a boolean parse failure that refuses to boot. Parsing: borrowed. Precedence: ours.
 *
 * "BLANK IS NOT A VALUE"
 *
 * A variable present but empty counts as ABSENT for layering, so a file may fill it. This is not a
 * loophole in the precedence rule, it is the same convention the rest of this codebase already
 * applies (`process.env.X?.trim() ?? ""` followed by a falsy check, in every credential reader). It
 * matters operationally: process managers and CI runners routinely inject `FOO=` for a variable they
 * have no value for, and letting that blank mask a real secrets-file entry would produce a missing
 * credential with no visible cause.
 */

/** What one layer application did, by variable NAME only — never a value. */
export interface EnvLayerResult {
  /** Names this layer actually set, because they were absent or blank. */
  readonly applied: string[];
  /** Names this layer did NOT set, because a higher-precedence layer already had a value. */
  readonly skipped: string[];
}

/** A plain name→value record, as produced by parsing an env file. */
export type EnvRecord = Readonly<Record<string, string>>;

/** Somewhere variables can be read from and written to. `process.env` satisfies this. */
export type EnvTarget = Record<string, string | undefined>;

/**
 * Whether `target` already holds a usable value for `name`.
 *
 * Exported because both the loader and the validator must agree on what "set" means; two different
 * notions of presence is how a variable comes to be simultaneously reported as configured and read as
 * empty.
 */
export function hasUsableValue(target: EnvTarget, name: string): boolean {
  const current = target[name];
  return current !== undefined && current.trim().length > 0;
}

/**
 * Apply one lower-precedence layer to `target` WITHOUT overwriting anything already present.
 *
 * Call order therefore encodes precedence: apply the more authoritative source first. The loader
 * applies the protected secrets file before `.env` for exactly this reason.
 *
 * Returns names only. Nothing in this module ever reads a value into a message, so no caller can
 * accidentally log one by forwarding the result.
 */
export function applyEnvLayer(target: EnvTarget, values: EnvRecord): EnvLayerResult {
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const name of Object.keys(values)) {
    if (hasUsableValue(target, name)) {
      skipped.push(name);
      continue;
    }
    const value = values[name];
    if (value === undefined) continue;
    target[name] = value;
    applied.push(name);
  }
  applied.sort();
  skipped.sort();
  return { applied, skipped };
}
