# CHAOS pubsub-drop — Realtime pub/sub link dropped — 2026-10-29
Hardware: dev-laptop (Intel(R) Xeon(R) Processor @ 2.10GHz, kernel 6.18.44-fc-v185), renox-worker 66b0040, bun 1.4.4
Scenario: realtime clients connected while the pub/sub link drops (F5)
Failure modes: "WebSocket message flood / oversized frame" (docs/23-failure-modes.md)
Result: skipped: renox-realtime does not exist yet (F5: #278, #281)
Target: clients closed with the ops.md section 18 code and reconnect; other tenants unaffected → SKIPPED
Alerts: none
Checks:
Notes: docs/23 has no row for a lost pub/sub link yet; the realtime row named is the nearest, and F5 adds the row with the crate.
Raw: bench/results/raw/2026-10-29-CHAOS-pubsub-drop.json
