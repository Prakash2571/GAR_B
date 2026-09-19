/**
 * A RESOLVE HOOK THAT LETS THE TEST RUNNER IMPORT TypeScript SOURCE DIRECTLY.
 *
 * WHY THIS EXISTS
 *
 * Every existing test in this repository imports from `../../dist/**` — it asserts against the
 * BUILT output, which is the right default: it proves the thing that actually ships. That
 * requires `npm run build`, i.e. a working `typescript` + `@types/*` install.
 *
 * This hook adds a SECOND, narrower capability: running a test directly against `src/**.ts` with
 * `node --experimental-strip-types`, no build step and no devDependencies. It exists for the pure
 * decision modules (`src/box/operatorConfig/**`), whose whole design property is that they are
 * free of `express`, `pg`, `mongodb` and every other runtime dependency. Being testable without a
 * toolchain is evidence OF that property, not a workaround around it.
 *
 * WHAT IT DOES, AND THE ONE THING IT DOES NOT DO
 *
 * This codebase compiles under NodeNext, so a TypeScript file importing a sibling writes the
 * specifier with a `.js` extension (`./precedence.js`) even though the file on disk is
 * `./precedence.ts`. `--experimental-strip-types` performs no module resolution of its own, so
 * that specifier fails at runtime. The hook rewrites a RELATIVE `.js` specifier to `.ts` — and
 * only when the `.ts` file genuinely exists on disk.
 *
 * It deliberately does NOT transform anything. Types are stripped by Node itself, so the modules
 * under test must stay within erasable syntax (no `enum`, no `namespace`, no parameter
 * properties). That constraint is enforced by `operatorConfigErasable.test.mjs`, which is also
 * what keeps `npm run build` and this harness agreeing about the same source.
 *
 * SCOPE: relative specifiers only. A bare specifier is passed straight through to the default
 * resolver, so this can never silently redirect a package import.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Rewrite `./x.js` → `./x.ts` when the TypeScript file is the one that exists.
 *
 * Returning `nextResolve(...)` for everything else keeps the default algorithm — including
 * `node_modules` lookup and import-map handling — completely untouched.
 */
export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && specifier.endsWith(".js") && context.parentURL !== undefined) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (candidate.protocol === "file:" && existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}
