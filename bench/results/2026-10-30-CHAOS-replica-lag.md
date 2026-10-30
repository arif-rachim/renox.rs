# CHAOS replica-lag — Replica lagging — 2026-10-30
Hardware: dev-laptop (Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz, kernel 7.0.0-38-generic), renox-worker 03e8319, bun 1.4.4
Scenario: the tenant's Litestream sidecar stopped with SIGSTOP for 15 s during 10 writes per second, then SIGCONT
Failure modes: "Replica lagging / Litestream behind" (docs/23-failure-modes.md)
Result: max lag 16.8 s (metric 16.8), recovered 0.1 s after SIGCONT, writes 152×200
Target: no tenant error; lag reported above 10 s while frozen; under 5 s again within 60 s → PASS
Alerts: RenoxReplicationLag (condition true (16.8 s))
Checks:
- [x] the tenant sees nothing: writes during and after the freeze: 152×200
- [x] the lag passes the FO6 threshold: getBackups lag_seconds up to 16.8 s
- [x] the control plane's metric shows it: renox_cp_replication_lag_max_seconds up to 16.8 (RenoxReplicationLag fires above 10)
- [x] the lag recovers: under 5 s 0.1 s after SIGCONT
Notes: The control plane's lag metric is the nodes' last report, refreshed here by getBackups; the worker's own gauge comes with #295.
Raw: not kept (a local run on the owner's machine, batch F67-ALL; disk at 80–81 % used, so /healthz reports disk warn).
