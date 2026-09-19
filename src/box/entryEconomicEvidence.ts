/**
 * THE ECONOMIC EVIDENCE THAT ADMITTED ONE ENTRY ATTEMPT, AND THE SEND-BOUNDARY RE-CHECK OF IT.
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────────────────────
 *
 * Both of these used to live inside `CentralBoxExecutionGateway`: the evidence as a private field and
 * the re-check as a private method reading it. Two separate problems with that, and this module fixes
 * both.
 *
 * 1. OWNERSHIP. The field was ONE mutable slot, written by whichever attempt evaluated most recently
 *    and read LATE, at POST time, by whichever attempt reached its send boundary:
 *
 *        attempt A evaluates         -> slot = A
 *        attempt B evaluates         -> slot = B      (A's evidence is gone)
 *        attempt A reaches pre_post  -> validates against B's freshness, identity and order plan
 *
 *    The plan-fingerprint comparison would often have caught that and refused A — for the wrong
 *    reason, and only by luck: two attempts on the same underlying and strikes can produce the same
 *    leg fingerprint, and A would then have passed on B's freshness and B's account identity.
 *
 *    The genuinely dangerous case needed no coincidence at all. The slot was set to `null` whenever an
 *    admission was REFUSED, and the re-check opens `if (!evidence) return null` — "no economic control
 *    enabled, nothing to check". So B being refused erased A's evidence and turned A's send boundary
 *    into a silent no-op: the expiry check that exists precisely to catch staleness between admission
 *    and transmit did not run, and reported nothing.
 *
 *    One-box serialisation made this unreachable in the shipped profile. It was never a property of
 *    the evidence handling itself, which is why the ownership is fixed rather than the configuration
 *    documented. The evidence is now an immutable value captured in the closure of the attempt that
 *    produced it: no slot to overwrite, no key to look up, nothing to evict and nothing to leak — it
 *    becomes garbage with the attempt's own stack frame. A `Map<attemptId, …>` would have been the
 *    weaker option: a lookup that can miss, return the wrong entry, or retain.
 *
 * 2. TESTABILITY. The gateway takes its dependencies through a constructor parameter property, so a
 *    strip-only TypeScript runner cannot instantiate it — which meant the interleaving regression this
 *    whole change exists to support had no way to run outside a full engine harness. Here every input
 *    is explicit, so two attempts can be evaluated side by side, in either order, with no shared state
 *    between them.
 *
 * The comparisons themselves are UNCHANGED: freshness against each observation's own ceiling,
 * broker/account/session identity, and the order-plan binding. All three refuse rather than assume.
 */

import { identityMismatch, monoElapsed, orderPlanFingerprint, type EvidenceIdentity } from "./evidenceTiming.js";
import type { BrokerOrderRequest } from "./brokerAdapter.js";

/**
 * The evidence that admitted ONE entry attempt, owned by that attempt.
 *
 * Every field is `readonly` and the object is never mutated after `evaluateEntryEconomics` builds it.
 * It is handed to the send-boundary closure of the attempt that produced it and to nothing else.
 */
export interface EntryEconomicEvidence {
  readonly fundsObservedAtMono: number | null;
  readonly marginObservedAtMono: number | null;
  readonly fundsMaxAgeMs: number;
  readonly marginMaxAgeMs: number;
  readonly planFingerprint: string;
  readonly identity: EvidenceIdentity | null;
  readonly fundsRequired: boolean;
  readonly marginRequired: boolean;
  /**
   * The attempt this evidence was acquired for.
   *
   * NOT a lookup key — there is nothing to look it up in, because ownership is guaranteed by the
   * closure capture. It is carried so a refusal can name the attempt it belongs to, and so a test can
   * assert an attempt evaluated its OWN evidence rather than inferring that from field values two
   * attempts might legitimately share.
   */
  readonly attemptId: string;
}

/**
 * Does this attempt's own economic evidence still authorise the POST?
 *
 * Returns a reason to refuse, or null to allow. Pure: no clock, no I/O, no shared state.
 *
 * `null` evidence permits the POST and now means exactly ONE thing — this attempt was admitted with no
 * economic control enabled, so there is nothing to re-check. It can no longer also mean "a sibling's
 * refusal erased the shared slot". An attempt whose own admission was refused never reaches a send
 * boundary at all: `simulateLeggingEntry` returns `REFUSED_BEFORE_SUBMIT` before the guard is built.
 *
 * It does NOT decide what happens once exposure already exists — the order manager owns that, and its
 * policy is "no exposure ⇒ refuse; exposure taken ⇒ complete and record", which is why this must never
 * be used to abandon a leg that could already be filling.
 */
export function entryEconomicSendBoundaryGap(input: {
  readonly evidence: EntryEconomicEvidence | null;
  readonly request?: BrokerOrderRequest;
  readonly currentIdentity: EvidenceIdentity | null;
  readonly monoNow: number;
}): string | null {
  const { evidence, request, currentIdentity, monoNow } = input;
  if (!evidence) return null;
  const owner = `[attempt ${evidence.attemptId}]`;

  if (evidence.fundsRequired && evidence.fundsObservedAtMono !== null) {
    const age = monoElapsed(evidence.fundsObservedAtMono, monoNow);
    if (age === null || age > evidence.fundsMaxAgeMs) {
      return `${owner} available-funds evidence EXPIRED before transmit (age ${age ?? "?"}ms > ${evidence.fundsMaxAgeMs}ms)`;
    }
  }
  if (evidence.marginRequired && evidence.marginObservedAtMono !== null) {
    const age = monoElapsed(evidence.marginObservedAtMono, monoNow);
    if (age === null || age > evidence.marginMaxAgeMs) {
      return `${owner} planned-margin evidence EXPIRED before transmit (age ${age ?? "?"}ms > ${evidence.marginMaxAgeMs}ms)`;
    }
  }
  const mismatch = identityMismatch(evidence.identity, currentIdentity);
  if (mismatch) return `${owner} economic evidence no longer applies: ${mismatch}`;

  /*
   * PLAN BINDING. The manager hands us the request it is about to POST; if its contract, side,
   * quantity or limit price is not the one the margin figure was computed for, the evidence is not
   * about this order.
   */
  if (request) {
    const leg = orderPlanFingerprint([request]);
    if (!evidence.planFingerprint.split("|").includes(leg)) {
      return (
        `${owner} order plan CHANGED after evidence acquisition (quantity or limit price differs from ` +
        `the plan the margin figure was fetched for): ${leg}`
      );
    }
  }
  return null;
}
