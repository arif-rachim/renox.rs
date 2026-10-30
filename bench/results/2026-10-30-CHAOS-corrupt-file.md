# CHAOS corrupt-file — Tenant file corrupted — 2026-10-30
Hardware: dev-laptop (Intel(R) Core(TM) i7-6700 CPU @ 3.40GHz, kernel 7.0.0-38-generic), renox-worker 03e8319, bun 1.4.4
Scenario: 5 rows written and replicated, the cell evicted (idle 2 s) and its sidecar stopped, then the tenant's app.db overwritten with 8 KiB of 0xAB (WAL and SHM removed)
Failure modes: "SQLite file corrupted, WAL unreadable" (docs/23-failure-modes.md)
Result: first answer 503, restored in 0.1 s with 5 of 5 rows, 1 quarantine file(s)
Target: 503 RENOX_DB_UNAVAILABLE, automatic restore, 200 with every replicated row, quarantine kept, neighbours unaffected → PASS
Alerts: RenoxTenantFileRestoring (reads renox_worker_db_unavailable (pending #295))
Checks:
- [x] 503 RENOX_DB_UNAVAILABLE first: 503 {"error":{"code":"RENOX_DB_UNAVAILABLE","request_id":"01M6661S64FAKS3P2W0TEP7911","message":"The service is temporarily 
- [x] restored automatically with its rows: 200 with n = 5 after 0.1 s
- [x] the damaged file is kept: app.db.corrupt-1793356522694
- [x] no impact on a neighbour: t-chaos-d on the same node: 1×200
Notes: none
Raw: not kept (a local run on the owner's machine, batch F67-ALL; disk at 80–81 % used, so /healthz reports disk warn).
