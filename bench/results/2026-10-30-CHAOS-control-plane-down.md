# CHAOS control-plane-down — Control plane down — 2026-10-30
Hardware: dev-laptop (Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz, kernel 7.0.0-38-generic), renox-worker 03e8319, bun 1.4.4
Scenario: control/api (PGlite in a directory) stopped for 15 s while a warm tenant takes reads and another writes, then started again on the same database
Failure modes: "Control plane unreachable from the worker" (docs/23-failure-modes.md)
Result: reads 74×200, writes 74×200; degraded after 0.0 s; recovered — s after the restart
Target: no error for warm tenants during the outage; /healthz degraded; nodes healthy again after the restart without a failover → FAIL
Alerts: RenoxControlPlaneDown (metrics endpoint down during the outage)
Checks:
- [x] warm tenants keep serving: reads on node-chaos-2: 74×200; writes on node-chaos-1: 74×200
- [x] the worker reports the outage: control_plane degraded after 0.0 s
- [x] the control plane's metrics stop answering: GET /v1/ops/metrics: no answer (RenoxControlPlaneDown)
- [ ] recovery after restart: nodes not healthy and heartbeating within 60 s
- [x] heartbeats accepted after the restart: heartbeat age 15 s later: node-chaos-1 9.6 s, node-chaos-2 9.6 s (interval 10 s)
- [x] no failover from a short outage: after the restart t-chaos-a answers 200 on node-chaos-2; route entry on node-chaos-2
Notes: Artifacts live in the API's memory in this stack (no S3), so a cold start of an uncached deployment during or after the outage is not exercised here; storage-down covers it with S3. An outage longer than the 30 s threshold makes the first sweep after the restart see stale heartbeats and start failovers; that case is the node-kill scenario's. 
Raw: not kept (a local run on the owner's machine, batch F67-ALL; disk at 80–81 % used, so /healthz reports disk warn).
