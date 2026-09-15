/**
 * ORDER-UPDATE STREAM STATUS — the operator-facing answer to one question:
 * "is the fast fill path actually running, or am I relying on REST polling?"
 *
 * WHY THIS EXISTS SEPARATELY FROM MARKET-DATA HEALTH.
 *
 * A working market-data socket proves ticks are arriving. It proves NOTHING about whether
 * order updates are arriving, because on Zerodha they share one socket but different frame
 * types (binary ticks vs text postbacks), and on Dhan they are two entirely different
 * WebSockets. A dashboard that shows one green light for "socket OK" therefore invites
 * exactly the wrong inference: that fills will be observed promptly. This module keeps the
 * two signals structurally apart and makes the order-update answer explicit.
 *
 * THREE DISTINCT SITUATIONS, never collapsed into one:
 *
 *   not_built    — no order-stream implementation for this broker.
 *   not_wired    — the implementation EXISTS and is tested, but no running component is
 *                  consuming it, so it cannot deliver a fill however healthy the socket is.
 *                  This is a REAL operational state and it must not render as "disabled by
 *                  choice", because the operator did not choose it.
 *   gated_off    — implemented AND wired, but the operator has not armed the env gate.
 *   armed        — gate on; the projection's own health then decides LIVE/DOWN/etc.
 *
 * `fills_observed_by` is the field that actually matters to a human: it names the mechanism
 * currently responsible for seeing a fill. When that is `rest_polling_only`, latency to
 * fill observation is bounded by the polling cadence and the pacing floor, not by the
 * broker's push latency — and every downstream expectation should be set accordingly.
 */

import type { OrderStreamHealth } from "./orderUpdateProjection.js";
import type { OrderStreamLifecycleState } from "./streamHealthPolicy.js";
import type { BrokerId } from "./latencyModel.js";

/**
 * How the order-update capability stands for one broker, independent of socket health.
 *
 * `not_applicable_paper` is the state this enum was missing, and its absence was a reporting bug
 * with real consequences. In a paper deployment no order-stream consumer is constructed — ON
 * PURPOSE, because constructing one would mean building a live order manager, and a paper process
 * must contain no object capable of touching a real order. The old code saw "no consumer in the
 * map" and reported `not_wired`, whose whole documented meaning is "this SHOULD be running and is
 * not" — an operational fault the operator did not choose. So every paper deployment permanently
 * reported a broken fast fill path that was never supposed to exist, and the dashboard said
 * "REST polling for order updates" about orders that are never sent anywhere.
 */
export type OrderStreamWiring =
  | "not_built"
  | "not_wired"
  | "gated_off"
  | "armed"
  | "not_applicable_paper";

/**
 * What is currently responsible for observing a fill.
 *
 * `simulated_paper_fills` exists because neither previous value was true in paper mode. A broker
 * cannot produce an order-update event for an order it never received, so "REST polling observes
 * the fill" is not a conservative understatement — it is false, and it implies a broker round trip
 * and a confirmation that do not exist. Paper fills come from the local simulator, and the payload
 * now says exactly that.
 */
export type FillObservationMechanism =
  | "rest_polling_only"
  | "stream_primary_rest_reconcile"
  | "simulated_paper_fills";

export interface BrokerOrderStreamStatus {
  broker: BrokerId;
  wiring: OrderStreamWiring;
  /** The env gate's name, so an operator can find the switch without grepping. */
  gate_env_var: string;
  gate_enabled: boolean;
  /** Live health from the projection, or null when nothing is consuming the stream. */
  health: OrderStreamHealth | null;
  /**
   * SECTION 7 — the AUTHORITATIVE order-stream lifecycle, or null when nothing consumes the stream.
   *
   * This is the value the live-entry gate scores. Publishing it next to `fills_observed_by` is what
   * makes defect (a) unrepeatable: the operator can see that the mechanism label and the entry
   * permission were decided from the SAME state, rather than from two holders that drifted apart.
   */
  lifecycle: OrderStreamLifecycleState | null;
  fills_observed_by: FillObservationMechanism;
  /** Plain-language, safe to display verbatim. Never contains a token or account id. */
  detail: string;
}

export interface OrderStreamStatusSnapshot {
  /**
   * The headline an operator should read FIRST. True only when at least one broker's order
   * stream is genuinely delivering updates. False whenever fills depend on REST polling.
   */
  any_stream_live: boolean;
  /**
   * Explicit anti-conflation flag for the UI. When true, the dashboard MUST NOT present a
   * healthy market-data feed as evidence that fills are observed promptly.
   */
  market_data_health_is_not_order_stream_health: true;
  brokers: BrokerOrderStreamStatus[];
}

const GATE_ENV: Readonly<Record<BrokerId, string>> = Object.freeze({
  zerodha: "ZERODHA_ORDER_STREAM_ENABLED",
  dhan: "DHAN_ORDER_STREAM_ENABLED",
});

/**
 * Build the snapshot.
 *
 * `consumers` maps a broker to the projection health of whatever is actually consuming its
 * order stream. A broker ABSENT from the map is reported `not_wired` even when its env gate
 * is on — because an armed gate with no consumer still delivers no fills, and reporting that
 * as "armed" would be a lie an operator could act on.
 */
export function orderStreamStatus(args: {
  brokers: readonly BrokerId[];
  gateEnabled: (broker: BrokerId) => boolean;
  consumers?: ReadonlyMap<BrokerId, OrderStreamHealth>;
  /** Brokers with no implementation at all. */
  notBuilt?: readonly BrokerId[];
  /**
   * TRUE when this deployment simulates execution (any paper mode).
   *
   * Supplied by the engine from its startup-only execution mode. It changes only the LABELLING:
   * a paper deployment has no order-stream consumer by construction, so the absence of one is
   * expected rather than broken, and fills are simulated rather than REST-polled. It never
   * suppresses a genuine fault — see `paperSimulated` handling below, which is deliberately
   * skipped for any broker that somehow DOES have a live consumer.
   */
  paperSimulated?: boolean;
}): OrderStreamStatusSnapshot {
  const notBuilt = new Set(args.notBuilt ?? []);
  const paperSimulated = args.paperSimulated === true;
  const brokers = args.brokers.map((broker): BrokerOrderStreamStatus => {
    const gateEnabled = args.gateEnabled(broker);
    const health = args.consumers?.get(broker) ?? null;
    const gateVar = GATE_ENV[broker];

    let wiring: OrderStreamWiring;
    if (notBuilt.has(broker)) wiring = "not_built";
    // PAPER, and genuinely nothing consuming the stream: not applicable, not broken. Note the
    // `health === null` conjunct — if a consumer somehow exists in a paper process that is an
    // anomaly worth surfacing, so it falls through to the normal (honest) classification below
    // rather than being relabelled as "not applicable".
    else if (paperSimulated && health === null) wiring = "not_applicable_paper";
    else if (health === null) wiring = "not_wired";
    else if (!gateEnabled) wiring = "gated_off";
    else wiring = "armed";

    // A fill is observed by the stream ONLY when a consumer exists, the gate is on, and the
    // projection itself reports a usable connection. Anything less is REST polling, and the
    // pending-reconcile state counts as REST because the stream is not yet trusted.
    //
    // SECTION 7 / defect (a). `health.state` is now DERIVED from the single lifecycle authority
    // (see OrderStreamConsumer.health / publishedStateForLifecycle), so `state === "LIVE"` can no
    // longer be true while the governing lifecycle is DEGRADED. When the payload carries that
    // authority verbatim we additionally require it to be READY, so this decision is scored off the
    // SAME value the entry gate scores — the published fill mechanism and the entry permission are
    // then incapable of contradicting one another. Health WITHOUT a `lifecycle` (a projection read
    // in isolation) keeps the original rule, so no existing caller changes meaning.
    const lifecycleUsable =
      health === null || health.lifecycle === undefined ? true : health.lifecycle === "READY";
    const streamUsable =
      wiring === "armed" &&
      health !== null &&
      health.state === "LIVE" &&
      health.connected &&
      health.authorised &&
      lifecycleUsable;
    // PAPER: the simulator observes its own fills. Reporting `rest_polling_only` here would claim
    // a broker interaction that never happens. `stream_primary_rest_reconcile` still wins if a
    // real consumer is somehow live, so a genuine live stream is never mislabelled as simulated.
    const fills_observed_by: FillObservationMechanism = streamUsable
      ? "stream_primary_rest_reconcile"
      : wiring === "not_applicable_paper"
        ? "simulated_paper_fills"
        : "rest_polling_only";

    return {
      broker,
      wiring,
      gate_env_var: gateVar,
      gate_enabled: gateEnabled,
      health,
      // SECTION 7: the AUTHORITATIVE lifecycle, published alongside the mechanism it decided, so a
      // reader never has to infer it from a mechanism label. Null when nothing consumes the stream.
      lifecycle: health?.lifecycle ?? null,
      fills_observed_by,
      detail: describe(broker, wiring, gateVar, gateEnabled, health),
    };
  });

  return {
    any_stream_live: brokers.some((b) => b.fills_observed_by === "stream_primary_rest_reconcile"),
    market_data_health_is_not_order_stream_health: true,
    brokers,
  };
}

function describe(
  broker: BrokerId,
  wiring: OrderStreamWiring,
  gateVar: string,
  gateEnabled: boolean,
  health: OrderStreamHealth | null,
): string {
  switch (wiring) {
    case "not_applicable_paper":
      return (
        `This deployment simulates execution, so no order is sent to ${broker} and ${broker} has ` +
        `no order to report on. Fills are produced by the local execution simulator against real ` +
        `streamed quotes. A broker order-update stream is NOT APPLICABLE here — this is the ` +
        `expected configuration, not a fault, and ${gateVar} is irrelevant while paper is in force.`
      );
    case "not_built":
      return `No order-update stream implementation for ${broker}; fills are observed by REST polling only.`;
    case "not_wired":
      return (
        `An order-update stream for ${broker} is implemented and unit-tested, but NO running component ` +
        `is consuming it, so it cannot deliver a fill. Fills are observed by REST polling only. ` +
        (gateEnabled
          ? `${gateVar} is set, which does NOT by itself start a consumer.`
          : `${gateVar} is also unset.`) +
        ` This requires supervised live validation before it is relied upon.`
      );
    case "gated_off":
      return `Order-update stream for ${broker} is wired but not armed (${gateVar} is not "true"); fills are observed by REST polling only.`;
    case "armed":
      return health
        ? `Order-update stream for ${broker} armed via ${gateVar}. ${health.detail}`
        : `Order-update stream for ${broker} armed via ${gateVar}.`;
  }
}
