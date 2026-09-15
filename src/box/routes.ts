/**
 * Box HTTP + SSE surface, mounted under /api/box.
 *
 * Uses the application's access pattern: the injected `requireOperator`
 * middleware (a valid site-passcode session, delivered as an HttpOnly cookie), and
 * `getOperatorRole(req)` to read the validated role. The SSE endpoint authenticates
 * from the same secure same-origin cookie — a session token in the query string is
 * never accepted, since EventSource sends cookies on same-origin requests.
 *
 * Every route lives here rather than in index.ts, so the box module adds nothing
 * to that file beyond a single registration call.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { KiteError } from "../kite.js";
import { rateLimit } from "../ratelimit.js";
import type { BoxEngine } from "./engine.js";
import {
  isBoxDbEnabled,
  loadBoxEvents,
  loadBoxTrades,
  loadClosedBoxTrades,
  serializeBoxTrade,
} from "./repository.js";

export interface BoxRouteDeps {
  engine: BoxEngine;
  requireOperator: RequestHandler;
  /**
   * Resolves the operator role from the request's validated session (attached by
   * requireOperator). This backend authenticates via an HttpOnly session cookie, not
   * a header/query token, so this reads the request — never a query-string token —
   * which is why an SSE stream cannot be authenticated by a token in the URL.
   */
  getOperatorRole: (req: Request) => "full" | "trade" | null;
}

function fail(res: Response, err: unknown): void {
  if (err instanceof KiteError) {
    res.status(err.status || 502).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected server error.";
  console.error("[Box] request failed:", err);
  res.status(500).json({ error: message });
}

/**
 * A tight bucket for the destructive delete endpoint.
 *
 * Deliberately far below the global /api limit: deleting trades is a deliberate,
 * one-at-a-time operator action, so 20 a minute is generous for a human and still
 * stops a stuck client from walking the whole book.
 */
const deleteRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: "Too many delete requests. Slow down.",
});

export function registerBoxRoutes(app: Express, deps: BoxRouteDeps): void {
  const { engine, requireOperator } = deps;
  const requireFull = (req: Request, res: Response): boolean => {
    if (deps.getOperatorRole(req) !== "full") {
      res.status(403).json({ error: "Full administrator access required." });
      return false;
    }
    return true;
  };

  /* ------------------------------- control ------------------------------- */

  app.get("/api/box/status", requireOperator, (_req: Request, res: Response) => {
    res.json(engine.getStatus());
  });

  app.get("/api/box/config", requireOperator, (_req: Request, res: Response) => {
    res.json(engine.getConfig());
  });

  /**
   * READ-ONLY execution diagnostics (Phase 32): calibration status per broker, measured latency
   * percentiles, event-loop health, what paper is actually running on, outcome/reject rates, the
   * advisory queue-haircut recommendation, and recent latency outliers.
   *
   * A GET with no side effects, behind the same admin auth as every other box route. It exposes
   * only latency numbers, counts, statuses and explicitly-configured labels — never a token, key
   * or session identifier.
   */
  app.get("/api/box/execution-diagnostics", requireOperator, (_req: Request, res: Response) => {
    try {
      res.json(engine.getExecutionDiagnostics());
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * ADMIN control: how many strikes each side of ATM are monitored/traded (1, 2
   * or 3). Guarded by the same admin auth as every other box route.
   *
   * From the moment it is set, only boxes within ATM ±level are discovered and
   * entered. Positions ALREADY OPEN are never affected — they keep being
   * monitored and exit on their own rules regardless of the new width.
   */
  app.post("/api/box/strike-level", requireOperator, async (req: Request, res: Response) => {
    try {
      const raw = (req.body ?? {}) as { level?: unknown };
      const level = Number(raw.level);
      if (!Number.isFinite(level) || ![1, 2, 3].includes(Math.round(level))) {
        res.status(400).json({ error: "level must be 1, 2 or 3." });
        return;
      }
      const result = await engine.setStrikeLevel(level);
      res.json({ ok: true, strike_level: result.level, status: engine.getStatus() });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * ADMIN control: the live entry gate (₹ expected net) and safety buffer (₹).
   *
   * Persisted to `box_settings`, so it survives a restart and is shared by every
   * browser. Takes effect on the next evaluation and applies to NEW boxes only —
   * positions already open are never re-judged against a changed threshold.
   *
   * Body: { min_expected_net_profit?: number, safety_buffer?: number }
   */
  app.post("/api/box/settings", requireOperator, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Attribute the change in the append-only ledger. This threshold governs
      // automatic entries, so "it moved" is not enough — the role that moved it
      // belongs in the audit trail alongside the values.
      const actor = deps.getOperatorRole(req) ?? "admin";
      const result = await engine.setTuning(
        {
          minExpectedNetProfit: body.min_expected_net_profit ?? body.minExpectedNetProfit,
          safetyBuffer: body.safety_buffer ?? body.safetyBuffer,
        },
        actor,
      );
      if (!result.ok) {
        res.status(result.code).json({ error: result.error });
        return;
      }
      res.json({ ok: true, config: engine.getConfig(), status: engine.getStatus() });
    } catch (err) {
      fail(res, err);
    }
  });

  /** RUN — begin discovering and auto-opening paper boxes. */
  app.post("/api/box/start", requireOperator, async (_req: Request, res: Response) => {
    try {
      const result = await engine.start();
      if (!result.ok) {
        res.status(400).json({ error: result.error, status: engine.getStatus() });
        return;
      }
      res.json({ ok: true, status: engine.getStatus() });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * STOP — stop discovering NEW boxes.
   *
   * Open positions keep being monitored and can still auto-exit; that is the
   * documented meaning of STOP and it is enforced by the engine, not here.
   */
  app.post("/api/box/stop", requireOperator, (_req: Request, res: Response) => {
    engine.stop();
    res.json({ ok: true, status: engine.getStatus() });
  });

  for (const control of [
    "box_entry_enabled",
    "box_live_order_enabled",
    "box_emergency_flatten",
  ] as const) {
    app.post(`/api/box/controls/${control}`, requireOperator, (req: Request, res: Response) => {
      if (!requireFull(req, res)) return;
      const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean." });
        return;
      }
      const result = engine.setLiveControl(control, enabled);
      if (!result.ok) {
        res.status(409).json({ error: result.error, status: engine.getStatus() });
        return;
      }
      // FORWARD THE EXPOSURE REPORT. `setLiveControl` computes what this switch did NOT remove —
      // open positions, residual legs, working orders, whether reduction is still available and why
      // not if it is not. Dropping it and answering a bare `{ ok: true }` is what told an operator
      // the switch worked without telling them exposure was still live, which is the whole reason
      // the report exists.
      res.json({
        ok: true,
        ...(result.exposure === undefined ? {} : { exposure: result.exposure }),
        status: engine.getStatus(),
      });
    });
  }

  /* --------------------- execution control (Part 8/9/15) -------------------- */

  /**
   * READ-ONLY execution control surface: mode, broker, deployment live capability, arming state,
   * session budget, risk limits and effective pacing.
   *
   * The UI's Execution panel reads this rather than mining `getStatus()`. Contains no secrets:
   * modes, labels, counts, booleans and configured numbers only.
   */
  app.get("/api/box/execution-control", requireOperator, (_req: Request, res: Response) => {
    try {
      res.json(engine.getExecutionControl());
    } catch (err) { fail(res, err); }
  });

  /**
   * Preview what a requested execution-mode change WOULD do, without doing it.
   *
   * Lets the UI report "restart required" and the exact environment variables involved, instead of
   * offering a selector that silently fails. Read-only, so plain admin auth.
   */
  app.post("/api/box/execution-mode/preview", requireOperator, (req: Request, res: Response) => {
    const to = (req.body as { selection?: unknown } | undefined)?.selection;
    const allowed = ["paper_latency", "paper_legging", "paper_legging_live_parity", "live"] as const;
    if (typeof to !== "string" || !(allowed as readonly string[]).includes(to)) {
      res.status(400).json({ error: `selection must be one of: ${allowed.join(", ")}.` });
      return;
    }
    try {
      res.json(engine.previewModeTransition(to as (typeof allowed)[number]));
    } catch (err) { fail(res, err); }
  });

  /**
   * Change the PAPER execution profile at runtime. FULL ADMIN.
   *
   * Only paper profiles are runtime-selectable, because switching between two simulations creates
   * no new capability. LIVE is NOT reachable from here at any privilege level: `BOX_EXECUTION_MODE`
   * is a startup-only construction boundary, so a paper deployment contains no object able to place
   * a real order. Backend validation is independent of the frontend's.
   */
  app.post("/api/box/execution-mode/paper-profile", requireOperator, (req: Request, res: Response) => {
    if (!requireFull(req, res)) return;
    const profile = (req.body as { profile?: unknown } | undefined)?.profile;
    const allowed = ["standard", "live_parity", "stress"] as const;
    if (typeof profile !== "string" || !(allowed as readonly string[]).includes(profile)) {
      res.status(400).json({ error: `profile must be one of: ${allowed.join(", ")}.` });
      return;
    }
    try {
      const result = engine.setPaperExecutionProfile(
        profile as (typeof allowed)[number],
        deps.getOperatorRole(req),
      );
      if (!result.ok) {
        res.status(result.code).json({ error: result.error, ...(result.blockers ? { blockers: result.blockers } : {}) });
        return;
      }
      res.json({ ok: true, execution: engine.getExecutionControl() });
    } catch (err) { fail(res, err); }
  });

  /* ------------------------- trading session (Part 7) ----------------------- */

  /**
   * ARM a trading session. FULL ADMIN.
   *
   * Arming resets the cycle counters, which makes it the most attractive way around a spent
   * one-shot budget — so the engine refuses it while any consumed cycle still has live exposure.
   * `max_completed_trades` is optional; omitted, the configured
   * `BOX_SESSION_MAX_COMPLETED_TRADES` is used. The value is SNAPSHOTTED, so a later config change
   * cannot widen a session already armed.
   */
  app.post("/api/box/session/arm", requireOperator, async (req: Request, res: Response) => {
    if (!requireFull(req, res)) return;
    const body = req.body as
      | { max_completed_trades?: unknown; max_entry_attempts?: unknown }
      | undefined;
    /*
     * BOTH ceilings are accepted here. `max_entry_attempts` used to be dropped on the floor: the
     * engine's `armTradingSession` has always accepted it, but this route parsed only
     * `max_completed_trades`, so an operator arming a bounded one-shot session over the API could
     * not set the attempt ceiling and got no error telling them the field was ignored.
     *
     * That gap matters more than it looks. The session record SNAPSHOTS both ceilings at arm time,
     * so `BOX_SESSION_MAX_ENTRY_ATTEMPTS` in the environment does not retroactively bind a session
     * that was already armed. Without this field, the only way to apply the attempt ceiling was to
     * set the env var and arm a NEW session — and an operator who set the var, restarted, and saw
     * the session still armed would reasonably believe the bound was in force while it was not.
     */
    const ceiling = (
      raw: unknown,
      field: string,
    ): { ok: true; value: number | undefined } | { ok: false; error: string } => {
      if (raw === undefined || raw === null) return { ok: true, value: undefined };
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 10_000) {
        return { ok: false, error: `${field} must be an integer between 0 and 10000 (0 = unlimited).` };
      }
      return { ok: true, value: raw };
    };
    const trades = ceiling(body?.max_completed_trades, "max_completed_trades");
    if (!trades.ok) { res.status(400).json({ error: trades.error }); return; }
    const attempts = ceiling(body?.max_entry_attempts, "max_entry_attempts");
    if (!attempts.ok) { res.status(400).json({ error: attempts.error }); return; }
    try {
      const result = await engine.armTradingSession({
        ...(trades.value === undefined ? {} : { maxCompletedTrades: trades.value }),
        ...(attempts.value === undefined ? {} : { maxEntryAttempts: attempts.value }),
        actor: deps.getOperatorRole(req),
      });
      if (!result.ok) {
        res.status(result.code).json({ error: result.error, execution: engine.getExecutionControl() });
        return;
      }
      res.json({ ok: true, session: result.session, execution: engine.getExecutionControl() });
    } catch (err) { fail(res, err); }
  });

  /**
   * DISARM the trading session. FULL ADMIN.
   *
   * Stops new entry; does NOT clear the counters, so disarm-then-arm cannot be used to skip the
   * exposure guard on arming. Every reduction path is unaffected.
   */
  app.post("/api/box/session/disarm", requireOperator, async (req: Request, res: Response) => {
    if (!requireFull(req, res)) return;
    try {
      const result = await engine.disarmTradingSession(
        deps.getOperatorRole(req),
      );
      res.json({ ok: result.ok, session: result.session, execution: engine.getExecutionControl() });
    } catch (err) { fail(res, err); }
  });

  app.post("/api/box/live/reconcile", requireOperator, async (req: Request, res: Response) => {
    if (!requireFull(req, res)) return;
    try {
      res.json({ ok: true, reconciliation: await engine.reconcileLive(), status: engine.getStatus() });
    } catch (err) { fail(res, err); }
  });

  /**
   * CANCEL EVERY WORKING BOX ORDER.
   *
   * `ok` comes from the SWEEP, not from the HTTP call. This route used to be
   * `res.json({ ok: true, orders: await engine.cancelWorkingBoxOrders(), … })` — a hardcoded success
   * wrapped around a method that returned `[]` whenever it refused to run. With
   * `box_live_order_enabled` off, the operator's panic button therefore answered HTTP 200 `ok:true`
   * `orders:[]` having loaded no intents and attempted no cancellation.
   *
   * A refused sweep is now **409**, and a partially-failed sweep is **207**, so a client cannot read
   * either as a clean result. The full result object carries `blocked_reason`, `examined`, `eligible`
   * and per-intent `failures`.
   */
  app.post("/api/box/live/cancel-working", requireOperator, async (req: Request, res: Response) => {
    if (!requireFull(req, res)) return;
    try {
      const result = await engine.cancelWorkingBoxOrders();
      const status = engine.getStatus();
      if (!result.attempted) {
        // Nothing was even attempted. 409: the request conflicts with the deployment's current state.
        res.status(409).json({ ...result, orders: result.cancelled, status });
        return;
      }
      if (!result.ok) {
        // 207 Multi-Status: some cancels were accepted and some were not. Exposure may remain.
        res.status(207).json({ ...result, orders: result.cancelled, status });
        return;
      }
      // `orders` is retained alongside `cancelled` so an older client keeps working.
      res.json({ ...result, orders: result.cancelled, status });
    } catch (err) { fail(res, err); }
  });

  app.post("/api/box/live/flatten", requireOperator, async (req: Request, res: Response) => {
    if (!requireFull(req, res)) return;
    try {
      res.json({ ok: true, ...(await engine.flattenAttributedBoxExposure()), status: engine.getStatus() });
    } catch (err) { fail(res, err); }
  });

  /* ----------------------------- opportunities ---------------------------- */

  app.get("/api/box/opportunities", requireOperator, (req: Request, res: Response) => {
    const raw = Number(req.query.limit ?? 0);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(300, Math.round(raw)) : undefined;
    res.json({
      opportunities: engine.getOpportunities(limit),
      status: engine.getStatus(),
    });
  });

  /** The ATM±3 chains being monitored (list form). */
  app.get("/api/box/chains", requireOperator, (req: Request, res: Response) => {
    const underlying = String(req.query.underlying ?? "").trim();
    if (!underlying) {
      res.json({ chains: engine.listChainSymbols() });
      return;
    }
    const chain = engine.getChain(underlying);
    if (!chain) {
      res.status(404).json({
        error: `No monitored box window for "${underlying.toUpperCase()}". Start the scanner, or pick an underlying from GET /api/box/chains.`,
      });
      return;
    }
    res.json(chain);
  });

  /* -------------------------------- trades ------------------------------- */

  app.get("/api/box/trades", requireOperator, async (_req: Request, res: Response) => {
    try {
      const trades = await loadBoxTrades();
      res.json({
        dbEnabled: isBoxDbEnabled(),
        open: engine.getOpenPositions(),
        trades: trades.map(serializeBoxTrade),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /** Live open positions with their current exit arithmetic (in-memory, fast). */
  app.get("/api/box/trades/open", requireOperator, (_req: Request, res: Response) => {
    res.json({ dbEnabled: isBoxDbEnabled(), open: engine.getOpenPositions() });
  });

  /**
   * Closed box trades.
   *
   * `?scope=today` is the FAST path: today's trades come from memory (or Redis
   * after a restart), never from a full-book Mongo sort, so the Closed-trades tab
   * can render the session the operator actually cares about immediately. The
   * default `scope=all` is the whole closed book from Mongo and is the slower call
   * the UI makes second, in the background.
   */
  app.get("/api/box/trades/history", requireOperator, async (req: Request, res: Response) => {
    try {
      const scope = String(req.query.scope ?? "all").trim().toLowerCase();
      if (scope === "today") {
        const { trades, source, day } = await engine.getClosedToday();
        res.json({
          dbEnabled: isBoxDbEnabled(),
          scope: "today",
          /** Which tier answered: memory | postgres | none. */
          source,
          day,
          cacheEnabled: engine.isClosedCacheEnabled(),
          /**
           * These rows have their execution-audit blobs stripped (see
           * liteClosedTrade). Stated explicitly so a client can tell "stripped"
           * from "this trade genuinely has no execution record", and so the UI
           * knows not to let one overwrite a fuller row it already holds.
           */
          lite: true,
          trades,
        });
        return;
      }
      const raw = Number(req.query.limit ?? 0);
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(1000, Math.round(raw)) : 300;
      const trades = await loadClosedBoxTrades(limit);
      res.json({
        dbEnabled: isBoxDbEnabled(),
        scope: "all",
        source: "postgres",
        cacheEnabled: engine.isClosedCacheEnabled(),
        /**
         * The audit blobs are projected out of list queries — they are most of a
         * document's bytes and no list renders them. Carrying them made this
         * response large enough to hit a gateway timeout.
         */
        lite: true,
        trades: trades.map(serializeBoxTrade),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  /** paper_legging execution attempts that aborted (partial fill + unwind). */
  app.get("/api/box/execution-attempts", requireOperator, async (req: Request, res: Response) => {
    try {
      const raw = Number(req.query.limit ?? 0);
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(500, Math.round(raw)) : 100;
      res.json({ dbEnabled: isBoxDbEnabled(), attempts: await engine.listExecutionAttempts(limit) });
    } catch (err) {
      fail(res, err);
    }
  });

  /** The append-only decision ledger. */
  app.get("/api/box/events", requireOperator, async (req: Request, res: Response) => {
    try {
      const raw = Number(req.query.limit ?? 0);
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(1000, Math.round(raw)) : 200;
      res.json({ events: await loadBoxEvents(limit) });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Manual close at the current executable touch.
   *
   * POST (not DELETE) so it rides the app's existing CORS allow-list. Refuses
   * with 409 when the four-leg one-lot market is unavailable — it will not invent
   * a price to satisfy the request.
   */
  app.post("/api/box/trades/:id/close", requireOperator, async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id ?? "");
      const result = await engine.closeManually(id);
      if (!result.ok) {
        res.status(result.code).json({ error: result.error, metrics: result.metrics ?? null });
        return;
      }
      res.json({ ok: true, open: engine.getOpenPositions() });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * PERMANENTLY delete a PAPER Box trade (open, closed or errored).
   *
   * FULL ADMIN ONLY. This is destructive and irreversible, so trade-access users
   * cannot reach it even though they can see every trade — viewing history and
   * rewriting it are different privileges.
   *
   * Rate limited separately from the global /api bucket: a destructive endpoint
   * should not be reachable at the same 150-per-minute rate as a price read, and a
   * runaway client (or a stuck retry loop in the UI) must not be able to walk the
   * whole book.
   *
   * The engine owns every safety decision and returns the status code to use, so
   * this handler stays a thin translation layer. LIVE trades are refused with 409.
   */
  app.delete(
    "/api/box/trades/:id",
    deleteRateLimit,
    requireOperator,
    async (req: Request, res: Response) => {
      if (!requireFull(req, res)) return;
      try {
        const id = String(req.params.id ?? "");
        const body = (req.body ?? {}) as { reason?: unknown };
        const reason = typeof body.reason === "string" && body.reason.trim() !== ""
          ? body.reason.trim().slice(0, 500)
          : null;
        const actor = deps.getOperatorRole(req) ?? "admin";

        const result = await engine.deleteTrade(id, { actor, reason });
        if (!result.ok) {
          res.status(result.code).json({ error: result.error });
          return;
        }
        // Return the corrected state alongside the acknowledgement so the UI can
        // apply it immediately — no reload, and no second round trip to discover
        // the new counts, P&L and margin.
        const { trades, source, day } = await engine.getClosedToday();
        res.json({
          ok: true,
          deleted_id: id,
          status: engine.getStatus(),
          open: engine.getOpenPositions(),
          closed_today: { trades, source, day, lite: true },
        });
      } catch (err) {
        fail(res, err);
      }
    },
  );

  /* --------------------------------- SSE --------------------------------- */

  /**
   * Live box state: scanner state, opportunity changes, entries, open-position
   * updates and exits.
   *
   * SSE authenticates from the secure, same-origin session cookie via
   * requireOperator — EventSource sends cookies on same-origin requests. A session
   * token in the query string is NEVER accepted; the guard reads only the validated
   * session the middleware attached to the request.
   */
  app.get("/api/box/stream", requireOperator, (req: Request, res: Response) => {
    if (deps.getOperatorRole(req) === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const remove = engine.addSseClient(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* the close handler cleans up */
      }
    }, 20000);
    keepAlive.unref?.();

    req.on("close", () => {
      clearInterval(keepAlive);
      remove();
      res.end();
    });
  });
}
