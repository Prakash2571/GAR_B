/**
 * BOUNDED, BACKPRESSURE-AWARE SSE OUTPUT FOR ONE CLIENT.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES. Snapshot fan-out called `res.write(...)` inside a `try/catch` and discarded
 * the result. `write()` does not throw when a client stops reading — it returns FALSE, having accepted
 * the chunk into an unbounded in-process buffer, and it keeps doing so for as long as you keep calling
 * it. A `catch` therefore never fired, and nothing limited how much was held: one authenticated client
 * on a stalled connection (a suspended laptop, a phone on a dying signal, a hung proxy, a debugger
 * paused on a breakpoint) could make this process accumulate snapshots until it ran out of memory.
 *
 * That matters more here than it would in a normal web service, because this is the SAME process that
 * prices and dispatches orders. Memory pressure and the GC pauses that come with it are paid by the
 * execution path — and the execution path's own safety margins are stated in milliseconds
 * (`executionLease.ts`). A slow viewer must not be able to lengthen an order's latency, let alone push
 * the process towards an out-of-memory death while positions are open.
 *
 * THE POLICY, which follows the doctrine already written down in `boundedQueue.ts`:
 *
 *   SNAPSHOTS COALESCE. A snapshot is the WHOLE state, so a superseded one is worthless — it was going
 *   to be replaced anyway. While a client is backed up, at most one snapshot is held for it, and a new
 *   one overwrites the old. This is what makes a slow client cheap instead of unbounded: its queue
 *   cannot grow past one snapshot no matter how long it stalls.
 *
 *   DISCRETE EVENTS DO NOT COALESCE. `entry`, `exit`, `execution_attempt` and `trade_deleted` each
 *   describe a distinct thing that happened; silently dropping one would leave a client's view wrong
 *   in a way it could never detect. They queue in order, and if the queue cannot be drained within
 *   budget the client is DISCONNECTED rather than quietly lied to — a dropped connection is visible and
 *   recoverable (the browser reconnects and receives a fresh snapshot), a missing event is neither.
 *
 *   THE BUDGET IS PER CLIENT AND COUNTS BOTH HALVES: what this writer is holding plus what the socket
 *   itself has buffered. Only counting our own queue would miss the actual leak, since the socket's
 *   buffer is exactly where the unbounded growth used to happen.
 *
 * WHAT THIS DOES NOT DO. It does not guarantee delivery — nothing can, over a socket the peer has
 * stopped reading. It guarantees BOUNDED MEMORY and an explicit, observable disconnect instead of
 * silent unbounded growth.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * The part of an HTTP response this writer uses. Structural on purpose: a test passes a fake whose
 * `write` returns false on demand, with no socket, no server and no timing games.
 */
export interface SseSink {
  /** False means "buffered, stop sending" — the whole point of this module. */
  write(chunk: string): boolean;
  /** Bytes the sink itself is holding. `undefined` from a sink that cannot report it. */
  readonly writableLength?: number;
  once(event: "drain", listener: () => void): unknown;
  /** Drop the connection. Used when a client cannot be kept inside its budget. */
  destroy(): unknown;
}

/**
 * Default per-client budget.
 *
 * Sized for "a snapshot or two plus the socket's own high-water mark", not for a backlog: the coalescing
 * policy means a healthy client never approaches it, and an unhealthy one should be disconnected
 * promptly rather than carried. With the default 500ms publish cadence, a client that has not drained
 * this much has not been reading for several seconds.
 */
export const DEFAULT_SSE_CLIENT_BUDGET_BYTES = 512 * 1024;

export interface SseWriterDeps {
  readonly sink: SseSink;
  readonly maxPendingBytes?: number;
  /**
   * Called ONCE when the client exceeded its budget and was disconnected. The caller must remove it
   * from its registry; this writer has no knowledge of who is tracking it.
   */
  readonly onOverBudget?: (info: { readonly pendingBytes: number; readonly queuedFrames: number }) => void;
}

interface QueuedFrame {
  readonly chunk: string;
  /** Frames sharing a key replace one another while queued. Only snapshots set it. */
  readonly coalesceKey: string | null;
}

/** Counters worth surfacing in diagnostics: silent dropping is what this module exists to avoid. */
export interface SseWriterStats {
  readonly framesWritten: number;
  readonly framesCoalesced: number;
  readonly queuedFrames: number;
  readonly pendingBytes: number;
  readonly blocked: boolean;
  readonly closed: boolean;
}

export class BoundedSseWriter {
  private readonly sink: SseSink;
  private readonly budget: number;
  private readonly onOverBudget: SseWriterDeps["onOverBudget"];
  /** True once `write` returned false and no `drain` has arrived yet. */
  private blocked = false;
  private drainArmed = false;
  private queue: QueuedFrame[] = [];
  private queuedBytes = 0;
  private framesWritten = 0;
  private framesCoalesced = 0;
  private closed = false;

  constructor(deps: SseWriterDeps) {
    this.sink = deps.sink;
    this.budget = Math.max(16 * 1024, deps.maxPendingBytes ?? DEFAULT_SSE_CLIENT_BUDGET_BYTES);
    this.onOverBudget = deps.onOverBudget;
  }

  /** Bytes owed to this client: what we hold, plus what the sink has not yet flushed. */
  pendingBytes(): number {
    return this.queuedBytes + (this.sink.writableLength ?? 0);
  }

  stats(): SseWriterStats {
    return {
      framesWritten: this.framesWritten,
      framesCoalesced: this.framesCoalesced,
      queuedFrames: this.queue.length,
      pendingBytes: this.pendingBytes(),
      blocked: this.blocked,
      closed: this.closed,
    };
  }

  /**
   * Send one SSE frame.
   *
   * `coalesceKey` marks a frame as SUPERSEDABLE: while the client is backed up, a later frame with the
   * same key replaces the queued one instead of joining it. Pass it for whole-state snapshots and for
   * nothing else.
   */
  send(event: string, data: string, opts: { readonly coalesceKey?: string } = {}): void {
    if (this.closed) return;
    const chunk = `event: ${event}\ndata: ${data}\n\n`;
    const coalesceKey = opts.coalesceKey ?? null;

    if (!this.blocked) {
      this.writeNow(chunk);
      return;
    }

    // Backed up: queue, coalescing where the payload permits it.
    if (coalesceKey !== null) {
      const at = this.queue.findIndex((frame) => frame.coalesceKey === coalesceKey);
      if (at >= 0) {
        const previous = this.queue[at];
        if (previous !== undefined) {
          this.queuedBytes -= previous.chunk.length;
          this.queue[at] = { chunk, coalesceKey };
          this.queuedBytes += chunk.length;
          this.framesCoalesced += 1;
          this.enforceBudget();
          return;
        }
      }
    }
    this.queue.push({ chunk, coalesceKey });
    this.queuedBytes += chunk.length;
    this.enforceBudget();
  }

  /** A frame this client must receive or be disconnected for. Convenience for readability. */
  sendCritical(event: string, data: string): void {
    this.send(event, data);
  }

  /**
   * Write immediately, and start honouring backpressure the moment the sink says it is full.
   *
   * A throw here is a broken pipe — the socket is gone — and the connection's own close handling removes
   * the client. There is nothing to queue for a socket that no longer exists.
   */
  private writeNow(chunk: string): void {
    let accepted: boolean;
    try {
      accepted = this.sink.write(chunk);
    } catch {
      this.closed = true;
      this.queue = [];
      this.queuedBytes = 0;
      return;
    }
    this.framesWritten += 1;
    if (!accepted) {
      this.blocked = true;
      this.armDrain();
      // The sink is now holding this chunk, so it counts against the budget immediately: a single
      // enormous frame to a dead peer must not slip through just because our own queue is empty.
      this.enforceBudget();
    }
  }

  private armDrain(): void {
    if (this.drainArmed || this.closed) return;
    this.drainArmed = true;
    this.sink.once("drain", () => {
      this.drainArmed = false;
      this.blocked = false;
      this.flush();
    });
  }

  /** Send what is queued, stopping the moment the sink pushes back again. */
  private flush(): void {
    while (!this.closed && !this.blocked && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined) break;
      this.queuedBytes -= next.chunk.length;
      this.writeNow(next.chunk);
    }
    if (this.queuedBytes < 0) this.queuedBytes = 0;
  }

  /**
   * Disconnect a client that cannot be kept inside its budget.
   *
   * Deliberately a DISCONNECT and not a silent drop. The client's own reconnect gives it a complete
   * fresh snapshot, so the recovery is correct by construction; dropping discrete events instead would
   * leave a plausible-looking but wrong view with nothing to indicate it.
   */
  private enforceBudget(): void {
    if (this.closed) return;
    const pending = this.pendingBytes();
    if (pending <= this.budget) return;
    const queuedFrames = this.queue.length;
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    try {
      this.sink.destroy();
    } catch {
      /* already gone */
    }
    this.onOverBudget?.({ pendingBytes: pending, queuedFrames });
  }

  /** Stop using this writer (the connection closed). Idempotent. */
  close(): void {
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
  }

  isClosed(): boolean {
    return this.closed;
  }
}
