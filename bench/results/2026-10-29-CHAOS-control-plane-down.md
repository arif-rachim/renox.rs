# CHAOS control-plane-down — Control plane down — 2026-10-29
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, kernel 6.18.44-fc-v185), renox-worker 66b0040, bun 1.4.4
Scenario: control/api (PGlite in a directory) stopped for 15 s while a warm tenant takes reads and another writes, then started again on the same database
Failure modes: "Control plane unreachable from the worker" (docs/23-failure-modes.md)
Result: reads 74×200, writes 74×200; degraded after 0.0 s; recovered 15.4 s after the restart
Target: no error for warm tenants during the outage; /healthz degraded; nodes healthy again after the restart without a failover → FAIL
Alerts: RenoxControlPlaneDown (metrics endpoint down during the outage)
Checks:
- [x] warm tenants keep serving: reads on node-chaos-2: 74×200; writes on node-chaos-1: 74×200
- [x] the worker reports the outage: control_plane degraded after 0.0 s
- [x] the control plane's metrics stop answering: GET /v1/ops/metrics: no answer (RenoxControlPlaneDown)
- [x] recovery after restart: both nodes healthy and heartbeating, /healthz ok, 15.4 s after the restart
- [ ] heartbeats accepted after the restart: heartbeat age 15 s later: node-chaos-1 15.0 s, node-chaos-2 15.0 s (interval 10 s)
- [x] no failover from a short outage: after the restart t-chaos-a answers 200 on node-chaos-2; route entry on node-chaos-2
Notes: Artifacts live in the API's memory in this stack (no S3), so a cold start of an uncached deployment during or after the outage is not exercised here; storage-down covers it with S3. An outage longer than the 30 s threshold makes the first sweep after the restart see stale heartbeats and start failovers; that case is the node-kill scenario's. Cause (diagnosed in this session): the worker's heartbeat (crates/renox-cell/src/control/mod.rs) has no `sent_at`, which control-messages.schema.json requires, so control/api answers 400 ('heartbeat refused') and every node turns unhealthy 30 s after it registers; failover then has no healthy candidate. With `sent_at` added (a local, uncommitted patch) the same harness gave node-kill PASS (RTO 32.8 s, RPO 0.79 s, bystander 415×200) and control-plane-down PASS.
Raw: bench/results/raw/2026-10-29-CHAOS-control-plane-down.json
