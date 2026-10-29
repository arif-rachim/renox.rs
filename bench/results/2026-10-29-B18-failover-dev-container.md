# B18 node failover on the dev container (#257)

| | |
| --- | --- |
| Date | 2026-10-29 |
| Host | dev container, 4 vCPU, Ubuntu 24.04.5, kernel 6.18.44 |
| Scenario | `bench/scenarios/B18/failover.ts`: control/api (PGlite) sweeping every 5 s, two controlled `renox-worker`s on loopback with a node listener each and a `file` replica in one shared directory, a free tenant inserting a row per request for 10 s, the owning worker killed with `SIGKILL` |
| Target | RTO ≤ 60 s, RPO ≤ 10 s; fail RPO > 60 s (`docs/14-benchmarks.md`) |
| Status | **Not measured** |

## What happened

The scenario ran to the kill with the debug `renox-worker`: the control plane started, both workers registered with their node listeners and callback tokens, the app was uploaded and activated on its owner, and 10 s of writes were acknowledged. After the kill the other node never served the tenant: `litestream` cannot run in this session (running a downloaded binary is refused by the session's permission policy), so the worker logged `replication is on but litestream does not run` and nothing reached the replica. The run also found two bugs in #255, fixed on the branch (prepare opened the tenant file without the restore hook; a failed sidecar spawn was retried every second).

## What is proven instead

`control/api/tests/failover.test.ts` (passes): the order FO3 requires (every restore call arrives while the tenant's entries still name the dead node; the entries move only after a 200), the fall-through to the next candidate, the alert when every candidate fails, the drop on return, the platform log line and the audit row of each move. The timing budget is FO6 of `docs/contracts/deploy-api.md`: detection ≤ 35 s, restore deadline 20 s, publish 100 ms.

## Owed

`bench/run.sh B18` where `litestream` runs, then the two-host run on `node-small` and the load host (O3, #158).
