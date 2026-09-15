/**
 * SHARED WIRE PROJECTIONS — the single source of truth for how internal read
 * models are re-projected into the PUBLIC HTTP shapes.
 *
 * WHY THIS MODULE EXISTS
 * `src/index.ts` deliberately RE-PROJECTS several internal shapes into their public
 * contract shapes rather than passing them through, so that a future field added to
 * an internal type (a broker session, the outbox status snapshot) cannot silently
 * leak onto the wire. The catch is that when those projections are built as inline
 * object literals inside index.ts they are UNTESTABLE — the contract suite could
 * only validate a hand-written stub that happens to resemble the projection, not
 * the projection itself. That is exactly how two real fields (`enabled`/`connected`
 * on export status and `state` on a broker session) shipped without ever appearing
 * in the declared type or the schema.
 *
 * THE FIX: extract each re-projection into a small PURE function here, and have BOTH
 * src/index.ts (production) AND the contract test call the identical function. The
 * returned object is byte-identical to the old inline literal — this is a pure
 * refactor with ZERO behaviour change. The point is that production and the
 * contract test now share one projection, so the schema is validated against the
 * REAL shape the endpoint emits.
 *
 * NO SECRETS
 * None of these projections may carry a raw/encrypted token, the site passcode or
 * any key material. They emit states, counts, ages, timestamps and redacted labels
 * only — the same guarantee the consuming route modules document.
 */

import type { ExportStatusSnapshot as OutboxExportSnapshot } from "../outbox/status.js";
import type { BrokerId, RedactedBrokerSession, BrokerHealth } from "../brokerRoutes.js";
import type { ExportStatusSnapshot } from "./statusRoutes.js";
import type { BrokerSessionState, BrokerHealthState } from "../brokers/types.js";

/**
 * Reduce a broker account identity to something safe to display.
 *
 * A Zerodha user id or a Dhan client id is not a credential on its own, but paired
 * with a leaked token it is exactly what an attacker needs to know they have a usable
 * pair — and the dashboard only ever needs to answer "is this the account I expect?".
 * Keep the last four characters, mask the rest.
 */
export function redactIdentity(raw: string | null): string | null {
  if (!raw) return null;
  return raw.length <= 4 ? "•".repeat(raw.length) : `${"•".repeat(Math.min(raw.length - 4, 8))}${raw.slice(-4)}`;
}

/**
 * Project the outbox status snapshot (`src/outbox/status.ts`, named in the
 * projector's terms) into the public export-status contract shape (named in the
 * operator's terms). Re-projected rather than passed through so a rename on either
 * side cannot silently change the public wire shape.
 */
export function projectExportStatus(s: OutboxExportSnapshot): ExportStatusSnapshot {
  return {
    enabled: s.enabled,
    connected: s.connected,
    backlog_count: s.backlog,
    oldest_pending_age_ms: s.oldestPendingAgeMs,
    last_success_at: s.lastSuccessAt,
    last_error: s.lastError,
    dead_letter_count: s.deadLettered,
  };
}

/**
 * Project an internal `BrokerSessionState` into the redacted public session shape.
 * Deliberately RE-PROJECTED rather than spread: `BrokerSessionState` is an internal
 * shape and a future field on it must not silently become public. Nothing here can
 * carry a token — the state object has never held one.
 *
 * `activeBroker` is passed in (not read from a global) so this stays a pure function
 * the contract test can drive with fixed inputs.
 */
export function projectBrokerSession(
  broker: BrokerId,
  s: BrokerSessionState,
  activeBroker: BrokerId,
): RedactedBrokerSession {
  return {
    broker,
    connected: s.authenticated && !s.token_expired,
    /**
     * EXPIRY IS TESTED FIRST, AND THAT ORDER IS THE POINT.
     *
     * This used to test `!authenticated` first, which made `"expired"` unreachable in
     * practice: both brokers report `authenticated: false` once their token is past its
     * expiry (Dhan by its stated instant, Zerodha by the IST day boundary), so an expired
     * session projected as `"waiting"`. The operator was shown "token waiting" — wait for
     * something — next to a `problems` entry saying the session had expired — go and act.
     * Two answers to one question, and the less useful one won.
     *
     * `"waiting"` now means only what it says: no session has ever been established. If a
     * token exists and is dead, that is `"expired"`, which is what tells the operator to
     * sign in AGAIN rather than to sign in.
     */
    state: s.token_expired
      ? "expired"
      : !s.authenticated
        ? "waiting"
        : activeBroker === broker
          ? "ready"
          : "standby",
    account_label: redactIdentity(s.client_id),
    established_at: s.login_at === null ? null : new Date(s.login_at).toISOString(),
    expires_at: s.token_expires_at === null ? null : new Date(s.token_expires_at).toISOString(),
  };
}

/**
 * Project an internal `BrokerHealthState` into the redacted public health shape.
 * Re-projected (not spread) so internal-only fields (token metadata, feed age,
 * static-IP config) never leak onto the wire.
 */
export function projectBrokerHealth(broker: BrokerId, h: BrokerHealthState): BrokerHealth {
  return {
    broker,
    authenticated: h.authenticated,
    data_ready: h.data_ready,
    trading_ready: h.trading_ready,
    problems: h.problems,
  };
}
