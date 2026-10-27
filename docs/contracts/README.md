# Contracts

A contract is the written interface between two tracks (`docs/18-build-plan.md`, "a track may consume another track's output only through a written contract"; `docs/22-development-plan.md`, section 2). Both sides build against the merged contract, so the Rust and TypeScript work can run in parallel without waiting on each other's code.

Rules:

- Only `type:contract` issues change files here. A breaking change bumps the contract's version and lands in one PR together with both consumers.
- Each contract has a prose document, a machine-readable schema, and at least one valid and one invalid example per message under `examples/<contract>/`.
- Unresolved points are listed at the end of each document under "Open".

| Contract | Between | File | Issue | Status |
| --- | --- | --- | --- | --- |
| Runtime ops and `ctx` | `renox-runtime` (P1) ↔ SDK (P10), cell (P5) | [`ops.md`](ops.md), [`ctx.d.ts`](ctx.d.ts), [`ops.schema.json`](ops.schema.json) | #12 (v0), #17 | Draft v0 |
| Artifact format and route table | cell (P5), CLI (P11) ↔ control plane (P12) | `artifact.md` | #15 | Planned |
| Meter record | `renox-meter` (P4) ↔ billing (P14) | `meter.md` | #16 | Planned |
| Error codes | every component ↔ tenants | `errors.md` | #91 | Planned |
| Module manifest | broker (P9) ↔ CLI (P11) ↔ modules | `manifest.md` | F4 | Planned |
| Deploy API | CLI (P11) ↔ control plane (P12) | `deploy-api.md` | F3 | Planned |

## Checking

```
bunx tsc --noEmit -p docs/contracts      # ctx.d.ts and the type-level examples in ctx.usage.ts
```

The JSON examples conform to `ops.schema.json` (JSON Schema 2020-12). `*.valid.json` files must validate and `*.invalid.json` files must not; each invalid file says why in `$comment`.
