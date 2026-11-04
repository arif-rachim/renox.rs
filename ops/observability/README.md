# ops/observability

Prometheus, alert rules and Grafana dashboards for a Renox region (#296). An operator opens one Grafana page per node, one per tenant and one for the control plane, and gets paged on the conditions of `docs/23-failure-modes.md`.

| File | What it is |
| --- | --- |
| `prometheus.yml` | Scrapes the workers on their control endpoint (file-based discovery from `targets/nodes.json`, node network only) and the control plane at `GET /v1/ops/metrics` with an `ops:read` operator token from `secrets/ops-read-token` |
| `rules/*.yml` | Alert rules; each names its `docs/23` row in `annotations.failure_mode` |
| `alertmanager.yml` | Routing to one receiver, `operator`: a webhook whose URL is the file `secrets/webhook_url` on the monitoring host (email as a commented alternative). The URL never goes in this repository (#450) |
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
| `renox_cp_node_disk_level` | gauge | `node_id` | control plane (the heartbeat's `disk`, deploy API 0.4, #311: 0 ok, 1 warn, 2 critical) | exists (#311) |
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
| `renox_worker_requests_total` | counter | `tenant_id`, `status_class` | worker | exists (#295) |
| `renox_worker_request_duration_seconds` | histogram | `tenant_id` | worker | exists (#295) |
| `renox_worker_cpu_seconds_total` | counter | `tenant_id` | worker | exists (#295) |
| `renox_worker_heap_bytes` | gauge | `tenant_id` | worker | exists (#295) |
| `renox_worker_cold_starts_total` | counter | `tenant_id` | worker | exists (#295) |
| `renox_worker_cold_start_duration_seconds` | histogram | | worker | exists (#295) |
| `renox_worker_outbox_pending` | gauge | `tenant_id` | worker | exists (#295) |
| `renox_worker_outbox_oldest_age_seconds` | gauge | `tenant_id` | worker | exists (#295) |
| `renox_worker_dead_letters_total` | counter | `tenant_id` | worker | exists (#295) |
| `renox_worker_realtime_connections` | gauge | `tenant_id` | worker | exists (#295) |
| `renox_worker_realtime_messages_total` | counter | `tenant_id` | worker | exists (#295) |
| `renox_worker_authz_decisions_total` | counter | `tenant_id`, `decision` | worker (`decision` is `all` until the engine counts allows and denies apart) | exists (#295) |
| `renox_worker_authz_principal_cache_total` | counter | `tenant_id`, `result` | worker | exists (#295) |
| `renox_worker_cells` | gauge | | worker | exists (#295) |
| `renox_worker_sandbox_denials_total` | counter | `kind` | worker | exists (#295, `telemetry::counters`) |
| `renox_worker_replication_lag_seconds` | gauge | `tenant_id`, `database` | worker | exists (#295, `telemetry::counters`) |
| `renox_worker_process_restarts_total` | counter | `tenant_id` | worker | exists (#295, `telemetry::counters`) |
| `renox_worker_degraded` | gauge | `component` | worker (`/healthz` reasons) | exists (#295) |
| `renox_worker_disk_used_ratio` | gauge | | worker (`crate::disk`, #103) | exists (#295) |
| `renox_worker_disk_level` | gauge | | worker (`crate::disk`, #103: 0 ok, 1 warn, 2 no new cells, 3 no writes) | exists (#295) |
| `renox_worker_db_unavailable` | gauge | | worker (files being restored after damage, #103) | exists (#295, `telemetry::counters`) |
| `renox_worker_log_lines_sampled_out_total` | counter | | worker (`crate::pruning`, #103) | exists (#295, `telemetry::counters`) |

The worker families are served by `GET /metrics` on the worker's operator listener (`[control] health_listen`, #295: `crates/renox-cell/src/telemetry/metrics.rs`) under these names. The last five families (`renox_worker_sandbox_denials_total`, `renox_worker_replication_lag_seconds`, `renox_worker_process_restarts_total`, `renox_worker_db_unavailable`, `renox_worker_log_lines_sampled_out_total`) are counted where their events happen (`crates/renox-cell/src/telemetry/counters.rs`): a child killed by seccomp (SIGSYS), a child restart, the lag of the last replication status computed, the databases being restored after damage, the lines the volume limit sampled out; a change to a name changes this table, the rules and the dashboards in the same PR (`check.ts` fails otherwise).

## Alerts

| Rule | Severity | Reads | `docs/23` row | Works today |
| --- | --- | --- | --- | --- |
| `RenoxNodeUnhealthy` | page | `renox_cp_node_healthy` | Node dies | yes |
| `RenoxNodeHeartbeatLate` | ticket | `renox_cp_node_heartbeat_age_seconds` | Node dies | yes |
| `RenoxNodeDiskCritical` | page | `renox_cp_node_disk_level` | Disk full on node | yes (#311) |
| `RenoxNodeNearlyFull` | ticket | `renox_cp_node_cells`, `renox_cp_node_max_cells` | Node dies | yes |
| `RenoxDiskWatermarkWarn` | ticket | `renox_worker_disk_level` | Disk full on node | yes (#295) |
| `RenoxDiskWatermarkStop` | page | `renox_worker_disk_level` | Disk full on node | yes (#295) |
| `RenoxObjectStorageUnreachable` | page | `renox_worker_degraded` | Object storage unreachable | yes (#295) |
| `RenoxSandboxDenialsSpike` | page | `renox_worker_sandbox_denials_total` | Worker process crashes | after #295 |
| `RenoxOutboxOldestAge` | ticket | `renox_worker_outbox_oldest_age_seconds` | Outbox or logs grow unbounded | yes (#295) |
| `RenoxDeadLetters` | ticket | `renox_worker_dead_letters_total` | Event handler fails repeatedly | yes (#295) |
| `RenoxTenantErrorRatio` | ticket | `renox_worker_requests_total` | Worker process crashes | yes (#295) |
| `RenoxColdStartP95` | ticket | `renox_worker_cold_start_duration_seconds` | Isolate evicted while a request arrives | yes (#295) |
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
printf '%s' "$ALERT_WEBHOOK_URL" > ops/observability/secrets/webhook_url                # where alerts go
docker compose -f ops/observability/docker-compose.observability.yml up
```

Grafana answers on `http://localhost:3000`, Prometheus on `:9091` (9090 is the worker's `health_listen`), Alertmanager on `:9093`, all on `127.0.0.1` only. For a control plane on the laptop, set the `renox-control-plane` target to `host.docker.internal:<port>` with `scheme: http`.

## Alertmanager on the single host (#450)

The worker's `health_listen` is `127.0.0.1:9090` (`ops/single-host.md`, step 7), Prometheus's default port, so on `node-small` the monitoring stack moves: Prometheus on `127.0.0.1:9091`, Alertmanager on `127.0.0.1:9093` with its cluster port off. Both stay on loopback; the firewall keeps them closed anyway.

1. **Receiver.** Create the incoming webhook in the chat or pager the owner reads (Slack, Mattermost, ntfy, a pager's webhook; an `https://` URL). Put it on the host twice, root-only:
   ```
   install -d -m 0750 -o root -g nogroup /etc/alertmanager/secrets
   printf '%s' '<webhook url>' | install -m 0640 -o root -g nogroup /dev/stdin /etc/alertmanager/secrets/webhook_url
   printf 'ALERT_WEBHOOK_URL=%s\n' '<webhook url>' | install -m 0600 -o root -g root /dev/stdin /etc/renox/secrets/alert.env
   ```
   The second file is what `renox-alert@.service` reads when the backup or the billing rollup fails (`ops/single-host.md`, step 11).
2. **Alertmanager.** Install the release (`apt-get install -y prometheus-alertmanager`, or the `prom/alertmanager` v0.28 tarball with its SHA-256), copy `alertmanager.yml` to `/etc/alertmanager/alertmanager.yml`, and run it with `--web.listen-address=127.0.0.1:9093 --cluster.listen-address=` (Debian and Ubuntu: `ARGS=` in `/etc/default/prometheus-alertmanager`). `amtool check-config /etc/alertmanager/alertmanager.yml` must pass, then `systemctl restart prometheus-alertmanager`.
3. **Prometheus.** `--web.listen-address=127.0.0.1:9091`, with `prometheus.yml` and `rules/` from this folder; its `alerting` target is `127.0.0.1:9093` on the host (`alertmanager:9093` is the compose service name).
4. **Check.** `curl -fsS http://127.0.0.1:9093/-/ready`, then send a test alert and see it arrive:
   ```
   amtool --alertmanager.url=http://127.0.0.1:9093 alert add renox_test severity=page instance=node-small
   ```

## Checks (CI's lint job)

```sh
promtool check rules ops/observability/rules/*.yml      # the release in prometheus.lock
promtool check config ops/observability/prometheus.yml  # rule files and secrets resolve on the monitoring host only: CI checks the rules
bun ops/observability/check.ts                          # dashboards and rules against this README
docker compose -f ops/observability/docker-compose.observability.yml config -q
amtool check-config ops/observability/alertmanager.yml   # the receiver's file resolves on the monitoring host only
```

`check.ts` refuses: a dashboard that is not valid JSON, lacks a `uid`, `title`, `schemaVersion` or `panels`, repeats a panel id, has overlapping panels, or names a data source other than `renox-prometheus`; a target without an expression; a rule without `alert`, `expr`, a `severity` of `page` or `ticket`, a `summary`, or a `failure_mode` that is the first cell of a `docs/23-failure-modes.md` row; any expression that reads a family missing from the table above; and an alert missing from the alert table (or the reverse).
