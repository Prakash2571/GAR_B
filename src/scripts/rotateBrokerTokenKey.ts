/**
 * rotateBrokerTokenKey — re-encrypt every stored broker session under a NEW
 * `BROKER_TOKEN_ENCRYPTION_KEY`, inside ONE PostgreSQL transaction.
 *
 * USAGE
 *   BROKER_TOKEN_OLD_KEY=<old> BROKER_TOKEN_NEW_KEY=<new> \
 *     npm run rotate:broker-token-key [-- --dry-run]
 *
 * WHY THE KEYS COME FROM THE ENVIRONMENT, NOT ARGV
 * A process's argv is visible in `ps` to any user on the box; its environment is
 * not (to non-root). Key material is therefore read from protected environment
 * variables and never accepted on the command line.
 *
 * ATOMICITY
 * Every row is decrypted with the old key and re-encrypted with the new key inside
 * a single transaction. A failure on ANY row rolls the whole thing back, so the
 * table is never left half under one key and half under another — which would make
 * some tokens unreadable no matter which key the app loaded.
 *
 * --dry-run
 * Decrypts every row with the old key to PROVE the old key is correct and every row
 * is intact, re-encrypts in memory, then ROLLS BACK. It writes nothing and is the
 * safe first step before a real rotation.
 *
 * IT PRINTS NO TOKEN MATERIAL. Only counts, broker names and pass/fail.
 */

// FIRST IMPORT. This script reads BROKER_TOKEN_OLD_KEY, BROKER_TOKEN_NEW_KEY and DATABASE_URL, and
// until now loaded NO env file at all — unlike every other script, it had no `dotenv/config`. Run as
// `npm run rotate:broker-token-key` it therefore saw whatever was already exported and reported the
// keys as unset, which for a key-rotation tool is the worst possible time to be confusing. Loading the
// protected secrets file here is the fix; the keys can still be exported inline to override it.
import "../env/boot.js";
import { initPg, closePg, withTx, pgConfigFromEnv } from "../pg/pool.js";
import { decodeEncryptionKey, openToken, sealToken, type SealedToken, type TokenAad } from "../brokerState/tokenCrypto.js";

interface RotateRow {
  broker: string;
  encrypted_access_token: Buffer;
  encryption_iv: Buffer;
  encryption_auth_tag: Buffer;
  credential_version: number;
  api_key_or_client_id: string;
  login_date: string;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const oldRaw = process.env.BROKER_TOKEN_OLD_KEY;
  const newRaw = process.env.BROKER_TOKEN_NEW_KEY;

  if (!oldRaw || !newRaw) {
    console.error(
      "Set BROKER_TOKEN_OLD_KEY and BROKER_TOKEN_NEW_KEY in the environment. " +
        "Never pass keys on the command line.",
    );
    process.exit(2);
    return;
  }

  let oldKey: Buffer;
  let newKey: Buffer;
  try {
    oldKey = decodeEncryptionKey(oldRaw);
    newKey = decodeEncryptionKey(newRaw);
  } catch (err) {
    console.error(`Key validation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
    return;
  }

  await initPg(pgConfigFromEnv());

  let rotated = 0;
  try {
    await withTx(async (client) => {
      const { rows } = await client.query<RotateRow>(
        `SELECT broker, encrypted_access_token, encryption_iv, encryption_auth_tag,
                credential_version, api_key_or_client_id, login_date
           FROM broker_sessions
          WHERE status = 'active'
          FOR UPDATE`,
      );

      for (const row of rows) {
        const aad: TokenAad = {
          broker: row.broker,
          credentialVersion: row.credential_version,
          apiKeyOrClientId: row.api_key_or_client_id,
          loginDate: row.login_date,
        };
        const sealed: SealedToken = {
          ciphertext: row.encrypted_access_token,
          iv: row.encryption_iv,
          authTag: row.encryption_auth_tag,
        };

        // Decrypt with the OLD key — proves the old key is correct and the row intact.
        const plaintext = openToken(oldKey, sealed, aad);

        // Re-encrypt under the NEW key with a fresh IV. AAD (including
        // credential_version) is unchanged, so the app reads it back cleanly.
        const resealed = sealToken(newKey, plaintext, aad);

        if (!dryRun) {
          await client.query(
            `UPDATE broker_sessions
                SET encrypted_access_token = $2,
                    encryption_iv          = $3,
                    encryption_auth_tag    = $4,
                    updated_at             = now()
              WHERE broker = $1`,
            [row.broker, resealed.ciphertext, resealed.iv, resealed.authTag],
          );
        }
        rotated += 1;
        console.log(`  ${dryRun ? "verified" : "re-encrypted"} broker=${row.broker}`);
      }

      if (dryRun) {
        // Roll back deliberately: a dry run writes nothing.
        throw new DryRunComplete();
      }
    });
    console.log(`Rotation complete: ${rotated} session(s) re-encrypted.`);
  } catch (err) {
    if (err instanceof DryRunComplete) {
      console.log(`Dry run OK: ${rotated} session(s) decrypt with the old key and re-encrypt cleanly. Nothing was written.`);
    } else {
      console.error(`Rotation FAILED and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
      await closePg();
      process.exit(1);
      return;
    }
  }

  await closePg();
}

/** A sentinel used to roll back the dry-run transaction without signalling failure. */
class DryRunComplete extends Error {
  constructor() {
    super("dry-run rollback");
    this.name = "DryRunComplete";
  }
}

void main().catch((err) => {
  console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
