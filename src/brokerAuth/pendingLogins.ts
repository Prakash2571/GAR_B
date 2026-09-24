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
  /**
   * When a token exchange for this initiation started, or null when none is running.
   *
   * This is what makes the claim single-use WITHOUT destroying the initiation up front: while a claim is
   * outstanding nothing else may claim the same entry (so a replay cannot run a second exchange), and if
   * that exchange fails the claim is released rather than the entry deleted. Lapses after
   * {@link CLAIM_LAPSE_MS} so a crashed exchange cannot lock an operator out.
   */
  claimedAtMs: number | null;
}

/** Why a callback was refused. Stable codes; safe to put in a redirect query string. */
export type PendingLoginRejection =
  | "no_pending_login"
  | "login_expired"
  | "state_mismatch"
  | "state_missing"
  /** A token exchange for this initiation is already running; a second caller must not start one. */
  | "login_in_progress";

export type ConsumeResult =
  | { ok: true; pending: PendingLogin }
  | { ok: false; reason: PendingLoginRejection };

/**
 * A claim on one initiation: the right to attempt ONE token exchange against it.
 *
 * Opaque on purpose — a caller may only hand it back to {@link PendingLoginStore.commit} or
 * {@link PendingLoginStore.release}. It carries the entry for the audit line and the nonce as the key.
 */
export interface PendingLoginClaim {
  readonly pending: PendingLogin;
  readonly nonce: string;
  readonly claimedAtMs: number;
}

export type ClaimResult =
  | { ok: true; claim: PendingLoginClaim }
  | { ok: false; reason: PendingLoginRejection };

/**
 * How long one in-flight exchange may hold a claim before the initiation becomes claimable again.
 *
 * Without a lapse, a process that died mid-exchange — or an exchange that hangs on a broker socket —
 * would leave the operator's initiation locked until its TTL, turning a crash into the very
 * denial-of-login this protocol exists to prevent. Generous next to a token exchange (one HTTPS call)
 * and short next to the ten-minute login TTL.
 */
export const CLAIM_LAPSE_MS = 60_000;

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
      claimedAtMs: null,
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

  /** Is this entry free to be claimed? A lapsed claim counts as free — see {@link CLAIM_LAPSE_MS}. */
  private claimable(entry: PendingLogin): boolean {
    if (entry.claimedAtMs === null) return true;
    return this.now() - entry.claimedAtMs >= CLAIM_LAPSE_MS;
  }

  /**
   * ─────────────────────────────────────────────────────────────────────────────────────────────────
   * CLAIM an initiation for ONE token exchange, WITHOUT spending it yet.
   *
   * WHY THIS REPLACED "DELETE, THEN EXCHANGE". The callback is necessarily unauthenticated (the session
   * cookie is SameSite=Strict, so the browser sends nothing when arriving from the broker). For Zerodha
   * that is fine: the nonce comes back and proves the caller holds it. For DHAN the broker round-trips
   * nothing of ours, so any caller presenting a non-empty `tokenId` reached the store — and the store
   * then DELETED the operator's newest initiation before the exchange was attempted. So a junk callback,
   * fired while someone was signing in, consumed their attempt; their real redirect arrived moments
   * later, found nothing claimable, and was told its login had expired. A denial-of-login, repeatable by
   * anyone who could reach the URL.
   *
   * Deleting first was not protecting anything either. The property that matters is that ONE SUCCESSFUL
   * EXCHANGE happens per initiation, and deleting up front does not provide it — it only guarantees that
   * a FAILED exchange also destroys the initiation, which is pure loss.
   *
   * So the claim is now two-phase. A claim reserves the entry: nothing else may claim it while an
   * exchange is in flight, which is what stops a replay running a second exchange. Then
   *   · {@link commit} deletes it — the initiation is spent, and a replayed callback finds nothing;
   *   · {@link release} un-reserves it — the caller proved nothing, so the real redirect can still use it.
   * A claim that is never resolved lapses, so a crash cannot lock an operator out.
   *
   * `presentedNonce` is the `state` from the redirect. Pass `null` for a broker that cannot round-trip
   * one (Dhan); pass the value for one that can (Zerodha). Requiring the nonce is decided by
   * `requireNonce`, NOT by whether the caller happened to supply one — otherwise an attacker could
   * downgrade the check simply by omitting `state`.
   * ─────────────────────────────────────────────────────────────────────────────────────────────────
   */
  claim(
    broker: BrokerId,
    presentedNonce: string | null,
    opts: { requireNonce: boolean },
  ): ClaimResult {
    const existedAtAll = [...this.entries.values()].some((e) => e.broker === broker);
    const live = this.liveFor(broker); // also prunes the lapsed ones
    if (live.length === 0) {
      return { ok: false, reason: existedAtAll ? "login_expired" : "no_pending_login" };
    }

    if (opts.requireNonce) {
      /**
       * A FAILED PROOF MUST NOT CONSUME THE INITIATION. (See the long note that used to live in
       * `consume`: an unauthenticated caller with a wrong or absent `state` could otherwise destroy an
       * operator's in-flight sign-in, repeatably.) A caller that cannot present the nonce has proved
       * nothing and therefore claims nothing.
       */
      if (!presentedNonce) return { ok: false, reason: "state_missing" };
      const matched = live.find((entry) => nonceMatches(presentedNonce, entry.nonce));
      if (!matched) return { ok: false, reason: "state_mismatch" };
      // A matched nonce whose exchange is ALREADY running is a replay, not a new login. Refuse without
      // disturbing the exchange in flight.
      if (!this.claimable(matched)) return { ok: false, reason: "login_in_progress" };
      matched.claimedAtMs = this.now();
      return { ok: true, claim: { pending: matched, nonce: matched.nonce, claimedAtMs: matched.claimedAtMs } };
    }

    /**
     * DHAN: no nonce comes back, so the entries are indistinguishable and ANY claimable one authorises
     * this exchange. The most recent is chosen — with concurrent sign-ins the latest intent is the one
     * most likely being completed right now — and only that one is reserved, so a colleague's parallel
     * attempt is untouched.
     */
    const claimable = live.filter((entry) => this.claimable(entry));
    if (claimable.length === 0) {
      // Every live initiation already has an exchange running. Serialising here is what keeps an
      // unauthenticated flood from multiplying outbound token exchanges.
      return { ok: false, reason: "login_in_progress" };
    }
    const chosen = claimable[claimable.length - 1];
    if (chosen === undefined) return { ok: false, reason: "no_pending_login" };
    chosen.claimedAtMs = this.now();
    return { ok: true, claim: { pending: chosen, nonce: chosen.nonce, claimedAtMs: chosen.claimedAtMs } };
  }

  /**
   * SPEND the initiation: the exchange succeeded, so it must never be usable again.
   *
   * This is where single-use actually holds. Returns false when the entry has already gone (a lapsed
   * claim whose entry expired, or a `clear()` in between), which is not an error — there is simply
   * nothing left to spend.
   */
  commit(claim: PendingLoginClaim): boolean {
    const entry = this.entries.get(claim.nonce);
    if (entry === undefined) return false;
    this.entries.delete(claim.nonce);
    return true;
  }

  /**
   * UN-RESERVE the initiation: this attempt proved nothing, so the operator's login survives.
   *
   * Ignored when the claim has already lapsed and someone else holds one, so a slow failed exchange
   * cannot cancel a newer attempt's reservation.
   */
  release(claim: PendingLoginClaim): void {
    const entry = this.entries.get(claim.nonce);
    if (entry === undefined) return;
    if (entry.claimedAtMs !== claim.claimedAtMs) return;
    entry.claimedAtMs = null;
  }

  /**
   * Claim and immediately spend, in one call.
   *
   * Kept for callers that have nothing to do between the two halves. The HTTP callback must NOT use it:
   * it has a token exchange in between, and that exchange failing is exactly the case the two-phase
   * protocol exists for.
   */
  consume(
    broker: BrokerId,
    presentedNonce: string | null,
    opts: { requireNonce: boolean },
  ): ConsumeResult {
    const claimed = this.claim(broker, presentedNonce, opts);
    if (!claimed.ok) return { ok: false, reason: claimed.reason };
    this.commit(claimed.claim);
    return { ok: true, pending: claimed.claim.pending };
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
