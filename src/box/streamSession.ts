/**
 * SESSION LIFETIME FOR A LONG-LIVED STREAM.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES. Every other route in this backend is authenticated per REQUEST: the cookie
 * is validated against PostgreSQL on the way in, so a revoked or expired session stops working on its
 * next call. An SSE stream has exactly one request, at the beginning, and then lives for hours. So the
 * authentication check that protects `/api/box/status` protected `/api/box/stream` only at the instant
 * it opened, and after that the engine held a bare `Response` object with no idea whose it was.
 *
 * The consequence: a client that simply KEPT ITS CONNECTION OPEN went on receiving full state snapshots
 * — positions, opportunities, order activity — after its session was revoked by logout, and after the
 * session's hard expiry had passed. A browser closing the stream on logout is the normal case, not an
 * enforcement mechanism: it is entirely client-side, and anything that is not a browser simply does not
 * do it. The 20-second heartbeat that could have noticed only ever wrote a ping.
 *
 * WHAT THIS DOES. It answers one question — "may this stream still run?" — and it is the only thing
 * that answers it, so the route cannot drift from the policy:
 *
 *   EXPIRY is checked LOCALLY and FAILS CLOSED. The session's `expires_at` came from PostgreSQL when
 *   the stream opened and there is no sliding renewal, so the deadline is already known and needs no
 *   query. A stream may therefore never outlive its session even if the database is unreachable.
 *
 *   REVOCATION requires asking, because it is an event that happens after the fact and leaves no trace
 *   the stream could have cached. Each check is one indexed lookup on the heartbeat's cadence, which is
 *   what makes it BOUNDED: no listener, no polling loop of its own, one query per live stream per
 *   heartbeat.
 *
 *   A CHECK THAT CANNOT COMPLETE IS TOLERATED, BUT ONLY FOR A WHILE. Killing every open stream the
 *   moment PostgreSQL hiccups would take the operator's live view away exactly when they most need to
 *   watch — and an unreadable database is not evidence that anyone was revoked. So consecutive failures
 *   are tolerated for `graceMs` and then the stream is closed, because past that point "this session is
 *   still valid" has stopped being something this process can claim. The grace window is a deliberate,
 *   bounded trade between availability and enforcement, not an oversight.
 *
 * WHAT IT DOES NOT DO. It does not make a revocation instantaneous: a client can receive at most one
 * heartbeat interval of snapshots after its session dies. Closing that window entirely would need the
 * revoking request to notify open streams in-process, which does not help across instances and is not
 * what bounds the exposure here. The bound is the heartbeat, and it is stated rather than implied.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Why a stream must stop, or that it may continue. */
export type StreamSessionVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "expired"; readonly detail: string }
  | { readonly kind: "revoked"; readonly detail: string }
  | { readonly kind: "unverifiable"; readonly detail: string };

/** How long consecutive failed revocation checks are tolerated before the stream is closed. */
export const DEFAULT_STREAM_SESSION_GRACE_MS = 120_000;

export interface StreamSessionSentryDeps {
  /**
   * The session's hard expiry, as a wall-clock instant in ms.
   *
   * A wall clock is correct HERE and nowhere else in this codebase's guards: this is a comparison of two
   * points on the same absolute timeline (`expires_at` from PostgreSQL against local now), not a duration
   * measurement. The execution lease is the opposite case and deliberately uses a monotonic source — see
   * `executionLease.ts`. Clock skew between this host and the database shortens or lengthens the stream's
   * life by the size of the skew, which is acceptable for a read-only view and is why expiry is a hard
   * backstop rather than the only check.
   */
  readonly expiresAtMs: number;
  /**
   * Is the session still live? `false` means revoked or gone; a REJECTION means "could not tell".
   *
   * The distinction matters: a definite `false` closes the stream immediately, while a rejection starts
   * the grace window. Collapsing the two would either ignore revocations or disconnect every operator
   * during a database blip.
   */
  readonly isSessionLive: () => Promise<boolean>;
  readonly now?: () => number;
  readonly graceMs?: number;
}

export class StreamSessionSentry {
  private readonly deps: StreamSessionSentryDeps;
  /** When the current run of consecutive failures began. Null whenever the last check succeeded. */
  private unverifiableSince: number | null = null;

  constructor(deps: StreamSessionSentryDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private graceMs(): number {
    return Math.max(0, this.deps.graceMs ?? DEFAULT_STREAM_SESSION_GRACE_MS);
  }

  /** Whether the session's hard deadline has passed. Local, so it works with no database at all. */
  expired(): boolean {
    return this.now() >= this.deps.expiresAtMs;
  }

  async check(): Promise<StreamSessionVerdict> {
    // EXPIRY FIRST, and without a query. There is no sliding renewal, so this is knowable offline and
    // must hold even when the revocation check cannot run at all.
    if (this.expired()) {
      return {
        kind: "expired",
        detail: "the operator session reached its hard expiry while this stream was open",
      };
    }

    let live: boolean;
    try {
      live = await this.deps.isSessionLive();
    } catch {
      const since = this.unverifiableSince ?? this.now();
      this.unverifiableSince = since;
      const outstandingMs = this.now() - since;
      if (outstandingMs < this.graceMs()) {
        // Tolerated: keep streaming. The operator's live view is worth more than a hair-trigger
        // disconnect, and a failed query is not evidence of a revocation.
        return { kind: "ok" };
      }
      return {
        kind: "unverifiable",
        detail:
          `the operator session could not be re-verified for ${Math.round(outstandingMs / 1000)}s ` +
          "(the session store is unreachable), which is longer than this stream may run unverified",
      };
    }

    this.unverifiableSince = null;
    if (!live) {
      return {
        kind: "revoked",
        detail: "the operator session was revoked or is no longer valid",
      };
    }
    return { kind: "ok" };
  }
}
