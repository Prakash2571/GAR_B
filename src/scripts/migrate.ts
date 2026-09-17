/**
 * `npm run migrate` — apply checked-in SQL migrations, or `--check` to assert the
 * database is fully migrated without touching it.
 *
 * This is the deliberate release step for deployments that run with
 * `PG_MIGRATE_ON_BOOT=false`: the schema is advanced here, as an explicit action,
 * and the process then refuses to boot against a database that is behind the code.
 *
 * It loads `.env`, initialises the pool, runs (or checks) migrations, prints a
 * single honest line of counts, and exits non-zero on any failure so CI and a
 * release script can gate on it. It never prints a connection string with
 * credentials — `pgStatus()` already redacts the target.
 */

// Loads the protected secrets file AND the server .env, without overwriting anything already in
// the process environment. Replaces `dotenv/config` so every entry point resolves configuration
// through exactly one path. See src/env/load.ts.
import "../env/boot.js";
import { closePg, initPg, pgConfigFromEnv, pgStatus } from "../pg/pool.js";
import { assertMigrated, runMigrations } from "../pg/migrate.js";

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");

  await initPg(pgConfigFromEnv());
  const target = pgStatus().target ?? "(configured)";

  if (checkOnly) {
    await assertMigrated();
    // Reaching here means nothing is pending.
    console.log(`[migrate] --check OK: schema is up to date (target ${target}).`);
    return;
  }

  const { applied, skipped } = await runMigrations();
  console.log(
    `[migrate] target ${target}: applied ${applied.length}, skipped ${skipped.length}.` +
      (applied.length > 0 ? ` Applied: ${applied.join(", ")}.` : ""),
  );
}

main()
  .then(async () => {
    await closePg();
    process.exit(0);
  })
  .catch(async (err) => {
    // `boundedError`-style: never dump SQL or a stack full of the connection string.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[migrate] FAILED: ${message}`);
    await closePg().catch(() => undefined);
    process.exit(1);
  });
