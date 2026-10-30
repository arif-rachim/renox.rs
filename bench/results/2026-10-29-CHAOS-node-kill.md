# CHAOS node-kill — Node killed — 2026-10-29
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, kernel 6.18.44-fc-v185), renox-worker 66b0040, bun 1.4.4
Scenario: two controlled renox-workers, control/api sweeping every 5 s (unhealthy after 30 s), file replica; the owner of a tenant killed with SIGKILL after 10 s of writes (B18)
Failure modes: "Node dies" (docs/23-failure-modes.md)
Result: RTO > 180 s, RPO — s, 6262 rows lost, bystander 2061×200
Target: RTO ≤ 60 s, RPO ≤ 10 s (B18), no error for a tenant on the surviving node → FAIL
Alerts: RenoxNodeUnhealthy (condition true after 22.7 s)
Checks:
- [ ] RTO ≤ 60 s: no 200 on node-chaos-1 within 180 s of SIGKILL
- [ ] the surviving node stays healthy: renox_cp_node_healthy 0, heartbeat age 214.2 s
- [ ] RPO ≤ 10 s: nothing restored (6262 rows acknowledged)
- [x] no cross-tenant impact: bystander t-chaos-b on node-chaos-1: 2061×200
- [x] detected by the control plane: renox_cp_node_healthy = 0 after 22.7 s
Notes: Both nodes run on one host (loopback); the two-host B18 run is O3 (#158). Cause (diagnosed in this session): the worker's heartbeat (crates/renox-cell/src/control/mod.rs) has no `sent_at`, which control-messages.schema.json requires, so control/api answers 400 ('heartbeat refused') and every node turns unhealthy 30 s after it registers; failover then has no healthy candidate. With `sent_at` added (a local, uncommitted patch) the same harness gave node-kill PASS (RTO 32.8 s, RPO 0.79 s, bystander 415×200) and control-plane-down PASS.
Raw: bench/results/raw/2026-10-29-CHAOS-node-kill.json
