// PM2 process definition for GTS Box.
//
// FORK MODE, ONE INSTANCE — deliberately NOT cluster mode.
//
// The in-process reservation store is the AUTHORITATIVE tier for a single
// process: within one Node process it decides, synchronously and without a round
// trip, which underlying an execution owns. Run two workers in cluster mode and
// that in-process authority is no longer global — worker A and worker B each
// believe they own the underlying. What makes MORE than one worker safe is the
// DURABLE PostgreSQL reservation tier plus globally-unique owner ids
// (src/box/reservations/*), NOT PM2. We ship the simple, correct topology: one
// fork-mode process, so the in-process tier and the durable tier agree. If you
// ever scale to multiple workers, they MUST all share the same PostgreSQL and
// rely on the durable tier for cross-process safety — do that as a deliberate,
// tested change, not by flipping `exec_mode` to "cluster".
//
// NO SECRETS HERE. All configuration comes from the process environment / .env.

module.exports = {
  apps: [
    {
      name: "strikedge",
      script: "dist/index.js",
      // node dist/index.js — the compiled server. Run `npm run build` first.
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,

      // Restart if RSS climbs past this. The Box engine holds bounded caches and
      // per-underlying state; this is a generous ceiling that catches a genuine
      // leak without flapping on normal working set.
      max_memory_restart: "1200M",

      // GRACEFUL SHUTDOWN BUDGET.
      // On stop/reload PM2 sends SIGTERM, waits kill_timeout, then SIGKILL.
      // GTS Box's shutdown sequence (stop scanner → drain outbox → close Mongo
      // → close PostgreSQL last) is bounded by SHUTDOWN_TIMEOUT_MS (default
      // 20000). kill_timeout MUST sit comfortably ABOVE that so the sequence can
      // finish before SIGKILL — otherwise PM2 kills the process mid-drain.
      // 20000 (app) + 10000 headroom = 30000.
      kill_timeout: 30000,

      // Give the app a moment to bind and pass its own boot checks before PM2
      // considers it "online".
      min_uptime: "15s",
      listen_timeout: 15000,

      // Do NOT auto-restart on a clean exit code 0 (e.g. a migration-only run or
      // an intentional stop); DO restart on a crash.
      autorestart: true,
      stop_exit_codes: [0],

      // Logs. Point these at wherever your host keeps service logs.
      out_file: "/var/log/strikedge/out.log",
      error_file: "/var/log/strikedge/error.log",
      merge_logs: true,
      time: true,

      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
