# Contracts

A contract is the written interface between two tracks (`docs/18-build-plan.md`, "a track may consume another track's output only through a written contract"; `docs/22-development-plan.md`, section 2). Both sides build against the merged contract, so the Rust and TypeScript work can run in parallel without waiting on each other's code.

Rules:

- Only `type:contract` issues change files here. A breaking change bumps the contract's version and lands in one PR together with both consumers.
- Each contract has a prose document, a machine-readable schema, and at least one valid and one invalid example per message under `examples/<contract>/`.
- Unresolved points are listed at the end of each document under "Open".

| Contract | Between | File | Issue | Status |
| --- | --- | --- | --- | --- |
| Runtime ops and `ctx` | `renox-runtime` (P1) ↔ SDK (P10), cell (P5) | [`ops.md`](ops.md), [`ctx.d.ts`](ctx.d.ts), [`ops.schema.json`](ops.schema.json) | #12 (v0), #17, #153, #201, #206, #226, #263, #272, #315 | 1.6.0 (principal, `guard`, `op_authz_*`, `db.scoped()`, realtime, App MCP, jobs; the `jobs` module's `op_jobs_list` / `_retry` / `_cancel`; implemented by F5-ALL and #297) |
| Artifact format and route table | cell (P5), gateway (P3), CLI (P11) ↔ control plane (P12) | [`artifact.md`](artifact.md), [`schemas/manifest.schema.json`](schemas/manifest.schema.json), [`schemas/route-table.schema.json`](schemas/route-table.schema.json) | #15 (v0), #152, #227, #263, #272, #318, #346, #363 | 1.5.1 (v0 accepted; 1.5.1: the platform domain, #363) |
| Meter record | `renox-meter` (P4) ↔ billing (P14) | [`meter.md`](meter.md), [`schemas/meter-record.schema.json`](schemas/meter-record.schema.json) | #16 (v0), #152, #226, #272 | 0.3 |
| Client events | client script (P10) ↔ gateway (P3) ↔ dashboard (P13) | [`client-events.md`](client-events.md), [`schemas/client-event.schema.json`](schemas/client-event.schema.json) | #125 | v0 |
| Error codes | every component ↔ tenants | [`errors.md`](errors.md) | #91 (v0), #152, #50, #251, #272, #315 | 0.4 (+ `RENOX_JOB_*`) |
| Module manifest, `renox.toml [modules]`, `renox.lock` | broker (P9) ↔ CLI (P11) ↔ modules | [`manifest.md`](manifest.md), [`schemas/module-manifest.schema.json`](schemas/module-manifest.schema.json), [`schemas/renox-lock.schema.json`](schemas/renox-lock.schema.json) | #225, #272 | 1.1 |
| Deploy API, worker control messages, node listener | CLI (P11), cell (P5), dashboard (P13) ↔ control plane (P12) | [`deploy-api.md`](deploy-api.md), [`schemas/deploy-api.yaml`](schemas/deploy-api.yaml), [`schemas/node-listener.yaml`](schemas/node-listener.yaml), [`schemas/control-messages.schema.json`](schemas/control-messages.schema.json) | #50, #184, #222, #251, #273, #303, #315, #319, #346, #363 | 0.5.2 (0.5.2: the API, dashboard and tenant hosts, #363) |

## Domains

The reference deployment (#363) uses two domains, split on purpose:

| Domain | Serves |
| --- | --- |
| `renox.rs` (the **platform domain**) | Tenant apps only: `<app>.renox.rs`, preview hosts `<app>-<hash>.renox.rs`, the custom-domain CNAME target `edge.renox.rs`. On the Public Suffix List (`ops/psl/`). |
| `renoxium.com` | The company and the platform's own services: the site at `renoxium.com`, `dashboard.renoxium.com`, `api.renoxium.com`, `mcp.renoxium.com`, `docs.renoxium.com`; mail (`security@`, `abuse@`, `support@renoxium.com`). |

Why: a tenant's phishing page must never cost the company domain its reputation, its mail deliverability or the dashboard's cookies (`docs/24-threat-model.md` C, "Shared-domain reputation" and "Custom domain takeover"). Rule: **a platform service never lives under the platform domain.** The reserved slugs of `control/api/src/apps/slugs.ts` (`api`, `dashboard`, `www`, and the rest) stay as defence in depth, so no tenant can claim such a name even if an operator puts a service there by mistake.

Both domains are operator configuration (`CONTROL_PLATFORM_DOMAIN`, `CONTROL_DASHBOARD_URL` and the other settings of `control/api`, `worker.toml` for a node); the values above are the reference deployment, so the contracts stay operator-neutral. A contract that names a host writes `<app>.<platform domain>` in prose and the reference values in examples.

Schema `$id` values (`https://renoxium.com/contracts/<contract>/v<n>/<file>`) are names, not URLs anyone fetches: consumers load the files from this directory and use the `$id` only to resolve `$ref` between them. The OpenAPI file `schemas/deploy-api.yaml` has no `$id` keyword; its name is `https://renoxium.com/contracts/deploy-api/v0/deploy-api.yaml` (`control/api/src/contract.ts`).

## Checking

```
bunx tsc --noEmit -p docs/contracts      # ctx.d.ts and the type-level examples in ctx.usage.ts
bun run docs/contracts/validate.ts       # JSON examples vs schemas, artifact rules V1-V27, meter rule M1 (and the route form per kind in the meter schema), client-event rules CE1-CE2, route rules R1-R3,
                                         # module manifest rules MF1-MF14 (TOML examples and example projects),
                                         # deploy-api.yaml examples and state machines, error catalogue vs ops.md/ctx.d.ts/deploy-api/23-failure-modes.md
```

Schemas are JSON Schema 2020-12: `ops.schema.json` at the top level, the others under `schemas/`; `schemas/deploy-api.yaml` is OpenAPI 3.1, whose schemas use the same keyword subset and may `$ref` the files under `schemas/`. `*.valid.json` files must validate and `*.invalid.json` files must not; each invalid file says why in `$comment`, and `[expect: <reason>]` in that comment makes `validate.ts` check it fails for that reason. The TOML examples of `manifest.md` (`examples/manifest/`) carry the same `[expect: <reason>]` in a TOML comment instead. `validate.ts` has no dependencies and implements only the schema keywords these files use; a schema with any other keyword fails the check.
