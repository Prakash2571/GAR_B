/**
 * TRUSTED CLIENT-IP DERIVATION — one implementation, for every caller.
 *
 * THE DEFECT THIS MODULE REPLACES. Two independent copies of this logic (the rate limiter and the
 * access-session audit breadcrumb) both did:
 *
 *     const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
 *     const ip = fwd || req.socket.remoteAddress || "unknown";
 *
 * On this deployment that reads **precisely the attacker-controlled value**. `deploy/nginx.conf` sets
 * `X-Forwarded-For: $proxy_add_x_forwarded_for`, and that nginx variable APPENDS the real peer address
 * to whatever the client already sent. So a client sending `X-Forwarded-For: 1.2.3.4` produces
 * `1.2.3.4, <real client ip>` at the backend, and `[0]` is the forged element. Position 0 is never
 * trustworthy here; the RIGHTMOST entry — the one nginx itself appended — is.
 *
 * Consequences of getting it wrong: rotating a header reset the passcode-attempt budget on
 * `POST /api/access/verify` (unlimited brute force against the credential that guards the whole
 * operator surface), and the forged value was PERSISTED as the session's origin IP, poisoning the
 * audit trail.
 *
 * TWO FURTHER TRAPS, both closed here:
 *
 *   - Node yields a STRING ARRAY when a header appears more than once. `.split` is undefined on an
 *     array, so sending two `X-Forwarded-For` headers threw a TypeError *before* the limiter
 *     incremented its counter — a bypass needing no forged value at all. Arrays are normalised.
 *   - `app.set("trust proxy", true)` was configured but NEITHER path read `req.ip`, so the setting
 *     protected nothing; and `true` means "trust every hop", which would have left `req.ip` equally
 *     forgeable. This module does not depend on that setting at all.
 *
 * THE MODEL: forwarding headers are believed ONLY when the connection itself arrives from a trusted
 * proxy. A request that reaches the backend port directly — bypassing nginx — has fully
 * client-controlled headers, so they are ignored entirely and the socket address is used.
 */

import type { Request } from "express";

/** Normalise a header that Node may present as a string or an array of strings. */
function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** Strip an IPv6-mapped IPv4 prefix so `::ffff:127.0.0.1` compares equal to `127.0.0.1`. */
function canonical(address: string): string {
  const trimmed = address.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return (mapped?.[1] ?? trimmed).toLowerCase();
}

/**
 * Is this peer address one of OUR proxies, i.e. may its forwarding headers be believed?
 *
 * Loopback plus the RFC1918 / link-local / unique-local ranges, because the documented topology is
 * nginx terminating on the same host (or the same private network) and proxying to the backend port.
 * A public source address is never treated as a trusted proxy.
 *
 * `BOX_TRUSTED_PROXY_IPS` may name additional exact addresses (comma-separated) for a topology where
 * the proxy sits on a public address. It can only ever ADD trust for addresses an operator has named;
 * there is no wildcard.
 */
export function isTrustedProxyAddress(address: string | undefined): boolean {
  if (!address) return false;
  const ip = canonical(address);
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;
  const configured = (process.env.BOX_TRUSTED_PROXY_IPS ?? "")
    .split(",")
    .map((entry) => canonical(entry))
    .filter((entry) => entry !== "");
  return configured.includes(ip);
}

/**
 * The client address to attribute this request to. Never caller-controlled.
 *
 * Returns `"unknown"` only when the socket has no address at all, which keeps the caller's key
 * function total.
 */
export function trustedClientIp(req: Pick<Request, "headers" | "socket">): string {
  const peer = req.socket?.remoteAddress;
  // DIRECT CONNECTION (or an untrusted source): every forwarding header is attacker-controlled, so
  // none of them is consulted. This is the case that made the old code exploitable.
  if (!isTrustedProxyAddress(peer)) return peer ? canonical(peer) : "unknown";

  // nginx REPLACES `X-Real-IP` with `$remote_addr` (`proxy_set_header` overwrites unconditionally),
  // so behind a trusted proxy it is the cleanest and least ambiguous signal.
  const realIp = headerValues(req.headers["x-real-ip"]);
  if (realIp.length > 0) return canonical(realIp[realIp.length - 1] as string);

  // Otherwise fall back to the RIGHTMOST `X-Forwarded-For` element — the hop our own proxy appended.
  const forwarded = headerValues(req.headers["x-forwarded-for"]);
  if (forwarded.length > 0) return canonical(forwarded[forwarded.length - 1] as string);

  return peer ? canonical(peer) : "unknown";
}
