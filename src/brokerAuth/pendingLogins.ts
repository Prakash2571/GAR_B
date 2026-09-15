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
 * CONCURRENT LOGINS ARE SUPPORTED, AND THAT IS THE POINT
 * Entries are keyed by NONCE, not by broker, so several operators (or several browsers) can
 * have a sign-in to the SAME broker in flight at once and each one completes on its own
 * nonce. This used to be one entry per broker, and the consequence was a genuine defect: two
 * people clicking "Connect Zerodha" within ten minutes of each other meant the second start
 * silently destroyed the first, and the first operator's redirect came back to
 * `state_mismatch` — an error that reads like tampering and was really just a colleague.
 *
 * The site is a shared console: anyone with the passcode is a legitimate operator, and the
 * broker session they establish is shared process state. Two of them signing in at the same
 * time is ordinary, not an anomaly to be refused.
 *
 * BOUNDED BY CONSTRUCTION
 * At most {@link MAX_PENDING_PER_BROKER} live entries per broker, oldest evicted first, and
 * lapsed entries are pruned on every read and write. So the map is hard-bounded at
 * `MAX_PENDING_PER_BROKER * 2` regardless of traffic — and only an AUTHENTICATED operator can
 * create one at all, since `login/start` sits behind `requireOperator`.
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

/**
 * How many sign-ins to the SAME broker may be in flight at once.
 *
 * Generous enough that a small team never collides, small enough that the store stays
 * trivially bounded. When the cap is reached the OLDEST entry is evicted, because the
 * newest intent is the one most likely still being acted on.
 */
export const MAX_PENDING_PER_BROKER = 8;

export class PendingLoginStore {
  /**
   * Keyed by NONCE so several logins to the same broker can coexist. The broker is a field
   * on the entry rather than the key, and every lookup filters on it — a nonce minted for
   * one broker can therefore never claim a login for the other.
   */
  private readonly entries = new Map<string, PendingLogin>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly mint: () => string;

  constructor(opts: PendingLoginStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_PENDING_LOGIN_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.mint = opts.mintNonce ?? mintLoginNonce;
  }

  /** Live (unexpired) entries for one broker, oldest first. Prunes lapsed ones as it goes. */
  private liveFor(broker: BrokerId): PendingLogin[] {
    const now = this.now();
    const live: PendingLogin[] = [];
    for (const entry of [...this.entries.values()]) {
      if (entry.broker !== broker) continue;
      if (now > entry.expiresAtMs) this.entries.delete(entry.nonce);
      else live.push(entry);
    }
    return live;
  }

  /**
   * Record that an authenticated operator has started a login for `broker`.
   *
   * Does NOT disturb another in-flight login for the same broker — see the header. Returns
   * the entry so the caller can put the nonce into the consent URL.
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

    // Prune lapsed entries first, so a quiet period never counts against the cap.
    const live = this.liveFor(broker);
    // Evict oldest-first until there is room for this one.
    for (let i = 0; i <= live.length - MAX_PENDING_PER_BROKER; i += 1) {
      const oldest = live[i];
      if (oldest) this.entries.delete(oldest.nonce);
    }

    this.entries.set(pending.nonce, pending);
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
    // Were there ANY entries for this broker, live or lapsed? Distinguishing that from "none
    // at all" is what lets an operator be told their attempt EXPIRED rather than that it
    // never happened.
    const existedAtAll = [...this.entries.values()].some((e) => e.broker === broker);
    const live = this.liveFor(broker); // also prunes the lapsed ones
    if (live.length === 0) {
      return { ok: false, reason: existedAtAll ? "login_expired" : "no_pending_login" };
    }

    if (opts.requireNonce) {
      /**
       * A FAILED PROOF MUST NOT CONSUME THE INITIATION.
       *
       * This originally deleted the entry before validating anything, on the reasoning that
       * a single-use claim should be spent whatever the outcome. That was a denial-of-service:
       * the callback is necessarily unauthenticated, so ANYONE who could reach it could send
       * one request with a wrong (or absent) `state` and destroy the operator's in-flight
       * sign-in — repeatably, and with an error message that blamed the operator's own
       * browser ("could not be matched to a request from this app").
       *
       * A caller that cannot present the nonce has proved nothing and therefore consumes
       * nothing; the entry stays claimable by the real redirect and otherwise lapses on its
       * TTL. Single-use still holds where it matters, because a MATCHED claim is spent below.
       */
      if (!presentedNonce) return { ok: false, reason: "state_missing" };
      // Matched against EVERY live entry for this broker, so one operator's redirect is
      // never refused because a colleague started a sign-in in the meantime. Each candidate
      // is compared in constant time; a nonce belonging to the other broker cannot match
      // because `live` is already filtered by broker.
      const matched = live.find((entry) => nonceMatches(presentedNonce, entry.nonce));
      if (!matched) return { ok: false, reason: "state_mismatch" };
      this.entries.delete(matched.nonce);
      return { ok: true, pending: matched };
    }

    /**
     * DHAN: no nonce comes back, so the entries are indistinguishable and ANY live one
     * authorises this exchange. The most recent is chosen — with concurrent sign-ins the
     * latest intent is the one most likely being completed right now — and only that one is
     * spent, so a colleague's parallel attempt survives.
     */
    const chosen = live[live.length - 1];
    if (!chosen) return { ok: false, reason: "no_pending_login" };
    this.entries.delete(chosen.nonce);
    return { ok: true, pending: chosen };
  }

  /** Drop ALL of a broker's pending logins without claiming them (e.g. an explicit logout). */
  clear(broker: BrokerId): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.broker === broker) this.entries.delete(entry.nonce);
    }
  }

  /**
   * Whether a claimable login is in flight. Read-only; does NOT consume.
   *
   * Exposed for the status projection so the UI can say "waiting for the browser login
   * to finish" instead of leaving the operator staring at an unchanged card.
   */
  isPending(broker: BrokerId): boolean {
    // Lapsed entries are swept lazily on read; nothing could claim them anyway.
    return this.liveFor(broker).length > 0;
  }
}
