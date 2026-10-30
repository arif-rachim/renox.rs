# CHAOS erasure — Erasure with the owning node down — 2026-10-30
Hardware: dev-laptop (Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz, kernel 7.0.0-38-generic), renox-worker 16f4b85, bun 1.4.4
Scenario: two controlled renox-workers, file replica, control/api with a 2 s erasure retry; the owner deletes the tenant while its node is killed, then the node restarts
Failure modes: "Tenant erasure cannot finish (owning node down, object store unreachable)" (docs/23-failure-modes.md)
Result: done in 10.7 s, replica purged, bystander 104×200
Target: the erasure finishes once the node is reachable again, with the replica purged and no impact on other tenants → PASS
Alerts: none
Checks:
- [x] the owner's request is accepted: DELETE answered 202
- [x] the erasure waits for the node: state erasing 5 s after the request with the node down
- [x] it finishes once the node is back: done 10.7 s after the request
- [x] the replica generations are purged: replica_purged_at 1793355041115, no replica directory left
- [x] the hostname is no longer served: GET on node-chaos-2 answered 404
- [x] no cross-tenant impact: bystander t-chaos-keep on node-chaos-1: 104×200
Notes: Both nodes run on one host (loopback). Production retries a failed step hourly and finishes within 24 hours while the node and the store answer.
Raw: not kept (a local run on the owner's machine during batch F67-ALL, #308).
