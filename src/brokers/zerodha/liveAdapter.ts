/**
 * Assembles the Zerodha LIVE order adapter, outside the Box strategy.
 *
 * This is the code that used to sit inside `BoxEngine`'s constructor. Moving it
 * here is the whole point of the broker-neutral refactor: the strategy asks a
 * factory for "the active broker's execution adapter" and gets one, without ever
 * importing a transport or naming a venue.
 *
 * The behaviour is UNCHANGED from what the engine did inline — same transport,
 * same config mapping, same fail-closed checks, same error messages — so Zerodha
 * live execution is bit-for-bit what it was.
 */

import type { KiteClient } from "../../kite.js";
import type { BrokerAdapter } from "../../box/brokerAdapter.js";
import type { BoxLiveAdapterFactory } from "../../box/brokerContext.js";
import {
  KiteBrokerAdapter,
  KiteHttpTransport,
  kiteAdapterConfigFromBoxConfig,
} from "../../box/kiteBrokerAdapter.js";
import type { BoxConfig } from "../../box/config.js";
import type { ExecutionTimingRecorder } from "../../box/executionTiming.js";
import type { RateBudgetLedger } from "../../box/brokerPacing.js";

/**
 * Build the Zerodha live adapter.
 *
 * Fails closed and LOUDLY: a missing API key or a missing session must stop live
 * startup, because the alternative — degrading to simulated fills while the
 * operator believes real orders are going out — is the worst possible outcome.
 */
export function createZerodhaLiveAdapter(
  kite: KiteClient,
  cfg: BoxConfig,
  timing?: ExecutionTimingRecorder,
  rateBudget?: RateBudgetLedger,
): BrokerAdapter {
  const apiKey = process.env.KITE_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("[Box] live execution blocked: KITE_API_KEY is missing.");
  }
  const transport = new KiteHttpTransport({
    apiKey,
    accessToken: () => {
      const token = kite.getAccessToken();
      if (!token) {
        throw new Error("[Box] live execution blocked: Kite access-token session is missing.");
      }
      return token;
    },
    timeoutMs: cfg.liveHttpTimeoutMs,
  });
  return new KiteBrokerAdapter(transport, {
    ...kiteAdapterConfigFromBoxConfig(cfg),
    // THE ACCOUNT BEHIND THE CREDENTIAL, from the SAME object the access token is read from.
    //
    // This is what lets the order path verify, at the final boundary before the POST, that the
    // credential about to sign the request still belongs to the account the order was authorised
    // and stamped under. Reading it from anywhere else would reintroduce the possibility of the
    // two disagreeing — which is exactly the window a re-login opens.
    credentialAccount: () => kite.getSessionAccount(),
    ...(timing ? { timing } : {}),
    ...(rateBudget ? { rateBudget } : {}),
  });
}

/**
 * A `BoxLiveAdapterFactory` that currently serves Zerodha only.
 *
 * It REFUSES any other broker rather than falling back to Zerodha. Silently
 * returning a Kite adapter when the caller asked for Dhan would place real orders
 * at the wrong broker — the single most damaging bug this architecture can have,
 * so it is an explicit throw.
 */
export function zerodhaOnlyLiveAdapterFactory(kite: KiteClient): BoxLiveAdapterFactory {
  return ({ broker, cfg, timing }) => {
    if (broker !== "zerodha") {
      throw new Error(
        `[Box] live execution blocked: no live execution adapter is wired for broker "${broker}". ` +
          `Refusing to fall back to Zerodha.`,
      );
    }
    return createZerodhaLiveAdapter(kite, cfg, timing);
  };
}
