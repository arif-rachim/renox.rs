# examples/hello

The smallest valid Renox app: one function, `GET /api/hello`, returning `{"ok":true}` (`functions/api/hello.ts`). Structure follows `docs/07-app-model.md`.

## Benchmarks that use it (`docs/14-benchmarks.md`)

| ID | What it measures with this app |
| --- | --- |
| B4 | Cold start: snapshot + eszip load + the first request to `/api/hello` |
| B5 | Warm latency of the handler: `Response.json({ ok: true })` |
| B11 | Throughput of the same handler, 4 vCPU, keep-alive |

The handler does no I/O, so these numbers isolate the runtime's own cost.

## How it runs

- **F0 spike:** `_spike/index.ts` exposes the handler as a Supabase Edge Runtime user worker (`Deno.serve`). `bench/spike/edge-runtime/run.sh` (issue #3) points the runtime at that file. Files starting with `_` are not routes.
- **F1 and later:** `renox dev` routes `functions/api/hello.ts` to `/api/hello` itself; `_spike/` is no longer needed. The local `Handler` type is replaced by `import type { Handler } from "renox"` once the SDK exists.

## Checks

```
bun run --filter @renox-examples/hello check   # tsc --noEmit
bun test examples/hello                        # handler and spike adapter
```
