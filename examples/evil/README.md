# examples/evil

A Renox app in which every function is an attack. It is the fixture for the runtime limit tests (`crates/renox-runtime/tests/limits.rs`, `tests/fetch.rs`), for B12 (noisy neighbour), and from F2 for B13 (template DoS). Each attack names the limit that has to stop it and what the client and the meter must show afterwards. Limits and behaviour: `docs/contracts/ops.md` sections 2, 3 and 10. Threats: `docs/04-isolation-security.md`, `docs/24-threat-model.md`. Failure modes: `docs/23-failure-modes.md`.

Never deploy this app anywhere except a test cell.

## Functions

| Function | Attack | Limit that stops it | HTTP status | Meter `status` | Used by |
| --- | --- | --- | --- | --- | --- |
| `GET /api/loop` | `for (;;) {}`: infinite loop, never yields | Per-request CPU watchdog → `TerminateExecution`, isolate recycled (50 ms free / 500 ms paid; must stop before 2× the limit) | 503 `RENOX_CPU_LIMIT` | `cpu_limit` | limits test (#26); B12 tenant A |
| `GET /api/alloc` | Pushes 8 MB arrays into a module-level array until the heap is full | V8 heap limit + near-heap-limit callback, isolate recycled (128 MB free / 512 MB paid) | 503 `RENOX_OOM` | `oom` | limits test (#26); B12 tenant A |
| `GET /api/hang` | `await new Promise(() => {})`: never resolves, uses no CPU | Wall-clock deadline (30 s free / 60 s paid); isolate kept | 504 `RENOX_DEADLINE` | `timeout` | limits test (#26) |
| `GET /api/slow?ms=N` | Busy-waits `N` ms of CPU (0 ≤ N ≤ 10,000), then answers `{ ms, spins }` | Below the CPU limit: none. Above it: CPU watchdog | 200; 503 `RENOX_CPU_LIMIT` when `N` exceeds the limit; 400 for a bad `ms` | `ok`; `cpu_limit` | B12 at a controlled rate (#35); limits test boundary |
| `GET /api/ssrf?target=metadata` | `fetch("http://169.254.169.254/latest/meta-data/")` | Fetch allowlist (`not_allowlisted`); with the IP listed, the blocked ranges (`blocked_address`) | 200 with `{ blocked: true, code: "RENOX_FETCH_BLOCKED", reason }` | `ok`, `fetch_blocked = 1` | fetch test (#27) |
| `GET /api/ssrf?target=localhost` | `fetch("http://localhost/")` | Allowlist; loopback range `127.0.0.0/8` / `::1` | 200, blocked | `ok`, `fetch_blocked = 1` | fetch test (#27) |
| `GET /api/ssrf?target=private` | `fetch("http://10.0.0.1/")` | Allowlist; private range `10.0.0.0/8` | 200, blocked | `ok`, `fetch_blocked = 1` | fetch test (#27) |
| `GET /api/ssrf?target=redirect` | `fetch("https://evil.redirect.test/api/redirect")`: allowlisted (`*.redirect.test`), answers 302 to `http://127.0.0.1/` | Every redirect hop is checked again: the second hop fails the allowlist and the loopback range | 200, blocked, `reason` from the second hop | `ok`, `fetch_blocked = 1` | fetch test (#27, #108) |
| `GET /api/ssrf?target=notlisted` | `fetch("https://example.org/")`; only `example.com` is listed | Allowlist (`not_allowlisted`) | 200, blocked | `ok`, `fetch_blocked = 1` | fetch test (#27) |
| `GET /api/ssrf?target=<any>&uncaught=1` | Same, but the error propagates out of the handler | Same | 500 `RENOX_INTERNAL` | `blocked_fetch` | fetch test (#27): uncaught path |
| `GET /api/redirect` | Helper for `ssrf?target=redirect`: 302 to `http://127.0.0.1/` | Not an attack by itself | 302 | `ok` | fetch test (#27) |
| `GET /api/leak` | `console.log`, a template string, `ctx.log.info` fields, and an `Error` message, all containing `ctx.secrets.FAKE_SECRET` | Secret redaction on every string leaving the isolate towards a log sink (ops.md section 3) | 200 with `{ present, attempts }`, never the value | `ok` | secrets/log test (#28): the test reads the log sink and expects `[redacted]` and no secret |

If a fetch in `ssrf` is not blocked, the handler answers 500 with `blocked: false`, so a policy hole can never look like a pass. A `slow` request above the CPU limit and a `loop` request end the same way; `slow` exists so B12 can control how much CPU tenant A burns.

## Configuration

`renox.toml`:

- `[permissions] network = ["example.com", "*.redirect.test"]`: `example.com` is there so that `notlisted` (example.org) is rejected by the allowlist itself. `*.redirect.test` lets the `redirect` attack's first hop through. The test maps `evil.redirect.test` to this app.
- `[permissions] secrets = ["FAKE_SECRET"]`: the test sets it to a value of at least 8 bytes, because shorter secret values are refused (ops.md section 3). Never use a real secret.

`ops.md` section 2 writes the allowlist as `[fetch] allow`. This app follows the issue and `docs/07-app-model.md` (`[permissions] network`), which is also what the artifact manifest field (`permissions.network`) is called. The CLI issue (#32) settles the `renox.toml` spelling.

Not here yet: the nested-loop template for B13 is added in F2 by the shop/evil template issue.

## Checks

```
bun run --filter @renox-examples/evil check   # tsc --noEmit
bun test examples/evil                        # slow, redirect, ssrf, leak with a fake ctx
```

The unit tests never call `loop`, `alloc`, or `hang`: those only end when a platform limit stops them.
