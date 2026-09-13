# Legacy Box import (`npm run migrate:box-from-mongo`)

A **one-time** cutover tool that reads the predecessor codebase's Box collections from a legacy
MongoDB and writes them into this backend's authoritative PostgreSQL tables. Run it
once, during cutover, to carry the historical Box book across.

## What it imports

From the legacy database (`LEGACY_BOX_MONGODB_URI`):

| Legacy collection | Target table |
| --- | --- |
| `box_trades` | `box_trades` |
| `box_trade_events` | `box_trade_events` |
| `box_order_intents` | `box_order_intents` |
| `box_execution_attempts` | `box_execution_attempts` |
| `box_daily_pnl` | `box_daily_pnl` |
| `box_settings` | `box_settings` |
| `box_trading_session` | `box_trading_session` |
| `box_calibration_samples` | `box_calibration_samples` |

## How to run

```bash
# 1) DRY RUN first (default): reads, validates, reports, writes NOTHING.
LEGACY_BOX_MONGODB_URI="mongodb+srv://…/legacydb" npm run migrate:box-from-mongo

# 2) When the dry-run report looks right, apply:
LEGACY_BOX_MONGODB_URI="mongodb+srv://…/legacydb" npm run migrate:box-from-mongo -- --apply
```

`DATABASE_URL` selects the target PostgreSQL. Migrations must already be applied
(`npm run migrate`).

## Safety rules (all enforced in code)

1. **Dry-run by default.** Without `--apply` it writes nothing. `--apply` is required
   to write.
2. **Fully idempotent.** Every write is keyed on the preserved legacy `_id` with
   `ON CONFLICT … DO UPDATE` (or a natural-key existence check for the two tables
   without a legacy-id column — `box_trade_events` and `box_calibration_samples`).
   Re-running produces the same target state and never a duplicate.
3. **Opaque ids preserved.** A legacy `_id` (ObjectId or string) becomes the target
   text primary key **verbatim** as a string. Trade/attempt cross-references keep
   their exact old string values.
4. **Refuses to run against a live process.** Before importing, it checks the TARGET
   PostgreSQL for durable live markers:
   - an **armed trading session** — always blocks;
   - a **nonterminal order intent that is NOT in the legacy source** — blocks,
     because it can only have been produced by a live GTS Algo Research process. (Intents
     that ARE in the legacy source are the ones being re-imported, so they do not
     block a re-run — this is what keeps the import idempotent.)

   If a live marker is present the import aborts. **Stop all GTS Algo Research processes
   and retry.**

   > `--force-with-live` exists but **MUST NOT** be used against a live deployment.
   > Importing while the engine could be trading can interleave writes with the
   > running engine and corrupt position state. Do not use this flag. It exists only
   > for controlled disaster-recovery drills against a target you have personally
   > confirmed is not being written by any process.

5. **Never marks anything flat.** The import copies state **verbatim**. It never
   changes an order intent's `state`, never resolves a residual, never marks an
   unknown or nonterminal order flat/terminal. Open positions and nonterminal
   intents are **reported individually** so an operator can reconcile them by hand —
   they are carried across exactly as they were.
6. **No secrets printed.** No connection string, no token, no credential is ever
   logged. Errors are bounded. Calibration rows carry only anonymised numbers.

## The migration report

At the end the tool prints:

- **Per-collection counts:** `source`, `targetBefore`, `written`, `targetAfter`.
- **Count validation:** for `--apply`, keyed-by-id collections must end with
  `targetAfter >= source`; a mismatch is flagged loudly. (`box_trade_events` and
  `box_calibration_samples` dedupe on natural identity, so their `targetAfter` can
  legitimately be below `source` when the target already held equivalents.)
- **Open positions** carried across (never flattened), each listed individually.
- **Nonterminal intents** carried across (never marked flat), each listed
  individually with its state.
- Any **bounded errors**, by collection and id (never a payload).

## After the import

Reconcile the reported open positions and nonterminal intents by hand before arming
the engine. The import deliberately leaves them exactly as it found them; deciding
what to do with an in-flight order is an operator judgement, not something an import
tool may take on itself.
