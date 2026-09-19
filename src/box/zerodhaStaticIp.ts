/**
 * ZERODHA STATIC-IP: AN OPERATOR CONFIRMATION POLICY, NOT A BROKER VERIFICATION.
 *
 * ── THE TWO SEPARATE THINGS THIS FILE KEEPS APART ────────────────────────────────────────────
 *
 * 1. THE BROKER/INFRASTRUCTURE REQUIREMENT. Zerodha requires the public egress IP that sends API
 *    order requests to be registered in the Kite developer console, and requests from an
 *    unregistered address may be rejected. That requirement is real and lives outside this process.
 *
 * 2. GAR_B'S POLICY GATE. This module. It records whether an OPERATOR has confirmed (1) was done,
 *    and refuses NEW LIVE ENTRY on Zerodha when they have not.
 *
 * These must never be conflated in anything an operator reads. GAR_B cannot prove (1): Kite exposes
 * no authoritative endpoint that answers "is this IP whitelisted for my API key". So the strongest
 * true statement available is "the operator asserted it", and every string below says exactly that.
 * A gate that reported "broker-verified" on the strength of an env var would be inventing evidence,
 * which on a real-money path is worse than having no gate.
 *
 * ── WHY THIS IS AN ENTRY GATE AND NOTHING MORE ───────────────────────────────────────────────
 *
 * An operator who forgets `ZERODHA_STATIC_IP_CONFIRMED=true` must never cause GAR_B to refuse to
 * ATTEMPT reducing exposure it already owns. The forgotten flag is a fact about GAR_B's paperwork,
 * not about the broker's willingness to accept a cancel — and if the host genuinely is on the wrong
 * IP, the right behaviour is still to TRY the exit and surface Zerodha's own rejection as the
 * infrastructure failure it is. Declining to try would convert a missing checkbox into stranded
 * risk.
 *
 * So the refusal below is consumed in exactly one place: the order manager's ENTRY-only admission
 * path. It is deliberately NOT expressed as an adapter-level `ensureTradingReady()`-style check,
 * because Dhan's equivalent is called from `submitOrder`, `cancelOrder` AND `modifyOrder` — correct
 * for Dhan, whose broker genuinely refuses all three from a non-whitelisted address, and wrong as a
 * home for a local policy flag.
 *
 * ── NO NETWORK, EVER, ON THIS PATH ───────────────────────────────────────────────────────────
 *
 * Every function here is pure and synchronous. There is no public-IP discovery call, so order
 * placement, the pre-POST guard, cancel, modify, emergency flatten and reconciliation cannot acquire
 * an external dependency through this module. `ZERODHA_EXPECTED_EGRESS_IP` is recorded and reported
 * for preflight and diagnostics only; nothing compares it against an observed address, because this
 * repository has no existing safe egress-discovery mechanism and inventing one for this patch was
 * out of scope. A matching egress IP would not prove the whitelist anyway.
 */

/** Scope of a readiness blocker, mirrored locally so this module imports nothing. */
type BlockerScope = "entry" | "reduction" | "both";

/** The shape `operationalReadiness` consumes. Structural, so no import is needed. */
export interface ZerodhaStaticIpBlocker {
  readonly code: "zerodha_static_ip_unconfirmed";
  readonly scope: BlockerScope;
  readonly detail: string;
}

/** The stable reason token, used by the enforcement path and the readiness surface alike. */
export const ZERODHA_STATIC_IP_UNCONFIRMED = "zerodha_static_ip_unconfirmed";

/**
 * The operator's declared position on the static IP.
 *
 * `expectedEgressIp` is `null` when unset OR when the value was not a usable IPv4 address — an
 * unparseable address is not evidence of anything, so it is not carried forward as though it were.
 */
export interface ZerodhaStaticIpPolicy {
  /** The operator asserts the expected egress IP is registered with Zerodha. Never broker-proven. */
  readonly confirmed: boolean;
  /** The public egress IP the operator expects order requests to leave from, or null. */
  readonly expectedEgressIp: string | null;
  /** True when a value was set but rejected as malformed — worth reporting, not worth trusting. */
  readonly expectedEgressIpMalformed: boolean;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Validate an IPv4 dotted quad, returning the canonical form or null.
 *
 * Deliberately strict and deliberately IPv4-only: this exists to catch a hostname, a CIDR block, a
 * port suffix or a truncated paste in the one field an operator copies by hand off a console. It is
 * not a general address parser, and it does not accept a range — Zerodha registers a single address,
 * so accepting `1.2.3.0/24` here would quietly describe something the broker never agreed to.
 */
export function normaliseEgressIp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  const match = IPV4.exec(text);
  if (match === null) return null;
  const octets = match.slice(1, 5).map((part) => Number(part));
  // Reject a leading zero ("01.2.3.4"): it is ambiguous (octal in some resolvers) and always a typo.
  for (let i = 0; i < 4; i += 1) {
    const part = match[i + 1] as string;
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = octets[i] as number;
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
  }
  return octets.join(".");
}

/** Parse the two operator-facing variables. Accepts an env bag so it is testable without globals. */
export function readZerodhaStaticIpPolicy(env: Record<string, string | undefined>): ZerodhaStaticIpPolicy {
  const rawConfirmed = env.ZERODHA_STATIC_IP_CONFIRMED;
  const text = typeof rawConfirmed === "string" ? rawConfirmed.trim().toLowerCase() : "";
  /*
   * FAIL CLOSED. Unset, blank and unrecognised all read as NOT confirmed. Only the explicit
   * affirmatives count, and an unrecognised value is never resolved to `true` — the whole value of
   * the gate is that it cannot be satisfied by accident.
   */
  const confirmed = text === "1" || text === "true" || text === "yes";
  const rawIp = env.ZERODHA_EXPECTED_EGRESS_IP;
  const expectedEgressIp = normaliseEgressIp(rawIp);
  const setButUnusable = typeof rawIp === "string" && rawIp.trim() !== "" && expectedEgressIp === null;
  return { confirmed, expectedEgressIp, expectedEgressIpMalformed: setButUnusable };
}

/**
 * Does the static-IP POLICY refuse a new live Zerodha entry?
 *
 * Returns a bounded operator sentence, or null when the policy has no objection. Total and
 * synchronous, so it is safe inside the order manager's admission path.
 *
 * Scoped to an explicitly-Zerodha active broker. An unknown broker is deliberately NOT refused here:
 * a deployment that has not selected a broker is already refused entry by broker auth, token
 * readiness and reconciliation gates, and guessing would let a Dhan-only deployment be blocked by a
 * Zerodha variable it has no reason to set.
 */
export function zerodhaStaticIpEntryRefusal(input: {
  /** Live execution only. A paper profile places no broker order and is never gated. */
  readonly live: boolean;
  readonly broker: string | undefined;
  readonly policy: Pick<ZerodhaStaticIpPolicy, "confirmed" | "expectedEgressIp">;
}): string | null {
  if (!input.live) return null;
  if (input.broker !== "zerodha") return null;
  if (input.policy.confirmed) return null;
  const expected =
    input.policy.expectedEgressIp === null
      ? "no expected egress IP is configured"
      : `the expected egress IP is ${input.policy.expectedEgressIp}`;
  return (
    `${ZERODHA_STATIC_IP_UNCONFIRMED}: Zerodha requires the public egress IP that sends API order ` +
    `requests to be registered in the Kite developer console, and ${expected}. No operator has ` +
    `confirmed the registration, so no NEW entry is taken. Set ZERODHA_STATIC_IP_CONFIRMED=true once ` +
    `the address is registered. This is an operator confirmation, not a broker-verified fact — GAR_B ` +
    `cannot query Zerodha for the whitelist. Exits, protective cancels, emergency residual ` +
    `flattening and reconciliation are NOT gated by this and are still attempted.`
  );
}

/**
 * The same condition as an entry-scoped readiness blocker, for status and diagnostics.
 *
 * OBSERVABILITY ONLY. `operationalReadiness()` is consumed by `getStatus()` and the runtime-status
 * projection and by nothing in the entry decision path, so this function cannot and must not be the
 * thing that stops an order. Enforcement is `zerodhaStaticIpEntryRefusal` in the order manager's
 * ENTRY admission. Both are tested independently, precisely so that a future refactor removing one
 * cannot be mistaken for still having the other.
 */
export function zerodhaStaticIpReadinessBlocker(input: {
  readonly live: boolean;
  readonly broker: string | undefined;
  readonly policy: ZerodhaStaticIpPolicy;
}): ZerodhaStaticIpBlocker | null {
  if (zerodhaStaticIpEntryRefusal(input) === null) return null;
  const expected =
    input.policy.expectedEgressIp === null
      ? "ZERODHA_EXPECTED_EGRESS_IP is not set"
      : `ZERODHA_EXPECTED_EGRESS_IP=${input.policy.expectedEgressIp}`;
  const malformed = input.policy.expectedEgressIpMalformed
    ? " ZERODHA_EXPECTED_EGRESS_IP was set to a value that is not a usable IPv4 address and has been ignored."
    : "";
  return {
    code: ZERODHA_STATIC_IP_UNCONFIRMED,
    scope: "entry",
    detail:
      `ZERODHA_STATIC_IP_CONFIRMED is not set, so the operator has not confirmed that the public ` +
      `egress IP sending Zerodha order requests is registered in the Kite developer console ` +
      `(${expected}).${malformed} New entry is refused. This is an operator confirmation and NOT a ` +
      `broker-verified fact. Exposure already held can still be exited, reduced, protectively ` +
      `cancelled and reconciled — if the host is genuinely on an unregistered address Zerodha may ` +
      `reject those requests itself, which surfaces as a broker/infrastructure failure rather than ` +
      `as this policy.`,
  };
}
