/**
 * MALFORMED AND BLANK DURATION VARIABLES MUST NOT DISABLE THE TIMER THEY CONFIGURE.
 *
 * `Number(process.env.X ?? fallback)` only falls back on `undefined`/`null`. A variable that
 * is PRESENT but blank or malformed skips the fallback and coerces to a value that defeats
 * the timer:
 *
 *   BROKER_TOKEN_REQUEST_TIMEOUT_MS=      → Number("")    === 0   → abort at 0 ms
 *   BROKER_TOKEN_REQUEST_TIMEOUT_MS=10s   → Number("10s") === NaN → abort at 0 ms (setTimeout coerces)
 *   BROKER_TOKEN_POLL_INTERVAL_MS=        → Number("")    === 0   → retry with no delay
 *
 * `.env.example` ships both keys WITH values, so blanking one is a single ordinary edit
 * away — deleting a value is how operators habitually "comment out" a setting.
 *
 * Consequences these tests pin down:
 *   1. A zero/NaN request timeout aborts every token fetch before it can complete, and the
 *      failure is reported as an ordinary retryable timeout. Cost: the whole trading day's
 *      token, with nothing in the logs to distinguish it from a flaky provider.
 *   2. A zero/NaN poll interval turns the retry schedule into an unbounded request loop
 *      against a third-party endpoint. `Math.max(0, NaN)` is `NaN`, and `setTimeout(fn, NaN)`
 *      fires on the next tick — so clamping only the low end does not save it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchBrokerToken } from "../../dist/tokens/tokenProviderClient.js";

/** The exact expression that shipped, so the test fails if anyone reintroduces it. */
const legacyParse = (raw, fallback) => Number(raw ?? fallback);

test("the shipped `Number(env ?? fallback)` idiom really does produce timer-defeating values", () => {
  // Blank and whitespace coerce to 0 — a real, silent, timer-disabling value.
  assert.equal(legacyParse("", 10_000), 0);
  assert.equal(legacyParse("   ", 10_000), 0);
  // Malformed coerces to NaN, which setTimeout treats as 0.
  assert.ok(Number.isNaN(legacyParse("abc", 10_000)));
  assert.ok(Number.isNaN(legacyParse("10s", 10_000)));
  // And NaN survives a low-end clamp, which is why clamping alone is not a fix.
  assert.ok(Number.isNaN(Math.max(0, legacyParse("abc", 10_000))));
  // Only a genuinely absent variable reaches the fallback.
  assert.equal(legacyParse(undefined, 10_000), 10_000);
});

/**
 * The provider client is the second line of defence: even handed a hostile config object it
 * must not abort instantly. A 0/NaN timeout previously aborted before `fetch` could resolve,
 * turning every attempt into "provider request timed out".
 */
for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`fetchBrokerToken ignores a non-positive/non-finite requestTimeoutMs (${String(bad)}) instead of aborting instantly`, async () => {
    let sawAbortedSignal = null;

    const fetchImpl = async (_url, init) => {
      // If the timeout were 0/NaN the abort would already have fired by now.
      await new Promise((resolve) => setTimeout(resolve, 5));
      sawAbortedSignal = init?.signal?.aborted === true;
      return new Response(
        JSON.stringify({ authenticated: true, api_key: "key", access_token: "tok" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await fetchBrokerToken(
      "zerodha",
      {
        url: "http://127.0.0.1:9/token",
        passcode: "pc",
        requestTimeoutMs: bad,
        requireHttps: false,
      },
      Date.now(),
      fetchImpl,
    );

    assert.equal(sawAbortedSignal, false, "the request must not be aborted before it is sent");
    assert.notEqual(
      result.reason,
      "provider request timed out",
      `a ${String(bad)} timeout must not surface as a timeout`,
    );
  });
}

test("a well-formed short timeout still aborts — the guard did not disable timeouts altogether", async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });

  const result = await fetchBrokerToken(
    "zerodha",
    {
      url: "http://127.0.0.1:9/token",
      passcode: "pc",
      requestTimeoutMs: 10,
      requireHttps: false,
    },
    Date.now(),
    fetchImpl,
  );

  assert.equal(result.kind, "retry");
  assert.equal(result.reason, "provider request timed out");
});
