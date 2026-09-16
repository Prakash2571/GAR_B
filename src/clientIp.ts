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
  /*
   * LOOPBACK ONLY, BY DEFAULT.
   *
   * This used to trust every RFC1918 / link-local / unique-local source unconditionally. Combined with
   * a process that binds every interface, that meant ANY host able to reach the backend port from a
   * private address could send its own `X-Real-IP` and choose its own rate-limit bucket on the passcode
   * endpoint — unlimited brute force against the credential guarding the whole operator surface — and
   * poison the persisted session origin. On EC2 the private subnet IS that range, so the only thing
   * standing in the way was a security group enforced nowhere in code.
   *
   * The documented topology is nginx terminating on the same host, so loopback is the honest default.
   * A proxy anywhere else must be named explicitly in `BOX_TRUSTED_PROXY_IPS`, which now accepts CIDR
   * as well as exact addresses so that a real deployment can express it.
   */
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  return configuredProxies().some((entry) => matchesProxyEntry(ip, entry));
}

/** Trusted-proxy entries from the environment: exact addresses or IPv4 CIDR blocks. */
function configuredProxies(): string[] {
  return (process.env.BOX_TRUSTED_PROXY_IPS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
}

/** Does `ip` match one configured entry? Supports `a.b.c.d` and `a.b.c.d/nn` (IPv4). */
function matchesProxyEntry(ip: string, entry: string): boolean {
  const slash = entry.indexOf("/");
  if (slash === -1) return canonical(entry) === ip;
  const network = canonical(entry.slice(0, slash));
  const bits = Number(entry.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toLong = (value: string): number | null => {
    const parts = value.split(".");
    if (parts.length !== 4) return null;
    let out = 0;
    for (const part of parts) {
      const octet = Number(part);
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
      out = out * 256 + octet;
    }
    return out;
  };
  const a = toLong(ip);
  const b = toLong(network);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
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
