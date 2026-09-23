import { createHash } from "node:crypto";
import type { ResidualLegExposure } from "./types.js";

/**
 * Recent application ids retained for acknowledgement replay. Older commands cannot apply again
 * because their expected projection version is stale, so this ring is an observability aid rather
 * than an ever-growing idempotency set.
 */
export const MAX_FLATTEN_APPLICATION_IDS = 32;

export interface BoxExecutionAttemptProjectionCommand {
  readonly application_id: string;
  readonly expected_version: number;
  readonly expected_projection_identity: string;
  readonly expected_residual_exposure: readonly ResidualLegExposure[];
  readonly next_projection_identity: string;
  readonly residual_exposure: readonly ResidualLegExposure[];
  readonly flatten_charge_delta: number;
  /** IST trading day to which a positive charge delta belongs. */
  readonly flatten_charge_day: string;
}

export type BoxExecutionAttemptProjectionStatus =
  | "applied"
  | "already_applied"
  | "stale"
  | "not_found";

export interface BoxExecutionAttemptProjectionResult {
  readonly status: BoxExecutionAttemptProjectionStatus;
  readonly projection_version: number | null;
  readonly projection_identity: string | null;
  readonly residual_exposure: ResidualLegExposure[] | null;
  readonly flatten_charges: number | null;
  /** Authoritative latest IST charge bucket; null for physically legacy/no-charge rows. */
  readonly flatten_charge_day: string | null;
  /** Authoritative cumulative charges in `flatten_charge_day`. */
  readonly flatten_charges_for_day: number | null;
}

export interface FlattenChargeDayObservation {
  readonly chargeDay: string;
  readonly previousChargesForDay: number;
  readonly chargesForDay: number;
}

export interface BoxExecutionAttemptProjectionSnapshot {
  projection_version?: number | null;
  residual_projection_identity?: string | null;
  residual_exposure?: ResidualLegExposure[] | null;
  flatten_charges?: number | null;
  flatten_charge_day?: string | null;
  flatten_charges_for_day?: number | null;
  applied_flatten_applications?: string[] | null;
  resolved?: boolean;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function canonicalResidual(residual: readonly ResidualLegExposure[]): Record<string, unknown>[] {
  return residual
    .map((leg) => ({
      role: leg.role,
      token: leg.token,
      tradingsymbol: leg.tradingsymbol,
      exchange: leg.exchange ?? "NFO",
      side: leg.side,
      quantity: leg.quantity,
      average_price: leg.average_price,
      source: leg.source,
      created_at: leg.created_at,
      flatten_attempt: leg.flatten_attempt ?? 1,
      // The consecutive-broker-rejection count is part of the durable identity so the bounded
      // retry budget survives a restart. Without it, a pass that only changed the count would
      // compare equal, `residualProjectionChanges` would return false, the write would be skipped,
      // and every restart would hand a structurally-impossible reduction a fresh budget to burn.
      flatten_broker_rejections: leg.flatten_broker_rejections ?? 0,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Stable content identity for a residual projection, independent of array order. */
export function residualProjectionIdentity(residual: readonly ResidualLegExposure[]): string {
  return sha256(canonicalResidual(residual));
}

/** True only when a pass changes durable exposure/generation or records an actual charge. */
export function residualProjectionChanges(command: BoxExecutionAttemptProjectionCommand): boolean {
  return command.expected_projection_identity !== command.next_projection_identity ||
    command.flatten_charge_delta > 0;
}

/**
 * Build the immutable command used for the first write and every acknowledgement retry.
 * The application identity includes the attempt, expected state, resulting state and charge,
 * so reconstructing the same broker outcome after a crash reconstructs the same operation.
 */
export function createResidualProjectionCommand(args: {
  attemptId: string;
  expectedVersion: number;
  expectedResidual: readonly ResidualLegExposure[];
  nextResidual: readonly ResidualLegExposure[];
  flattenChargeDelta: number;
  flattenChargeDay: string;
}): BoxExecutionAttemptProjectionCommand {
  const expectedVersion = Number.isSafeInteger(args.expectedVersion) && args.expectedVersion >= 0
    ? args.expectedVersion
    : 0;
  const expectedProjectionIdentity = residualProjectionIdentity(args.expectedResidual);
  const nextProjectionIdentity = residualProjectionIdentity(args.nextResidual);
  const flattenChargeDelta = Number.isFinite(args.flattenChargeDelta) && args.flattenChargeDelta > 0
    ? round2(args.flattenChargeDelta)
    : 0;
  const flattenChargeDay = /^\d{4}-\d{2}-\d{2}$/.test(args.flattenChargeDay)
    ? args.flattenChargeDay
    : "unattributed";
  const applicationId = sha256({
    attempt_id: args.attemptId,
    expected_version: expectedVersion,
    expected_projection_identity: expectedProjectionIdentity,
    next_projection_identity: nextProjectionIdentity,
    flatten_charge_delta: flattenChargeDelta,
    flatten_charge_day: flattenChargeDay,
  });
  return {
    application_id: applicationId,
    expected_version: expectedVersion,
    expected_projection_identity: expectedProjectionIdentity,
    expected_residual_exposure: args.expectedResidual.map((leg) => ({ ...leg })),
    next_projection_identity: nextProjectionIdentity,
    residual_exposure: args.nextResidual.map((leg) => ({ ...leg })),
    flatten_charge_delta: flattenChargeDelta,
    flatten_charge_day: flattenChargeDay,
  };
}

/** Deterministic ObjectId-compatible id for a crash-only recovery ledger row. */
export function recoveryExecutionAttemptId(
  recoveryKey: string,
  residual: readonly ResidualLegExposure[],
): string {
  return sha256({ recovery_key: recoveryKey, residual: canonicalResidual(residual) }).slice(0, 24);
}

function snapshotResult(
  status: BoxExecutionAttemptProjectionStatus,
  snapshot: BoxExecutionAttemptProjectionSnapshot | null,
): BoxExecutionAttemptProjectionResult {
  if (!snapshot) {
    return {
      status,
      projection_version: null,
      projection_identity: null,
      residual_exposure: null,
      flatten_charges: null,
      flatten_charge_day: null,
      flatten_charges_for_day: null,
    };
  }
  const residual = Array.isArray(snapshot.residual_exposure)
    ? snapshot.residual_exposure.map((leg) => ({ ...leg }))
    : [];
  return {
    status,
    projection_version: Number.isSafeInteger(snapshot.projection_version) &&
      (snapshot.projection_version ?? -1) >= 0
      ? snapshot.projection_version!
      : 0,
    projection_identity: snapshot.residual_projection_identity ?? residualProjectionIdentity(residual),
    residual_exposure: residual,
    flatten_charges: round2(Math.max(0, snapshot.flatten_charges ?? 0)),
    flatten_charge_day: snapshot.flatten_charge_day ?? null,
    flatten_charges_for_day: round2(Math.max(0, snapshot.flatten_charges_for_day ?? 0)),
  };
}

/**
 * Pure model of the durable compare-and-set. Used by non-service race/retry tests and kept in
 * lock-step with the Mongo pipeline: absent legacy version/application fields mean v0/empty.
 */
export function transitionResidualProjectionSnapshot(
  snapshot: BoxExecutionAttemptProjectionSnapshot | null,
  command: BoxExecutionAttemptProjectionCommand,
): { result: BoxExecutionAttemptProjectionResult; snapshot: BoxExecutionAttemptProjectionSnapshot | null } {
  if (!snapshot) return { result: snapshotResult("not_found", null), snapshot: null };
  const applications = snapshot.applied_flatten_applications ?? [];
  if (applications.includes(command.application_id)) {
    return { result: snapshotResult("already_applied", snapshot), snapshot };
  }
  const version = Number.isSafeInteger(snapshot.projection_version) &&
    (snapshot.projection_version ?? -1) >= 0
    ? snapshot.projection_version!
    : 0;
  const residual = Array.isArray(snapshot.residual_exposure) ? snapshot.residual_exposure : [];
  const identity = snapshot.residual_projection_identity ?? residualProjectionIdentity(residual);
  if (version !== command.expected_version || identity !== command.expected_projection_identity) {
    return { result: snapshotResult("stale", snapshot), snapshot };
  }
  const next: BoxExecutionAttemptProjectionSnapshot = {
    ...snapshot,
    projection_version: version + 1,
    residual_projection_identity: command.next_projection_identity,
    residual_exposure: command.residual_exposure.map((leg) => ({ ...leg })),
    flatten_charges: round2(Math.max(0, snapshot.flatten_charges ?? 0) + command.flatten_charge_delta),
    flatten_charge_day: command.flatten_charge_delta > 0
      ? command.flatten_charge_day
      : (snapshot.flatten_charge_day ?? null),
    flatten_charges_for_day: command.flatten_charge_delta > 0
      ? round2(
          (snapshot.flatten_charge_day === command.flatten_charge_day
            ? Math.max(0, snapshot.flatten_charges_for_day ?? 0)
            : 0) + command.flatten_charge_delta,
        )
      : (snapshot.flatten_charges_for_day ?? 0),
    applied_flatten_applications: [...applications, command.application_id]
      .slice(-MAX_FLATTEN_APPLICATION_IDS),
    resolved: command.residual_exposure.length === 0,
  };
  return { result: snapshotResult("applied", next), snapshot: next };
}

/**
 * Seed one process's observation watermark from a row already included in its durable daily-risk
 * seed. The watermark is monotonic so reloading an older snapshot cannot make a later charge look
 * new again.
 */
export function seedObservedFlattenCharges(
  observedByAttempt: Map<string, number>,
  attemptId: string,
  cumulativeCharges: number | null | undefined,
): void {
  const cumulative = Number.isFinite(cumulativeCharges)
    ? round2(Math.max(0, cumulativeCharges ?? 0))
    : 0;
  observedByAttempt.set(attemptId, Math.max(observedByAttempt.get(attemptId) ?? 0, cumulative));
}

/** Stable key for one attempt's authoritative IST-day charge bucket. */
function observedDayKey(attemptId: string, chargeDay: string): string {
  return `${attemptId}\u0000${chargeDay}`;
}

/**
 * Remove watermarks that no live residual can acknowledge again and all obsolete day buckets.
 * Returns bounded diagnostics for tests/status surfaces without exposing either map directly.
 */
export function compactObservedFlattenChargeWatermarks(args: {
  observedByAttempt: Map<string, number>;
  observedByAttemptDay: Map<string, number>;
  retainAttemptIds: ReadonlySet<string>;
  currentDay: string;
}): { lifetime: number; dayBuckets: number } {
  for (const attemptId of args.observedByAttempt.keys()) {
    if (!args.retainAttemptIds.has(attemptId)) args.observedByAttempt.delete(attemptId);
  }
  for (const key of args.observedByAttemptDay.keys()) {
    const separator = key.indexOf("\u0000");
    const attemptId = separator >= 0 ? key.slice(0, separator) : key;
    const day = separator >= 0 ? key.slice(separator + 1) : "";
    if (!args.retainAttemptIds.has(attemptId) || day !== args.currentDay) {
      args.observedByAttemptDay.delete(key);
    }
  }
  return {
    lifetime: args.observedByAttempt.size,
    dayBuckets: args.observedByAttemptDay.size,
  };
}

/** Bounded sizes of the per-attempt projection bookkeeping, for diagnostics and tests. */
export interface ResidualProjectionBookkeepingSizes {
  readonly projectionVersions: number;
  readonly projectionIdentities: number;
}

/**
 * Drop the projection version/identity pair of every attempt that can no longer issue a command.
 *
 * The pair exists only to build the NEXT compare-and-set for an attempt, so it must be retained
 * while a residual is still being flattened or a durable acknowledgement is still outstanding, and
 * must be released the moment the attempt resolves. Without this it grew by one entry per execution
 * attempt for the whole process lifetime.
 */
export function compactResidualProjectionBookkeeping(args: {
  projectionVersionByAttempt: Map<string, number>;
  projectionIdentityByAttempt: Map<string, string>;
  retainAttemptIds: ReadonlySet<string>;
}): ResidualProjectionBookkeepingSizes {
  for (const attemptId of args.projectionVersionByAttempt.keys()) {
    if (!args.retainAttemptIds.has(attemptId)) args.projectionVersionByAttempt.delete(attemptId);
  }
  for (const attemptId of args.projectionIdentityByAttempt.keys()) {
    if (!args.retainAttemptIds.has(attemptId)) args.projectionIdentityByAttempt.delete(attemptId);
  }
  return {
    projectionVersions: args.projectionVersionByAttempt.size,
    projectionIdentities: args.projectionIdentityByAttempt.size,
  };
}

/** Seed a day bucket already represented by a durable daily-risk seed. */
export function seedObservedFlattenChargesForDay(
  observedByAttemptDay: Map<string, number>,
  attemptId: string,
  chargeDay: string | null | undefined,
  chargesForDay: number | null | undefined,
): void {
  if (!chargeDay || !Number.isFinite(chargesForDay)) return;
  const key = observedDayKey(attemptId, chargeDay);
  const charges = round2(Math.max(0, chargesForDay ?? 0));
  observedByAttemptDay.set(key, Math.max(observedByAttemptDay.get(key) ?? 0, charges));
}

/**
 * Adopt a row that may have been charged before this process first saw it. Existing attempts
 * converge from both their lifetime and per-day watermarks. A newly seen row establishes the
 * lifetime watermark but debits only the persisted current-day bucket, never prior-day history.
 */
export function adoptObservedFlattenCharges(args: {
  observedByAttempt: Map<string, number>;
  observedByAttemptDay?: Map<string, number>;
  attemptId: string;
  cumulativeCharges: number | null | undefined;
  currentDay: string;
  chargeDay: string | null | undefined;
  chargesForDay: number | null | undefined;
  onNewCharge?: ((charge: number, observation?: FlattenChargeDayObservation) => void) | undefined;
}): number {
  const cumulative = Number.isFinite(args.cumulativeCharges)
    ? round2(Math.max(0, args.cumulativeCharges ?? 0))
    : 0;
  if (args.observedByAttempt.has(args.attemptId)) {
    return reconcileObservedFlattenCharges({
      attemptId: args.attemptId,
      cumulativeCharges: cumulative,
      chargeDay: args.chargeDay,
      chargesForDay: args.chargesForDay,
      observedByAttempt: args.observedByAttempt,
      observedByAttemptDay: args.observedByAttemptDay,
      onNewCharge: args.onNewCharge,
    });
  }
  args.observedByAttempt.set(args.attemptId, cumulative);
  const today = args.chargeDay === args.currentDay && Number.isFinite(args.chargesForDay)
    ? round2(Math.max(0, args.chargesForDay ?? 0))
    : 0;
  if (args.observedByAttemptDay) {
    seedObservedFlattenChargesForDay(
      args.observedByAttemptDay,
      args.attemptId,
      args.chargeDay,
      args.chargesForDay,
    );
  }
  if (today > 0) {
    args.onNewCharge?.(today, {
      chargeDay: args.currentDay,
      previousChargesForDay: 0,
      chargesForDay: today,
    });
  }
  return today;
}

/**
 * Converge this process to authoritative lifetime and latest-day charge watermarks. Lifetime
 * bookkeeping always advances, including a delayed acknowledgement from a prior day. Risk is
 * emitted only from a newly observed per-day bucket; its owner can therefore debit the current
 * trading day and ignore historical buckets without losing idempotency.
 */
export function reconcileObservedFlattenCharges(args: {
  attemptId: string;
  cumulativeCharges: number | null;
  chargeDay?: string | null | undefined;
  chargesForDay?: number | null | undefined;
  observedByAttempt: Map<string, number>;
  observedByAttemptDay?: Map<string, number> | undefined;
  onNewCharge?: ((charge: number, observation?: FlattenChargeDayObservation) => void) | undefined;
}): number {
  if (!Number.isFinite(args.cumulativeCharges)) return 0;
  const cumulative = round2(Math.max(0, args.cumulativeCharges ?? 0));
  const observedLifetime = args.observedByAttempt.get(args.attemptId) ?? 0;
  const lifetimeDelta = cumulative > observedLifetime ? round2(cumulative - observedLifetime) : 0;
  if (cumulative > observedLifetime) {
    // Advance before invoking the risk hook so re-entrant/adjoining acknowledgements cannot debit
    // the same durable increment twice in this process.
    args.observedByAttempt.set(args.attemptId, cumulative);
  }

  if (args.observedByAttemptDay && args.chargeDay && Number.isFinite(args.chargesForDay)) {
    const key = observedDayKey(args.attemptId, args.chargeDay);
    const chargesForDay = round2(Math.max(0, args.chargesForDay ?? 0));
    const previousChargesForDay = args.observedByAttemptDay.get(key) ?? 0;
    if (chargesForDay <= previousChargesForDay) return 0;
    const delta = round2(chargesForDay - previousChargesForDay);
    args.observedByAttemptDay.set(key, chargesForDay);
    args.onNewCharge?.(delta, {
      chargeDay: args.chargeDay,
      previousChargesForDay,
      chargesForDay,
    });
    return delta;
  }

  // Additive compatibility for callers that have not yet supplied per-day bookkeeping.
  if (lifetimeDelta > 0) args.onNewCharge?.(lifetimeDelta);
  return lifetimeDelta;
}

/**
 * Register a durable residual with its watchdog before the first flatten pass. Marking it in
 * flight first prevents the newly armed watchdog from racing a slow direct pass.
 */
export async function runInitialRegisteredResidualPass<T>(args: {
  markInFlight: () => void;
  register: () => void;
  flatten: () => Promise<T>;
  clearInFlight: () => void;
}): Promise<T> {
  args.markInFlight();
  args.register();
  try {
    return await args.flatten();
  } finally {
    args.clearInFlight();
  }
}

/**
 * Persist a residual projection and reconcile this process from the authoritative cumulative
 * charge returned for applied, already-applied, and stale outcomes. A lost acknowledgement has
 * no observable total; its immutable retry performs the convergence when Mongo answers.
 */
export async function persistOwnedResidualProjection(args: {
  attemptId: string;
  command: BoxExecutionAttemptProjectionCommand;
  persist: (command: BoxExecutionAttemptProjectionCommand) => Promise<BoxExecutionAttemptProjectionResult>;
  observedFlattenCharges: Map<string, number>;
  observedFlattenChargesByDay?: Map<string, number> | undefined;
  onAppliedCharge?: ((charge: number, observation?: FlattenChargeDayObservation) => void) | undefined;
}): Promise<BoxExecutionAttemptProjectionResult> {
  const result = await args.persist(args.command);
  if (result.status !== "not_found" && result.flatten_charges !== null) {
    reconcileObservedFlattenCharges({
      attemptId: args.attemptId,
      cumulativeCharges: result.flatten_charges,
      chargeDay: result.flatten_charge_day,
      chargesForDay: result.flatten_charges_for_day,
      observedByAttempt: args.observedFlattenCharges,
      observedByAttemptDay: args.observedFlattenChargesByDay,
      onNewCharge: args.onAppliedCharge,
    });
  }
  return result;
}
