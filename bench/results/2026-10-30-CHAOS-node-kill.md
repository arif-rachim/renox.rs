# CHAOS node-kill — Node killed — 2026-10-30
Hardware: dev-laptop (Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz, kernel 7.0.0-38-generic), renox-worker 03e8319, bun 1.4.4
Scenario: two controlled renox-workers, control/api sweeping every 5 s (unhealthy after 30 s), file replica; the owner of a tenant killed with SIGKILL after 10 s of writes (B18)
Failure modes: "Node dies" (docs/23-failure-modes.md)
Result: RTO 32.1 s, RPO 1.02 s, 913 rows lost, bystander 409×200
Target: RTO ≤ 60 s, RPO ≤ 10 s (B18), no error for a tenant on the surviving node → PASS
Alerts: RenoxNodeUnhealthy (condition true after 30.5 s)
Checks:
- [x] RTO ≤ 60 s: 32.1 s from SIGKILL to the first 200 on node-chaos-1
- [x] the surviving node stays healthy: renox_cp_node_healthy 1, heartbeat age 5.9 s
- [x] RPO ≤ 10 s: 1.02 s (913 of 9008 acknowledged rows not restored)
- [x] no cross-tenant impact: bystander t-chaos-b on node-chaos-1: 409×200
- [x] detected by the control plane: renox_cp_node_healthy = 0 after 30.5 s
Notes: Both nodes run on one host (loopback); the two-host B18 run is O3 (#158).
Raw: not kept (a local run on the owner's machine, batch F67-ALL; disk at 80–81 % used, so /healthz reports disk warn).
