/**
 * REGRESSIONS FOR THE REMAINING REVIEW-2 LIMITATIONS.
 *
 * Reviews #1 and #2 each found defects in the previous round's fixes, so these pin the properties the
 * latest round claims — including the ones earlier rounds claimed and did not deliver.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { trustedClientIp, isTrustedProxyAddress } from "../../dist/clientIp.js";

const { loadBoxConfig } = await import("../../dist/box/config.js");

function withEnv(env, fn) {
  const saved = new Map();
  for (const key of Object.keys(env)) {
    saved.set(key, process.env[key]);
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ═══════════ the five economic knobs that still accepted negatives ═══════════ */

const ECONOMIC = [
  "MIN_BOX_GROSS_EDGE",
  "MIN_BOX_NET_EDGE",
  "BOX_PREFILTER_CHARGE_ALLOWANCE",
  "BOX_CONVERGENCE_FLOOR",
  "BOX_MIN_EXIT_NET_PNL",
];

test("L1: a NEGATIVE economic threshold is refused at boot", () => {
  // `BOX_MIN_EXIT_NET_PNL=-600` meant "auto-exit at a loss of up to 600". `MIN_BOX_NET_EDGE` negative
  // loosens the entry gate. These fed risk decisions through `num()`, which applies no floor at all.
  for (const key of ECONOMIC) {
    assert.throws(
      () => withEnv({ [key]: "-600" }, () => loadBoxConfig()),
      (error) => {
        assert.match(error.message, new RegExp(key));
        assert.match(error.message, /negative/i);
        return true;
      },
      `${key}="-600" must be refused`,
    );
  }
});

test("L2: valid and absent economic thresholds are unaffected", () => {
  const cfg = withEnv({ BOX_MIN_EXIT_NET_PNL: "600", MIN_BOX_NET_EDGE: "0" }, () => loadBoxConfig());
  assert.equal(cfg.minExitNetPnl, 600);
  assert.equal(cfg.minNetEdge, 0, "an explicit zero is a legitimate choice");
  const bare = withEnv(Object.fromEntries(ECONOMIC.map((k) => [k, undefined])), () => loadBoxConfig());
  assert.ok(bare.minGrossEdge > 0, "defaults still load");
});

/* ═══════════ trusted proxy: loopback-only by default, CIDR when named ═══════════ */

const reqFrom = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test("L3: a PRIVATE-address peer is no longer trusted by default", () => {
  // The in-VPC forgery path: every RFC1918 source used to be trusted unconditionally, and the process
  // binds every interface — so anything in the subnet could choose its own rate-limit bucket on the
  // passcode endpoint and forge the recorded session origin.
  for (const peer of ["10.0.0.5", "192.168.1.9", "172.16.4.4", "169.254.1.1"]) {
    assert.equal(isTrustedProxyAddress(peer), false, `${peer} must not be trusted by default`);
    assert.equal(
      trustedClientIp(reqFrom(peer, { "x-real-ip": "1.2.3.4" })),
      peer,
      "a forged header from an untrusted private peer must be ignored",
    );
  }
});

test("L4: loopback is still trusted, so the same-host nginx topology keeps working", () => {
  assert.equal(isTrustedProxyAddress("127.0.0.1"), true);
  assert.equal(isTrustedProxyAddress("::1"), true);
  assert.equal(isTrustedProxyAddress("::ffff:127.0.0.1"), true);
  assert.equal(
    trustedClientIp(reqFrom("127.0.0.1", { "x-real-ip": "198.51.100.7" })),
    "198.51.100.7",
  );
});

test("L5: BOX_TRUSTED_PROXY_IPS accepts an exact address AND a CIDR block", () => {
  withEnv({ BOX_TRUSTED_PROXY_IPS: "10.0.0.5" }, () => {
    assert.equal(isTrustedProxyAddress("10.0.0.5"), true, "an explicitly named proxy is trusted");
    assert.equal(isTrustedProxyAddress("10.0.0.6"), false, "and only that one");
  });
  withEnv({ BOX_TRUSTED_PROXY_IPS: "10.1.0.0/24" }, () => {
    assert.equal(isTrustedProxyAddress("10.1.0.7"), true, "inside the block");
    assert.equal(isTrustedProxyAddress("10.1.1.7"), false, "outside the block");
  });
});

test("L6: a malformed BOX_TRUSTED_PROXY_IPS entry grants nothing", () => {
  // It must only ever ADD trust for something an operator named, and never become a wildcard.
  for (const value of ["*", "0.0.0.0/0x", "hunter2", "10.0.0.0/99", "", "   ,  "]) {
    withEnv({ BOX_TRUSTED_PROXY_IPS: value }, () => {
      assert.equal(
        isTrustedProxyAddress("203.0.113.9"),
        false,
        `${JSON.stringify(value)} must not trust a public peer`,
      );
      assert.equal(isTrustedProxyAddress("10.0.0.5"), false);
    });
  }
});

test("L7: 0.0.0.0/0 is honoured only because an operator typed it explicitly", () => {
  // Documented consequence rather than a hidden default: naming the whole internet is a deliberate,
  // visible act, unlike the previous unconditional private-range trust.
  withEnv({ BOX_TRUSTED_PROXY_IPS: "0.0.0.0/0" }, () => {
    assert.equal(isTrustedProxyAddress("203.0.113.9"), true);
  });
});
