# Contracts

A contract is the written interface between two tracks (`docs/18-build-plan.md`, "a track may consume another track's output only through a written contract"; `docs/22-development-plan.md`, section 2). Both sides build against the merged contract, so the Rust and TypeScript work can run in parallel without waiting on each other's code.

Rules:

- Only `type:contract` issues change files here. A breaking change bumps the contract's version and lands in one PR together with both consumers.
- Each contract has a prose document, a machine-readable schema, and at least one valid and one invalid example per message under `examples/<contract>/`.
- Unresolved points are listed at the end of each document under "Open".

| Contract | Between | File | Issue | Status |
| --- | --- | --- | --- | --- |
| Runtime ops and `ctx` | `renox-runtime` (P1) ↔ SDK (P10), cell (P5) | [`ops.md`](ops.md), [`ctx.d.ts`](ctx.d.ts), [`ops.schema.json`](ops.schema.json) | #12 (v0), #17, #153, #201, #206, #226, #263, #272 | 1.5.0 (principal, `guard`, `op_authz_*`, `db.scoped()`, realtime, App MCP, jobs; implemented by F5-ALL and #297) |
| Artifact format and route table | cell (P5), gateway (P3), CLI (P11) ↔ control plane (P12) | [`artifact.md`](artifact.md), [`schemas/manifest.schema.json`](schemas/manifest.schema.json), [`schemas/route-table.schema.json`](schemas/route-table.schema.json) | #15 (v0), #152, #227, #263, #272 | 1.3 (v0 accepted) |
| Meter record | `renox-meter` (P4) ↔ billing (P14) | [`meter.md`](meter.md), [`schemas/meter-record.schema.json`](schemas/meter-record.schema.json) | #16 (v0), #152, #226, #272 | 0.3 |
| Client events | client script (P10) ↔ gateway (P3) ↔ dashboard (P13) | [`client-events.md`](client-events.md), [`schemas/client-event.schema.json`](schemas/client-event.schema.json) | #125 | v0 |
| Error codes | every component ↔ tenants | [`errors.md`](errors.md) | #91 (v0), #152, #50, #251, #272 | 0.4 |
| Module manifest, `renox.toml [modules]`, `renox.lock` | broker (P9) ↔ CLI (P11) ↔ modules | [`manifest.md`](manifest.md), [`schemas/module-manifest.schema.json`](schemas/module-manifest.schema.json), [`schemas/renox-lock.schema.json`](schemas/renox-lock.schema.json) | #225, #272 | 1.1 |
| Deploy API, worker control messages, node listener | CLI (P11), cell (P5), dashboard (P13) ↔ control plane (P12) | [`deploy-api.md`](deploy-api.md), [`schemas/deploy-api.yaml`](schemas/deploy-api.yaml), [`schemas/node-listener.yaml`](schemas/node-listener.yaml), [`schemas/control-messages.schema.json`](schemas/control-messages.schema.json) | #50, #184, #222, #251 | 0.3 |

## Checking

```
bunx tsc --noEmit -p docs/contracts      # ctx.d.ts and the type-level examples in ctx.usage.ts
bun run docs/contracts/validate.ts       # JSON examples vs schemas, artifact rules V1-V27, meter rule M1 (and the route form per kind in the meter schema), client-event rules CE1-CE2, route rules R1-R3,
                                         # module manifest rules MF1-MF14 (TOML examples and example projects),
                                         # deploy-api.yaml examples and state machines, error catalogue vs ops.md/ctx.d.ts/deploy-api/23-failure-modes.md
```

Schemas are JSON Schema 2020-12: `ops.schema.json` at the top level, the others under `schemas/`; `schemas/deploy-api.yaml` is OpenAPI 3.1, whose schemas use the same keyword subset and may `$ref` the files under `schemas/`. `*.valid.json` files must validate and `*.invalid.json` files must not; each invalid file says why in `$comment`, and `[expect: <reason>]` in that comment makes `validate.ts` check it fails for that reason. The TOML examples of `manifest.md` (`examples/manifest/`) carry the same `[expect: <reason>]` in a TOML comment instead. `validate.ts` has no dependencies and implements only the schema keywords these files use; a schema with any other keyword fails the check.
