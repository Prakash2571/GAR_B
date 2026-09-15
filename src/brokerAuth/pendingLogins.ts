/**
 * The pending broker-login store: what makes an OAuth callback trustworthy here.
 *
 * WHY THIS EXISTS AT ALL — THE SameSite=Strict PROBLEM
 * The site session is an HttpOnly cookie set with `SameSite=Strict`
 * (src/access/cookies.ts). That is the correct setting for a trading console, and it has
 * one unavoidable consequence: when Zerodha or Dhan redirects the operator's browser BACK
 * to this backend, the browser is arriving from a THIRD-PARTY site, so it sends NO session
 * cookie. `requireOperator` on the callback route would therefore 401 every single real
 * login, and relaxing the cookie to `Lax` to make it work would weaken the session
 * everywhere to buy nothing.
 *
 * So the callback cannot be authenticated by the session. It is authenticated by THIS
 * store instead: a login must have been STARTED, moments earlier, by a request that DID
 * carry a valid operator session, and the callback must correspond to that start. Nothing
 * else is accepted — an unsolicited hit on the callback URL is refused, which is what
 * stops an attacker from feeding us a `request_token`/`tokenId` for THEIR account and
 * silently rebinding this deployment's broker session to it (the "login CSRF" attack).
 *
 * THE TWO BROKERS GET DIFFERENT PROOFS, AND THE DIFFERENCE IS REAL
 *   • ZERODHA round-trips a value: `redirect_params=state=<nonce>` is appended by Kite to
 *     the registered redirect URL. So the callback presents the nonce and it is compared,
 *     in constant time, against the stored one. This is a full CSRF nonce.
 *   • DHAN does NOT round-trip anything of ours — the redirect carries only `tokenId`. So
 *     the proof available is weaker BY THE BROKER'S DESIGN, not by choice here: a pending
 *     Dhan login must exist, be unexpired, and it is consumed single-use. The window is
 *     therefore bounded to one in-flight login inside the TTL rather than to a matched
 *     secret. This asymmetry is documented rather than hidden, because pretending the two
 *     are equally strong is how a reviewer stops looking.
 *
 * SINGLE-USE, ALWAYS
 * `consume()` removes the entry before the caller does anything with it, so a replayed
 * callback — the operator hitting Back, a broker retrying the redirect, an attacker
 * resending a captured URL — finds nothing and is refused. A token exchange is a state
 * change and must happen at most once per initiation.
 *
 * BOUNDED BY CONSTRUCTION
 * At most ONE pending login per broker (a new start supersedes the previous one), so the
 * map holds at most two entries and no eviction policy or unbounded growth is possible.
 * Starting a second login for the same broker deliberately invalidates the first: the
 * operator's most recent intent is the real one.
 *
 * NO SECRETS LIVE HERE
 * The nonce is not a credential — it proves initiation, nothing more. No access token, no
 * request token, no app secret and no session token is ever stored in this module.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { BrokerId } from "../brokers/types.js";

/** How long a started login stays claimable. Enough for a password + 2FA, not a day. */
export const DEFAULT_PENDING_LOGIN_TTL_MS = 10 * 60_000;

/** One in-flight browser login. Never contains a credential. */
export interface PendingLogin {
  broker: BrokerId;
  /** The single-use nonce. Round-tripped by Zerodha; unused on the Dhan callback. */
  nonce: string;
  /** Operator role that started it, for the audit line. Never a session token. */
  startedBy: string;
  /** Dhan's consent id, when the broker issued one. Not a credential. */
  consentId: string | null;
  startedAtMs: number;
  expiresAtMs: number;
}

/** Why a callback was refused. Stable codes; safe to put in a redirect query string. */
export type PendingLoginRejection =
  | "no_pending_login"
  | "login_expired"
  | "state_mismatch"
  | "state_missing";

export type ConsumeResult =
  | { ok: true; pending: PendingLogin }
  | { ok: false; reason: PendingLoginRejection };

export interface PendingLoginStoreOptions {
  ttlMs?: number;
  /** Injected so tests can drive expiry deterministically. */
  now?: () => number;
  /** Injected so tests can assert an exact nonce. Must be cryptographically random. */
  mintNonce?: () => string;
}

/** A URL-safe 256-bit nonce. */
export function mintLoginNonce(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Compare two nonces without leaking their contents through timing.
 *
 * Length is compared first because `timingSafeEqual` throws on a length mismatch; that
 * comparison reveals only the length, which is a fixed constant here.
 */
export function nonceMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length || expected.length === 0) return false;
  return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(expected, "utf8"));
}

export class PendingLoginStore {
  private readonly entries = new Map<BrokerId, PendingLogin>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly mint: () => string;

  constructor(opts: PendingLoginStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_PENDING_LOGIN_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.mint = opts.mintNonce ?? mintLoginNonce;
  }

  /**
   * Record that an authenticated operator has started a login for `broker`.
   *
   * Supersedes any previous pending login for that broker. Returns the entry so the
   * caller can put the nonce into the consent URL.
   */
  start(broker: BrokerId, opts: { startedBy: string; consentId?: string | null }): PendingLogin {
    const startedAtMs = this.now();
    const pending: PendingLogin = {
      broker,
      nonce: this.mint(),
      startedBy: opts.startedBy,
      consentId: opts.consentId ?? null,
      startedAtMs,
      expiresAtMs: startedAtMs + this.ttlMs,
    };
    this.entries.set(broker, pending);
    return pending;
  }

  /**
   * Claim the pending login for `broker`, single-use.
   *
   * `presentedNonce` is the `state` from the redirect. Pass `null` for a broker that
   * cannot round-trip one (Dhan); pass the value for one that can (Zerodha). Requiring
   * the nonce is decided by `requireNonce`, NOT by whether the caller happened to supply
   * one — otherwise an attacker could downgrade the check simply by omitting `state`.
   */
  consume(
    broker: BrokerId,
    presentedNonce: string | null,
    opts: { requireNonce: boolean },
  ): ConsumeResult {
    const pending = this.entries.get(broker);
    if (!pending) return { ok: false, reason: "no_pending_login" };

    // Remove FIRST, unconditionally: every outcome below consumes the initiation, so a
    // failed attempt can never be retried against the same entry either.
    this.entries.delete(broker);

    if (this.now() > pending.expiresAtMs) return { ok: false, reason: "login_expired" };

    if (opts.requireNonce) {
      if (!presentedNonce) return { ok: false, reason: "state_missing" };
      if (!nonceMatches(presentedNonce, pending.nonce)) {
        return { ok: false, reason: "state_mismatch" };
      }
    }

    return { ok: true, pending };
  }

  /** Drop a broker's pending login without claiming it (e.g. an explicit logout). */
  clear(broker: BrokerId): void {
    this.entries.delete(broker);
  }

  /**
   * Whether a claimable login is in flight. Read-only; does NOT consume.
   *
   * Exposed for the status projection so the UI can say "waiting for the browser login
   * to finish" instead of leaving the operator staring at an unchanged card.
   */
  isPending(broker: BrokerId): boolean {
    const pending = this.entries.get(broker);
    if (!pending) return false;
    if (this.now() > pending.expiresAtMs) {
      // Expired entries are swept lazily on read; nothing else can claim them anyway.
      this.entries.delete(broker);
      return false;
    }
    return true;
  }
}
