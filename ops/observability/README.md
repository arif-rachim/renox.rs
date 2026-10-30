# ops/observability

Prometheus, alert rules and Grafana dashboards for a Renox region (#296). An operator opens one Grafana page per node, one per tenant and one for the control plane, and gets paged on the conditions of `docs/23-failure-modes.md`.

| File | What it is |
| --- | --- |
| `prometheus.yml` | Scrapes the workers on their control endpoint (file-based discovery from `targets/nodes.json`, node network only) and the control plane at `GET /v1/ops/metrics` with an `ops:read` operator token from `secrets/ops-read-token` |
| `rules/*.yml` | Alert rules; each names its `docs/23` row in `annotations.failure_mode` |
| `alertmanager.yml` | Routing with placeholder receivers (the paging integration is the owner's) |
| `grafana/provisioning/**`, `grafana/dashboards/*.json` | The data source (`renox-prometheus`) and the three dashboards, provisioned read-only |
| `docker-compose.observability.yml` | The whole stack on a laptop |
| `prometheus.lock` | The Prometheus release whose `promtool` CI runs, with its SHA-256 |
| `check.ts` | The dashboard and rule check CI runs (below) |

## Metric families

Two sources. The **control plane** (`control/api/src/ops/metrics.ts`) answers today, from Postgres. The **worker** families are served on each worker's control endpoint by #295 (OpenTelemetry and metrics in the crates); until it lands, the panels and alerts that read them show no data. `check.ts` refuses a dashboard or a rule that reads a family not in this table.

| Family | Type | Labels | Source | Status |
| --- | --- | --- | --- | --- |
| `renox_cp_up` | gauge | | control plane | exists |
| `renox_cp_node_healthy` | gauge | `node_id`, `region` | control plane | exists |
| `renox_cp_node_heartbeat_age_seconds` | gauge | `node_id` | control plane | exists |
| `renox_cp_node_cells` | gauge | `node_id` | control plane | exists |
| `renox_cp_node_max_cells` | gauge | `node_id` | control plane | exists |
| `renox_cp_tenants` | gauge | `tier`, `state` | control plane | exists |
| `renox_cp_tenants_moving` | gauge | | control plane | exists |
| `renox_cp_replication_databases` | gauge | | control plane (nodes' last reports) | exists |
| `renox_cp_replication_lag_max_seconds` | gauge | | control plane (nodes' last reports) | exists |
| `renox_cp_replication_lagging_databases` | gauge | | control plane (nodes' last reports) | exists |
| `renox_cp_replication_stale_reports` | gauge | | control plane (nodes' last reports) | exists |
| `renox_cp_failovers_total` | counter | `reason`, `status` | control plane | exists |
| `renox_cp_alerts_total` | counter | `kind` | control plane | exists |
| `renox_cp_deployments` | gauge | `state` | control plane | exists |
| `up` | gauge | `job`, `instance` | Prometheus | exists |
| `renox_worker_requests_total` | counter | `tenant_id`, `status_class` | worker | pending #295 |
| `renox_worker_request_duration_seconds` | histogram | `tenant_id` | worker | pending #295 |
| `renox_worker_cpu_seconds_total` | counter | `tenant_id` | worker | pending #295 |
| `renox_worker_heap_bytes` | gauge | `tenant_id` | worker | pending #295 |
| `renox_worker_cold_starts_total` | counter | `tenant_id` | worker | pending #295 |
| `renox_worker_cold_start_duration_seconds` | histogram | | worker | pending #295 |
| `renox_worker_outbox_pending` | gauge | `tenant_id` | worker | pending #295 |
| `renox_worker_outbox_oldest_age_seconds` | gauge | `tenant_id` | worker | pending #295 |
| `renox_worker_dead_letters_total` | counter | `tenant_id` | worker | pending #295 |
| `renox_worker_realtime_connections` | gauge | `tenant_id` | worker | pending #295 |
| `renox_worker_realtime_messages_total` | counter | `tenant_id` | worker | pending #295 |
| `renox_worker_authz_decisions_total` | counter | `tenant_id`, `decision` | worker | pending #295 |
| `renox_worker_sandbox_denials_total` | counter | `kind` | worker | pending #295 |
| `renox_worker_replication_lag_seconds` | gauge | `tenant_id`, `database` | worker | pending #295 |
| `renox_worker_process_restarts_total` | counter | `tenant_id` | worker | pending #295 |
| `renox_worker_degraded` | gauge | `component` | worker (`/healthz` reasons) | pending #295 |
| `renox_worker_disk_used_ratio` | gauge | | worker (`crate::disk`, #103) | pending #295 |
| `renox_worker_disk_level` | gauge | | worker (`crate::disk`, #103: 0 ok, 1 warn, 2 no new cells, 3 no writes) | pending #295 |
| `renox_worker_db_unavailable` | gauge | | worker (files being restored after damage, #103) | pending #295 |
| `renox_worker_log_lines_sampled_out_total` | counter | | worker (`crate::pruning`, #103) | pending #295 |

The worker families are this issue's proposal for #295, which owns the names in the end: if it changes one, it changes this table, the rules and the dashboards in the same PR (`check.ts` fails otherwise).

## Alerts

| Rule | Severity | Reads | `docs/23` row | Works today |
| --- | --- | --- | --- | --- |
| `RenoxNodeUnhealthy` | page | `renox_cp_node_healthy` | Node dies | yes |
| `RenoxNodeHeartbeatLate` | ticket | `renox_cp_node_heartbeat_age_seconds` | Node dies | yes |
| `RenoxNodeNearlyFull` | ticket | `renox_cp_node_cells`, `renox_cp_node_max_cells` | Node dies | yes |
| `RenoxDiskWatermarkWarn` | ticket | `renox_worker_disk_level` | Disk full on node | after #295 |
| `RenoxDiskWatermarkStop` | page | `renox_worker_disk_level` | Disk full on node | after #295 |
| `RenoxObjectStorageUnreachable` | page | `renox_worker_degraded` | Object storage unreachable | after #295 |
| `RenoxSandboxDenialsSpike` | page | `renox_worker_sandbox_denials_total` | Worker process crashes | after #295 |
| `RenoxOutboxOldestAge` | ticket | `renox_worker_outbox_oldest_age_seconds` | Outbox or logs grow unbounded | after #295 |
| `RenoxDeadLetters` | ticket | `renox_worker_dead_letters_total` | Event handler fails repeatedly | after #295 |
| `RenoxTenantErrorRatio` | ticket | `renox_worker_requests_total` | Worker process crashes | after #295 |
| `RenoxColdStartP95` | ticket | `renox_worker_cold_start_duration_seconds` | Isolate evicted while a request arrives | after #295 |
| `RenoxTenantFileRestoring` | page | `renox_worker_db_unavailable` | SQLite file corrupted, WAL unreadable | after #295 |
| `RenoxReplicationLag` | page | `renox_worker_replication_lag_seconds`, `renox_cp_replication_lag_max_seconds` | Replica lagging / Litestream behind | yes (control-plane view) |
| `RenoxFailoverRestoreFailed` | page | `renox_cp_alerts_total` | Node dies, restore fails | yes |
| `RenoxFailoverFailed` | ticket | `renox_cp_failovers_total` | Node dies, restore fails | yes |
| `RenoxControlPlaneDown` | page | `up`, `renox_cp_up` | Control plane unreachable from the worker | yes |
| `RenoxTenantStuckMoving` | ticket | `renox_cp_tenants_moving` | Worker process crashes | yes |

`page` wakes the on-call (`ops/security/incident-runbook.md` for security causes); `ticket` is for the next working day. The control plane's replication view refreshes when the API reads a node's status (`getBackups`); the worker's own lag gauge (#295) makes the lag alert continuous.

## Dashboards

| Dashboard | uid | Variable | Panels |
| --- | --- | --- | --- |
| Renox · Node | `renox-node` | `node` | health and heartbeat (today), cells and capacity (today); requests, latency p50/p95, CPU, heap, cold starts, disk level, sandbox denials, process restarts, sampled-out logs, damaged files (after #295) |
| Renox · Tenant | `renox-tenant` | `tenant` | requests, latency p50/p95, CPU, heap, cold starts, outbox depth and oldest age, dead letters, realtime connections and messages, authorization decisions, replication lag, process restarts (all after #295) |
| Renox · Control plane | `renox-control-plane` | | up, nodes healthy, tenants by tier and state, cells and heartbeat age per node, replication lag and stale reports, failovers, alert rows, tenants moving, deployments by state (all today) |

The tenant's own view (latency and realtime on the dashboard's Usage page) comes from the meter records, not from Prometheus: `control/dashboard/pages/apps/[app]/usage.ts`.

## Run it locally

```sh
cp ops/observability/targets/nodes.example.json ops/observability/targets/nodes.json   # your worker's [control] health_listen
printf '%s' "$RENOX_OPS_READ_TOKEN" > ops/observability/secrets/ops-read-token          # an operator token with ops:read
docker compose -f ops/observability/docker-compose.observability.yml up
```

Grafana answers on `http://localhost:3000`, Prometheus on `:9090`, Alertmanager on `:9093`, all on `127.0.0.1` only. For a control plane on the laptop, set the `renox-control-plane` target to `host.docker.internal:<port>` with `scheme: http`.

## Checks (CI's lint job)

```sh
promtool check rules ops/observability/rules/*.yml      # the release in prometheus.lock
promtool check config ops/observability/prometheus.yml  # rule files and secrets resolve on the monitoring host only: CI checks the rules
bun ops/observability/check.ts                          # dashboards and rules against this README
docker compose -f ops/observability/docker-compose.observability.yml config -q
```

`check.ts` refuses: a dashboard that is not valid JSON, lacks a `uid`, `title`, `schemaVersion` or `panels`, repeats a panel id, has overlapping panels, or names a data source other than `renox-prometheus`; a target without an expression; a rule without `alert`, `expr`, a `severity` of `page` or `ticket`, a `summary`, or a `failure_mode` that is the first cell of a `docs/23-failure-modes.md` row; any expression that reads a family missing from the table above; and an alert missing from the alert table (or the reverse).
