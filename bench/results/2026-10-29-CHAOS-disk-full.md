# CHAOS disk-full — Disk full on a node — 2026-10-29
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, kernel 6.18.44-fc-v185), renox-worker 66b0040, bun 1.4.4
Scenario: each node's data directory on a 128 MiB loop-mounted ext4; the victim's filled to 92 %, then 96 %, then emptied (crate::disk polls every 5 s)
Failure modes: "Disk full on node" (docs/23-failure-modes.md)
Result: 92 %: no new cell: cold t-chaos-d: 503 (92.0 % used); 92 %: warm tenant reads and writes: POST 200, GET 200; 96 %: writes refused: POST 503 (96.0 % used); 96 %: reads go on: GET 200; the other node is unaffected: t-chaos-b on node-chaos-1: POST 200; freed: everything again: POST 200, cold GET 200; warm reads at every level: GET once a second on t-chaos-a: 13×200
Target: 92 %: a cold tenant 503 RENOX_UNAVAILABLE, warm reads and writes 200; 96 %: writes 503 RENOX_UNAVAILABLE, reads 200; other node unaffected; all 200 after freeing → PASS
Alerts: RenoxDiskWatermarkStop (reads renox_worker_disk_level (pending #295); the level is on /healthz)
Checks:
- [x] 92 %: no new cell: cold t-chaos-d: 503 (92.0 % used)
- [x] 92 %: warm tenant reads and writes: POST 200, GET 200
- [x] 96 %: writes refused: POST 503 (96.0 % used)
- [x] 96 %: reads go on: GET 200
- [x] the other node is unaffected: t-chaos-b on node-chaos-1: POST 200
- [x] freed: everything again: POST 200, cold GET 200
- [x] warm reads at every level: GET once a second on t-chaos-a: 13×200
Notes: none
Raw: bench/results/raw/2026-10-29-CHAOS-disk-full.json
