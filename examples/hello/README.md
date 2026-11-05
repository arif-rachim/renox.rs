# examples/hello

The smallest valid Renox app: one function, `GET /api/hello`, returning `{"ok":true}` (`functions/api/hello.ts`, typed with `Handler` from `@renoxium/sdk`). Structure follows `docs/07-app-model.md`. `renox new <name> --template hello` writes a larger app of the same name (a home page, a layout and a test as well); this folder is the benchmark fixture.

## Benchmarks that use it (`docs/14-benchmarks.md`)

| ID | What it measures with this app |
| --- | --- |
| B4 | Cold start: snapshot + artifact load + the first request to `/api/hello` |
| B5 | Warm latency of the handler: `Response.json({ ok: true })` |
| B11 | Throughput of the same handler, 4 vCPU, keep-alive |

The handler does no I/O, so these numbers isolate the runtime's own cost.

## Run it

From the repository root, with a worker binary (an installed `renox` brings its pinned one; from a checkout, `RENOX_WORKER_PATH`, see `README.md`, "Prebuilt `renox-worker`"):

```
cd examples/hello
renox dev                                     # or: bun ../../cli/src/main.ts dev
curl http://localhost:8787/api/hello          # {"ok":true}
```

`renox dev` routes `functions/api/hello.ts` to `/api/hello`. Files and folders starting with `_` are not routes.

`_spike/index.ts` is the F0 record: it exposed the same handler as a Supabase Edge Runtime user worker (`Deno.serve`) for `bench/spike/edge-runtime/run.sh` (issue #3), whose results under `bench/results/2026-10-27-*` cite it. It is kept so those runs can be repeated; nothing else uses it.

## Checks

```
bun run --filter @renox-examples/hello check   # tsc --noEmit
bun test examples/hello                        # handler and spike adapter
```
