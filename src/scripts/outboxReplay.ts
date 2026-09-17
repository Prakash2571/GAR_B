/**
 * `npm run outbox:replay` — hand-reset selected outbox rows so a dead-lettered or
 * stuck projection can be retried, then optionally drain once in the foreground.
 *
 * SAFETY
 *  - DRY-RUN BY DEFAULT. Without `--apply` it prints exactly what it WOULD change
 *    and writes nothing.
 *  - It NEVER prints a payload. A projection payload can carry trade detail, so the
 *    tool reports only ids, counts and bounded errors.
 *  - It NEVER deletes a row. It clears `dead_lettered_at`, resets `next_attempt_at`
 *    to now, and (with `--reset-attempts`) zeroes `attempts` so the row starts its
 *    budget again. `published_at` is left untouched — a published row stays
 *    published.
 *
 * SELECTORS (choose one):
 *   --dead-letters            all dead-lettered rows
 *   --aggregate <type> <id>   every unpublished row for one aggregate
 *   --event-id <id>           one row by its event_id
 *
 * OPTIONS:
 *   --apply            actually write (default is dry-run)
 *   --reset-attempts   also zero `attempts`
 *   --drain            after resetting, run one foreground drain pass (requires
 *                      a reachable Mongo and MONGO_EXPORT_ENABLED)
 */

// Loads the protected secrets file AND the server .env, without overwriting anything already in
// the process environment. Replaces `dotenv/config` so every entry point resolves configuration
// through exactly one path. See src/env/load.ts.
import "../env/boot.js";
import { closePg, getPool, initPg, pgConfigFromEnv } from "../pg/pool.js";
import { MongoExportClient, exportConfigFromEnv } from "../outbox/mongo.js";
import { Projector } from "../outbox/projector.js";

interface Selector {
  kind: "dead-letters" | "aggregate" | "event-id";
  aggregateType?: string;
  aggregateId?: string;
  eventId?: string;
}

interface Options {
  apply: boolean;
  resetAttempts: boolean;
  drain: boolean;
  selector: Selector;
}

function parseArgs(argv: string[]): Options {
  const apply = argv.includes("--apply");
  const resetAttempts = argv.includes("--reset-attempts");
  const drain = argv.includes("--drain");

  let selector: Selector | null = null;
  if (argv.includes("--dead-letters")) {
    selector = { kind: "dead-letters" };
  } else if (argv.includes("--aggregate")) {
    const i = argv.indexOf("--aggregate");
    const aggregateType = argv[i + 1];
    const aggregateId = argv[i + 2];
    if (!aggregateType || !aggregateId || aggregateType.startsWith("--") || aggregateId.startsWith("--")) {
      throw new Error("--aggregate requires <type> <id>");
    }
    selector = { kind: "aggregate", aggregateType, aggregateId };
  } else if (argv.includes("--event-id")) {
    const i = argv.indexOf("--event-id");
    const eventId = argv[i + 1];
    if (!eventId || eventId.startsWith("--")) throw new Error("--event-id requires <id>");
    selector = { kind: "event-id", eventId };
  }

  if (!selector) {
    throw new Error(
      "Choose a selector: --dead-letters | --aggregate <type> <id> | --event-id <id>",
    );
  }
  return { apply, resetAttempts, drain, selector };
}

/** Build the WHERE clause + params for the selector, scoped to unpublished rows. */
function whereForSelector(sel: Selector): { where: string; params: unknown[] } {
  switch (sel.kind) {
    case "dead-letters":
      return { where: `published_at IS NULL AND dead_lettered_at IS NOT NULL`, params: [] };
    case "aggregate":
      return {
        where: `published_at IS NULL AND aggregate_type = $1 AND aggregate_id = $2`,
        params: [sel.aggregateType, sel.aggregateId],
      };
    case "event-id":
      return { where: `published_at IS NULL AND event_id = $1`, params: [sel.eventId] };
  }
}

function describeSelector(sel: Selector): string {
  switch (sel.kind) {
    case "dead-letters":
      return "all dead-lettered rows";
    case "aggregate":
      return `aggregate ${sel.aggregateType}/${sel.aggregateId}`;
    case "event-id":
      return `event_id ${sel.eventId}`;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  await initPg(pgConfigFromEnv());
  const pool = getPool();
  const { where, params } = whereForSelector(opts.selector);

  // Count what matches, and how many of those are currently dead-lettered — ids
  // only, never a payload.
  const { rows: matchRows } = await pool.query<{ event_id: string; dead: boolean }>(
    `SELECT event_id, (dead_lettered_at IS NOT NULL) AS dead FROM mongo_outbox WHERE ${where} ORDER BY sequence`,
    params,
  );
  const total = matchRows.length;
  const deadCount = matchRows.filter((r) => r.dead).length;

  console.log(`[outbox:replay] selector: ${describeSelector(opts.selector)}`);
  console.log(
    `[outbox:replay] matched ${total} unpublished row(s), of which ${deadCount} dead-lettered.`,
  );

  if (total === 0) {
    console.log("[outbox:replay] nothing to do.");
    return;
  }

  if (!opts.apply) {
    console.log(
      `[outbox:replay] DRY RUN — no changes written. Re-run with --apply to reset ` +
        `next_attempt_at=now, clear dead_lettered_at${opts.resetAttempts ? ", reset attempts=0" : ""}.`,
    );
    // Show a bounded sample of ids so the operator can confirm the target.
    console.log(
      `[outbox:replay] would reset event_ids: ${matchRows.slice(0, 20).map((r) => r.event_id).join(", ")}` +
        (total > 20 ? `, … (+${total - 20} more)` : ""),
    );
    return;
  }

  const attemptsClause = opts.resetAttempts ? `, attempts = 0` : ``;
  const { rowCount } = await pool.query(
    `UPDATE mongo_outbox
        SET dead_lettered_at = NULL,
            next_attempt_at = clock_timestamp(),
            last_error = NULL${attemptsClause}
      WHERE ${where}`,
    params,
  );
  console.log(`[outbox:replay] reset ${rowCount ?? 0} row(s).`);

  if (opts.drain) {
    const cfg = exportConfigFromEnv();
    if (!cfg.enabled) {
      console.log(
        "[outbox:replay] --drain requested but export is disabled (MONGO_EXPORT_ENABLED/ MONGODB_URI). Skipping drain.",
      );
      return;
    }
    const mongo = new MongoExportClient(cfg);
    const projector = new Projector(pool, mongo, {
      batchSize: cfg.batchSize,
      intervalMs: cfg.intervalMs,
      maxBackoffMs: cfg.maxBackoffMs,
      maxAttempts: cfg.maxAttempts,
    });
    try {
      const res = await projector.runOnce();
      console.log(
        `[outbox:replay] drain pass: claimed ${res.claimed}, published ${res.published}, ` +
          `failed ${res.failed}, dead-lettered ${res.deadLettered}.`,
      );
    } finally {
      await mongo.close();
    }
  }
}

main()
  .then(async () => {
    await closePg();
    process.exit(0);
  })
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[outbox:replay] FAILED: ${message}`);
    await closePg().catch(() => undefined);
    process.exit(1);
  });
