/**
 * WHO OWNS A RESERVATION — a globally unique, opaque owner identity.
 *
 * WHY A SEQUENCE NUMBER IS NOT ENOUGH
 * The coordinator used to mint `entry-7-lx9f2k` from a per-process counter. Inside
 * one process that is unique. Across two PM2 workers it is not: worker-1's
 * `entry-7` and worker-2's `entry-7` are the same string, so worker-2 could
 * "renew" — or worse, RELEASE — worker-1's lease, and a durable store keyed on that
 * identity would happily let it. Owner identity has to be unique across every
 * process that shares the database, or owner-verified release is verifying nothing.
 *
 * SHAPE
 *   <deployment>:<instance>:p<pid>:<boot>:<kind>-<seq>:<uuid>
 *   production-mumbai:gts-1:p38192:m8x2a:entry-7:9f2c1e...
 *
 * Every component earns its place:
 *   deployment  namespaces staging away from production in a shared cluster
 *   instance    names the host/replica, so a log line says which box it was
 *   pid         distinguishes PM2 cluster workers on one host
 *   boot        distinguishes a RESTARTED process that reused the same pid
 *   kind-seq    human-readable correlation with the coordinator's own logs
 *   uuid        makes collision impossible rather than merely unlikely
 *
 * The uuid alone would be sufficient for uniqueness. The rest is there because an
 * operator reading a conflict log needs to know WHICH worker is holding a contract,
 * and a bare uuid tells them nothing.
 *
 * OPAQUE, AND NO SECRETS
 * Owner ids reach logs, metrics labels and (via diagnostics) an admin API response.
 * They are therefore built only from a configured deployment label, a hostname, a
 * pid and random bytes. No token, no URI, no credential — and `deployment` is
 * validated to a conservative character set so a mistyped env var carrying something
 * sensitive cannot be smuggled through it.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

/** Conservative label: what survives in a Mongo key, a log line and a URL. */
const LABEL_SAFE = /[^A-Za-z0-9._-]+/g;

function sanitiseLabel(raw: string, fallback: string, max = 64): string {
  const cleaned = raw.trim().replace(LABEL_SAFE, "-").replace(/^-+|-+$/g, "");
  if (cleaned === "") return fallback;
  return cleaned.slice(0, max);
}

/**
 * The lock namespace for this deployment.
 *
 * DEVELOPMENT AND PRODUCTION MUST NOT SHARE ONE. Pointing a laptop at the
 * production cluster to debug something is normal and must not let that laptop take
 * a lock that stops the real trading process from executing — or, far worse, let the
 * laptop believe it holds a contract that production is actively trading.
 *
 * Explicit `CALSPREAD_DEPLOYMENT_ID` wins. Failing that it falls back to `NODE_ENV`,
 * which at least separates a `production` deployment from an unset/`development`
 * one rather than defaulting everything into a single shared namespace.
 */
export function resolveDeploymentId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.CALSPREAD_DEPLOYMENT_ID?.trim();
  if (explicit) return sanitiseLabel(explicit, "development");
  const nodeEnv = env.NODE_ENV?.trim();
  if (nodeEnv) return sanitiseLabel(nodeEnv, "development");
  return "development";
}

/** True when the deployment namespace was chosen by an operator rather than inferred. */
export function isDeploymentIdExplicit(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CALSPREAD_DEPLOYMENT_ID?.trim());
}

export interface ProcessIdentity {
  /** Lock namespace. */
  readonly deployment: string;
  /** Host/replica label. */
  readonly instance: string;
  readonly pid: number;
  /** Random per-boot token, so a reused pid is still distinguishable. */
  readonly boot: string;
  /** `instance:p<pid>:<boot>` — the stable prefix identifying THIS process. */
  readonly processTag: string;
}

/**
 * Build the identity for this process. Called ONCE at startup.
 *
 * Once, because the boot token must be stable for the lifetime of the process: if it
 * were regenerated per acquisition, a process could not recognise its own
 * reservations after a reconnect, and the broker-switch cleanup below could not tell
 * "mine" from "another worker's".
 */
export function createProcessIdentity(env: NodeJS.ProcessEnv = process.env): ProcessIdentity {
  const deployment = resolveDeploymentId(env);
  const instance = sanitiseLabel(
    env.CALSPREAD_INSTANCE_ID?.trim() || hostname() || "unknown-host",
    "unknown-host",
    40,
  );
  // PM2 sets NODE_APP_INSTANCE per cluster worker. Folding it in makes two workers on
  // one host distinguishable in a log even before the pid is read.
  const worker = env.NODE_APP_INSTANCE?.trim();
  const instanceLabel = worker ? sanitiseLabel(`${instance}-w${worker}`, instance, 48) : instance;
  const pid = typeof process.pid === "number" ? process.pid : 0;
  const boot = randomUUID().replace(/-/g, "").slice(0, 8);
  return {
    deployment,
    instance: instanceLabel,
    pid,
    boot,
    processTag: `${instanceLabel}:p${pid}:${boot}`,
  };
}

/**
 * Mint one execution's owner id.
 *
 * `kind` and `seq` come from the coordinator so its own log lines and the durable
 * document agree on how to name an execution; the uuid is what actually guarantees
 * global uniqueness.
 */
export function mintOwnerId(identity: ProcessIdentity, kind: string, seq: number): string {
  const label = sanitiseLabel(kind, "exec", 16);
  return `${identity.deployment}:${identity.processTag}:${label}-${seq.toString(36)}:${randomUUID()}`;
}

/**
 * Does this owner id belong to THIS process?
 *
 * The broker-switch path needs this. Clearing reservations on a switch is correct
 * for the reservations this process owns — its keys are in the OLD broker's
 * namespace and are meaningless now — but deleting another live worker's
 * reservations would be exactly the multi-process violation being fixed. The prefix
 * includes the per-boot token, so even a restarted process with the same pid is
 * correctly treated as "not me".
 */
export function isOwnedByProcess(owner: string, identity: ProcessIdentity): boolean {
  return owner.startsWith(`${identity.deployment}:${identity.processTag}:`);
}

/** The `deployment:processTag:` prefix, for a durable prefix query. */
export function processOwnerPrefix(identity: ProcessIdentity): string {
  return `${identity.deployment}:${identity.processTag}:`;
}
