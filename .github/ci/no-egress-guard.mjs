/**
 * CI egress guard — FAIL-CLOSED network interceptor for the test job.
 *
 * WHY THIS FILE EXISTS
 * The CI workflow (`.github/workflows/ci.yml`) claims the test suite "never
 * contacts a real broker". That claim is only trustworthy if something ENFORCES
 * it. This loader is that something: it is injected into every test suite via
 *   NODE_OPTIONS=--import <this file>
 * and it wraps every outbound-network primitive Node offers so that ANY request
 * to a non-loopback host throws immediately. A test that reaches
 * images.dhan.co / api.kite.trade / auth.dhan.co / calspread.online (the live
 * broker endpoints the predecessor suite used) turns the build RED instead of
 * quietly making 24 real HTTPS calls per run.
 *
 * WHY IT DOES NOT FIGHT THE TEST HELPERS
 * The token/access suites drive LOCAL mock HTTP servers on 127.0.0.1 (see
 * tests/tokens/helpers.mjs). Those are loopback and are explicitly ALLOWED. The
 * PostgreSQL/MongoDB drivers connect to 127.0.0.1 too (DATABASE_URL / MONGODB_URI
 * both point at 127.0.0.1). So the guard allows loopback and blocks everything
 * else — it constrains the destination, not the transport, so it composes with
 * any in-test fetch stub the suite installs rather than replacing it.
 *
 * ALLOWED DESTINATIONS (loopback only):
 *   127.0.0.0/8   (127.0.0.1 … 127.255.255.255)
 *   ::1           (IPv6 loopback)
 *   localhost     (resolves to loopback on the runner)
 *
 * On a violation it prints a single grep-able marker line to stderr —
 *   CI-EGRESS-GUARD: BLOCKED <method> <url>
 * so that even if a suite swallows the thrown error, the workflow can still fail
 * on the marker (defence in depth; see the "Assert the egress guard armed and
 * blocked nothing" step in ci.yml).
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const MARKER = "CI-EGRESS-GUARD";

/** Loopback host test. Accepts hostnames and bare IPs; brackets stripped for IPv6. */
function isLoopbackHost(hostRaw) {
  if (!hostRaw) return false;
  let host = String(hostRaw).trim().toLowerCase();
  // Strip an optional [..] IPv6 bracket wrapper and any :port that slipped in.
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) host = host.slice(1, end);
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::ffff:127.0.0.1") return true;
  // IPv4 loopback block 127.0.0.0/8.
  if (net.isIPv4(host)) {
    return host.startsWith("127.");
  }
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  if (host.startsWith("::ffff:")) {
    const v4 = host.slice("::ffff:".length);
    return net.isIPv4(v4) && v4.startsWith("127.");
  }
  return false;
}

function refuse(method, target) {
  const line = `${MARKER}: BLOCKED ${method} ${target}`;
  // Print the marker FIRST so it lands even if the throw is later swallowed.
  process.stderr.write(line + "\n");
  const err = new Error(
    `${line}\n` +
      `A test attempted a network request to a NON-LOOPBACK host. CI is hermetic: ` +
      `only 127.0.0.0/8, ::1 and localhost are permitted. If you need to exercise a ` +
      `broker endpoint, drive a local mock on 127.0.0.1 (see tests/tokens/helpers.mjs).`,
  );
  err.code = "CI_EGRESS_BLOCKED";
  return err;
}

/** Extract a hostname from the many shapes fetch/http/https accept. */
function hostFromFetchInput(input) {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input && typeof input === "object") {
      if (typeof input.url === "string") return new URL(input.url).hostname; // Request
      if (typeof input.href === "string") return new URL(input.href).hostname; // URL
    }
  } catch {
    // An unparseable target is treated as non-loopback → refused (fail-closed).
    return null;
  }
  return null;
}

// ── 1. globalThis.fetch (the primary transport for Dhan + Kite) ─────────────────
if (typeof globalThis.fetch === "function") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const host = hostFromFetchInput(input);
    if (!isLoopbackHost(host)) {
      const shown =
        typeof input === "string"
          ? input
          : input && input.url
            ? input.url
            : String(input);
      const method = (init && init.method) || (input && input.method) || "GET";
      throw refuse(method, shown);
    }
    return realFetch.call(this, input, init);
  };
}

// ── 2. node:http / node:https request+get (defence in depth) ────────────────────
function guardAgentModule(mod, defaultProtocol) {
  const wrap = (orig) =>
    function guarded(arg1, arg2, arg3) {
      // Signatures: (url[, options][, cb]) OR (options[, cb]).
      let host = null;
      let method = "GET";
      if (typeof arg1 === "string" || (arg1 && typeof arg1.href === "string")) {
        try {
          host = new URL(arg1.href ?? arg1).hostname;
        } catch {
          host = null;
        }
        if (arg2 && typeof arg2 === "object") method = arg2.method || method;
      } else if (arg1 && typeof arg1 === "object") {
        host = arg1.hostname || arg1.host || null;
        method = arg1.method || method;
      }
      if (!isLoopbackHost(host)) {
        throw refuse(method, `${defaultProtocol}//${host ?? "<unknown>"}`);
      }
      return orig.call(this, arg1, arg2, arg3);
    };
  mod.request = wrap(mod.request);
  mod.get = wrap(mod.get);
}
guardAgentModule(http, "http:");
guardAgentModule(https, "https:");

// ── 3. Raw sockets (last-resort catch-all) ──────────────────────────────────────
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(options, ...rest) {
  let host = null;
  if (options && typeof options === "object" && !Array.isArray(options)) {
    host = options.host || options.hostname || null;
  } else if (Array.isArray(options)) {
    // (port, host, cb) array form used internally — host is the 2nd entry.
    host = typeof options[1] === "string" ? options[1] : null;
  } else if (typeof rest[0] === "string") {
    host = rest[0];
  }
  // A connect with no host is a loopback/pipe/local connect (host defaults to
  // localhost); only refuse an explicit non-loopback host.
  if (host !== null && !isLoopbackHost(host)) {
    throw refuse("CONNECT", `socket://${host}`);
  }
  return realConnect.call(this, options, ...rest);
};

const realTlsConnect = tls.connect;
tls.connect = function guardedTlsConnect(...args) {
  let host = null;
  const first = args[0];
  if (first && typeof first === "object") {
    host = first.host || first.servername || null;
  } else if (typeof args[1] === "string") {
    host = args[1];
  }
  if (host !== null && !isLoopbackHost(host)) {
    throw refuse("TLS", `tls://${host}`);
  }
  return realTlsConnect.apply(this, args);
};

process.stderr.write(`${MARKER}: armed (loopback-only egress)\n`);
