/**
 * WHAT A FAILING BOX ROUTE IS ALLOWED TO SAY.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The box HTTP boundary used to answer any `Error` with `err.message` and log the whole error object.
 * Both leak, and these routes are the worst place for it: several are backed by PostgreSQL, and `pg`
 * attaches the failing statement — SQL text, bound parameters, table and constraint names — to its
 * errors. A database fault could therefore put schema internals and whatever values were being bound
 * into an authenticated response and into the process logs, while the rest of the application routed the
 * same class of error through the sanitized `errorHandler()`. Being authenticated does not entitle a
 * caller to the server's internals, and logs get shipped, grepped and pasted into tickets.
 *
 * This module holds the part of that decision worth testing on its own: what an UNEXPECTED failure is
 * allowed to become, and how far a BROKER's own words may travel. It deliberately imports nothing from
 * the transport (express), the broker client or the database layer, so the rules can be exercised
 * directly.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

import { sanitize } from "./executionFaults.js";

/** A response body plus its status, in the one shape the whole API uses (`ApiErrorBody` + status). */
export interface BoxFailureResponse {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/**
 * The answer for an UNEXPECTED failure. A fixed sentence with nothing derived from the error.
 *
 * Not "the message, but shorter" and not "the message, but redacted": an unexpected error is by
 * definition one nobody vetted for what it might contain, so the only safe amount to forward is none.
 * The operator-facing detail for expected refusals travels by a different route — see
 * `operatorError.ts` — which is exactly the distinction that was missing.
 */
export const GENERIC_BOX_FAILURE: BoxFailureResponse = {
  status: 500,
  code: "internal_error",
  message: "Unexpected server error.",
};

/** How much broker prose is forwarded. Long enough to be useful, short enough not to be a payload. */
export const MAX_BROKER_DETAIL_CHARS = 300;
/** How much of an unexpected error is written to the LOG (never to the client). */
export const MAX_LOG_DETAIL_CHARS = 300;

/**
 * A broker rejection, kept useful but not trusted.
 *
 * Operators genuinely need the broker's own words — "insufficient margin", "instrument not tradable" —
 * and a generic sentence there would make a refusal undiagnosable. But a broker message is still an
 * untrusted string from outside this process, and brokers have been known to echo request fields back,
 * so it is credential-redacted and length-bounded before it is forwarded. The STATUS is clamped into a
 * sane HTTP range so a broker cannot choose a nonsense one.
 */
export function brokerFailureResponse(status: number, brokerMessage: string): BoxFailureResponse {
  const detail = sanitize(String(brokerMessage ?? ""), MAX_BROKER_DETAIL_CHARS).trim();
  const usable = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
  return {
    status: usable,
    code: "broker_error",
    message:
      detail === ""
        ? "The broker rejected the request."
        : `The broker rejected the request: ${detail}`,
  };
}

/**
 * A statement this log line must never carry.
 *
 * Matched with enough shape to be sure it is SQL and not prose: `insert into`, `update … set`,
 * `delete from`, `select … from`. A bare "select" in a sentence ("could not select a broker") is
 * deliberately NOT matched — truncating ordinary messages would trade one unreadable log for another.
 */
const SQL_STATEMENT =
  /\b(insert\s+into\s|update\s+[\w".]+\s+set\s|delete\s+from\s|select\s[\s\S]{0,200}?\sfrom\s)/i;

/**
 * The single log line for an unexpected failure: FIRST line only, SQL-stripped, credential-redacted,
 * bounded. No stack, no `pg` metadata, no parameters.
 *
 * WHY THE FIRST LINE. `pg` puts its summary on line one and the failing statement plus the bound
 * parameters on the lines after it ("INSERT INTO … / parameters: id=…, account=…"). Truncating at a
 * character count — which is all the shared `boundedError` does — only hides that by accident: a short
 * statement fits inside the limit and is logged in full, parameters and all. Cutting at the newline is
 * the property, and the SQL check below covers a driver that inlines the statement on line one anyway.
 */
export function boxFailureLogLine(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  const firstLine = raw.split(/[\r\n]/, 1)[0] ?? "";
  const sqlAt = firstLine.search(SQL_STATEMENT);
  const withoutSql = sqlAt >= 0 ? `${firstLine.slice(0, sqlAt).trim()} [statement removed]` : firstLine;
  const redacted = sanitize(withoutSql.replace(/\s+/g, " ").trim(), MAX_LOG_DETAIL_CHARS);
  return redacted === "" ? "unknown error" : redacted;
}
