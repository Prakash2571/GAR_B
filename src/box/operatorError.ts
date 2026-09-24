/**
 * A REFUSAL THE OPERATOR IS MEANT TO READ.
 *
 * WHY THIS EXISTS. The box HTTP boundary (`routes.ts`) no longer forwards `err.message` for arbitrary
 * errors: a `pg` failure carries the SQL it was running, a broker client carries whatever the broker
 * said, and neither belongs in a response or a log line just because the caller is authenticated. But
 * some of the most important messages in this module ARE written for the operator — "box_emergency_flatten
 * is disabled", "cannot flatten until broker state proves the durable quantity can be reduced safely" —
 * and losing those behind "Unexpected server error." during an emergency would be its own defect.
 *
 * So the distinction is made EXPLICIT instead of guessed at. Throwing this class means "I wrote this
 * sentence for a human, and it contains no internals"; throwing anything else means "this is a fault",
 * and the boundary will answer generically and log a bounded form. The compiler cannot check that
 * promise, so keep the rule simple: no interpolated error from another layer, no identifier the operator
 * did not already have, no credential, ever.
 *
 * Deliberately NOT the HTTP `ApiError` from `src/access/middleware.ts`: the engine and order manager are
 * domain code that must not depend on the transport. `routes.ts` maps this onto the wire format, which
 * keeps the one JSON error shape in one place.
 */
export class BoxOperatorError extends Error {
  /** HTTP status the boundary should use. */
  readonly status: number;
  /** Stable, machine-readable code, so a client never has to match on prose. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BoxOperatorError";
    this.status = status;
    this.code = code;
  }
}

/** The live order manager does not exist (paper deployment, or it has not been constructed). */
export function liveManagerUnavailable(): BoxOperatorError {
  return new BoxOperatorError(
    409,
    "live_manager_unavailable",
    "The live order manager is unavailable, so this control cannot act. In a paper deployment there " +
      "is nothing to act on; in a live one the engine has not finished establishing the broker session.",
  );
}
