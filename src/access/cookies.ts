/**
 * Hand-rolled cookie parsing and serialisation.
 *
 * WHY NO `cookie` / `cookie-parser` DEPENDENCY
 * GTS Box deliberately keeps its dependency surface tiny (see package.json:
 * express, pg, mongodb, dotenv and nothing else). The session gate needs exactly
 * two things — read one named cookie off an incoming request, and emit two
 * `Set-Cookie` headers with the right security attributes — so both are written
 * here rather than pulled in.
 *
 * THE COOKIES
 *  - the SESSION cookie is HttpOnly, so JS cannot read it and it cannot be
 *    exfiltrated by an XSS payload; it is the bearer credential the server trusts.
 *  - the CSRF cookie is intentionally NOT HttpOnly, so the SPA can READ it and
 *    echo its value in the `x-csrf-token` request header. Its ONLY purpose is to
 *    let JS recover the token after a page reload — it is a convenience, NOT a
 *    credential. The server verifies the token from the HEADER and never accepts
 *    the cookie as a substitute: a cross-site POST would carry the cookie
 *    automatically, so honouring the cookie would defeat the check, whereas the
 *    attacker's page cannot READ our cookie to forge the header. That header value
 *    is compared against the session-bound CSRF digest server-side, which is what
 *    defeats a cross-site POST.
 */

import type { Request, Response } from "express";
import type { AppConfig } from "../config.js";

export interface CookieAttributes {
  httpOnly: boolean;
  /** Omitted only in non-production over http — see cookieSecurity(). */
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
  path: string;
  /** Max-Age in seconds. Omit for a session cookie; we always set it. */
  maxAgeSeconds?: number;
}

/**
 * Read a single cookie value from the request `Cookie` header.
 *
 * Returns `undefined` when the header or the named cookie is absent. Values are
 * URL-decoded because `serializeCookie` URL-encodes on the way out; a decode
 * failure yields the raw value rather than throwing, so a malformed cookie can
 * never crash the auth path.
 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  // A Cookie header is `name=value; name2=value2`. Split on ';' then on the FIRST
  // '=' only, because a base64url/JSON value can itself contain '='.
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * Decide the `Secure` attribute.
 *
 * In production the cookie is ALWAYS Secure — the session is a bearer credential
 * and must not travel over plain http. The single, explicit exception is a
 * non-production (development/test) deployment served over http, where a Secure
 * cookie would simply never be stored by the browser and local development would
 * be impossible. That relaxation is gated purely on `config.isProduction === false`
 * and on nothing else: an unset or misread NODE_ENV resolves to non-production in
 * config.ts, but production is the only value that tightens, never relaxes.
 */
export function cookieIsSecure(config: AppConfig): boolean {
  if (config.isProduction) return true;
  // Non-production: allow http local development. This is the ONLY place Secure
  // may be omitted, and it is a deliberate, commented decision.
  return false;
}

/** Serialise one Set-Cookie header value. */
export function serializeCookie(name: string, value: string, attrs: CookieAttributes): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${attrs.path}`);
  parts.push(`SameSite=${attrs.sameSite}`);
  if (attrs.httpOnly) parts.push("HttpOnly");
  if (attrs.secure) parts.push("Secure");
  if (typeof attrs.maxAgeSeconds === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(attrs.maxAgeSeconds))}`);
  }
  return parts.join("; ");
}

/** Append a Set-Cookie header without clobbering any already present. */
function appendSetCookie(res: Response, value: string): void {
  res.append("Set-Cookie", value);
}

/**
 * Attach the session + CSRF cookies to a response after a successful verify.
 *
 * Session cookie: HttpOnly, Secure (per cookieIsSecure), SameSite=Strict, Path=/.
 * CSRF cookie:     NOT HttpOnly (JS must read it), otherwise identical.
 */
export function setSessionCookies(
  res: Response,
  config: AppConfig,
  opts: { sessionToken: string; csrfToken: string; csrfCookieName: string; maxAgeSeconds: number },
): void {
  const secure = cookieIsSecure(config);
  appendSetCookie(
    res,
    serializeCookie(config.sessionCookieName, opts.sessionToken, {
      httpOnly: true,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAgeSeconds: opts.maxAgeSeconds,
    }),
  );
  appendSetCookie(
    res,
    serializeCookie(opts.csrfCookieName, opts.csrfToken, {
      // Deliberately readable by JS so the SPA can echo it in the CSRF header.
      httpOnly: false,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAgeSeconds: opts.maxAgeSeconds,
    }),
  );
}

/** Clear both cookies (logout, or on an invalid/expired session). */
export function clearSessionCookies(
  res: Response,
  config: AppConfig,
  csrfCookieName: string,
): void {
  const secure = cookieIsSecure(config);
  // Max-Age=0 expires the cookie immediately; the same attributes must be echoed
  // for the browser to match and delete the original.
  appendSetCookie(
    res,
    serializeCookie(config.sessionCookieName, "", {
      httpOnly: true,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAgeSeconds: 0,
    }),
  );
  appendSetCookie(
    res,
    serializeCookie(csrfCookieName, "", {
      httpOnly: false,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAgeSeconds: 0,
    }),
  );
}

/** The CSRF cookie name is derived from the session cookie name, kept in one place. */
export function csrfCookieName(config: AppConfig): string {
  return `${config.sessionCookieName}_csrf`;
}
