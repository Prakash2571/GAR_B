// PM2 process definition for the GTS Algo Research backend.
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
// NO SECRETS HERE, AND THERE IS A REASON BEYOND TIDINESS.
//
// `pm2 save` serialises the running process's environment into ~/.pm2/dump.pm2 so `pm2 resurrect` can
// restore it after a reboot. Any secret placed in the `env` block below would therefore be written in
// clear text into a SECOND file whose permissions nobody audits, and would be restored from that copy
// rather than from the authoritative one — so a rotated key would leave its predecessor live in the
// dump. That is not a hypothetical: it is what makes "just put it in the ecosystem file" wrong.
//
// HOW CREDENTIALS ACTUALLY REACH THE PROCESS
//
// The backend reads them itself, on every process start, from a protected file (default
// /etc/gts/secrets.env, mode 0600) — see src/env/boot.ts and src/env/load.ts. Because the read happens
// at startup rather than being inherited from whoever launched PM2, credentials survive all of:
//
//     pm2 restart · pm2 reload · a crash auto-restart · pm2 save + pm2 resurrect · a server reboot
//
// and they do NOT depend on the SSH/deploy session that last touched the machine still existing.
// Operational (non-secret) BOX configuration comes from the repo-local .env, read in the same pass at
// lower precedence. Nothing needs to be listed here for either to work.

module.exports = {
  apps: [
    {
      name: "gts-backend",
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
      // The shutdown sequence (stop scanner → drain outbox → close Mongo
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
      out_file: "/var/log/gts/out.log",
      error_file: "/var/log/gts/error.log",
      merge_logs: true,
      time: true,

      env: {
        NODE_ENV: "production",

        // The PATH to the secrets file — never its contents. A path is not a credential, so it is
        // safe both to commit and to let `pm2 save` write into the dump.
        //
        // Left commented out deliberately: the default (/etc/gts/secrets.env) is compiled into the
        // application, so the standard layout survives a reboot with no configuration at all. Set this
        // ONLY if you moved the file — and set it HERE rather than in .env, because the loader reads
        // this variable from the real process environment before any file is parsed (a file cannot name
        // the file that has to be read to find it). If you move the file and set the path only in your
        // shell, `pm2 resurrect` after a reboot will look in the default location and find nothing.
        //
        // GTS_SECRETS_FILE: "/etc/gts/secrets.env",
      },
    },
  ],
};
