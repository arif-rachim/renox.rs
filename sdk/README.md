# `renox`: the SDK for tenant code

Types and small helpers for Renox functions. Contract: [`docs/contracts/ops.md`](../docs/contracts/ops.md) version `1.0.0-f1` and [`docs/contracts/ctx.d.ts`](../docs/contracts/ctx.d.ts). The types here are identical to the contract; `tests/contract.test-d.ts` fails the `check` script if they drift.

The package is workspace-local in F1 (`"renox": "workspace:*"`). It is runtime-neutral: no Bun, Node, or Deno APIs, so the same import works under `renox dev`, in the worker, and in `bun test`.

```ts
// functions/api/notes/[id].ts
import type { Handler } from "renox";

export const GET: Handler = async ({ db, params }) => {
  const note = await db.queryOne("select id, title from notes__notes where id = ?", [params.id as string]);
  return note ? Response.json(note) : new Response(null, { status: 404 });
};
```

## F1 surface

| Export | Kind | Contract |
| --- | --- | --- |
| `Handler`, `Ctx`, `FunctionModule`, `HttpMethod`, `Params` | types | ops.md section 6 |
| `Db`, `DbStatements`, `ExecuteResult`, `Row`, `Value`, `Param` | types | ops.md section 1 |
| `Fetch` | type | ops.md section 2. The standard signature; the allowlist and blocked ranges are enforced in Rust |
| `Secrets` | type | ops.md section 3. Frozen; only declared and set secrets |
| `Log`, `LogLevel`, `LogFields`, `JsonValue` | types | ops.md section 4 |
| `Deadline` | type | ops.md section 5 |
| `RenoxError` and its subclasses (`DbPermissionError`, `DbBusyError`, `DbTimeoutError`, `DbQuotaError`, `DbConstraintError`, `DbSqlError`, `DbUsageError`, `FetchBlockedError`, `FetchError`, `FetchEgressLimitError`, `DeadlineError`) | classes | ops.md section 13 |
| `RenoxErrorCode`, `ResponseErrorCode`, `RENOX_ERROR_CODES`, `RESPONSE_ERROR_CODES`, `ErrorResponseBody` | types and constants | ops.md section 13, errors.md |
| `isRenoxError(e)` | function | Checks `e.code` instead of class identity: errors raised by the runtime glue are not guaranteed to be instances of the class a tenant bundled |
| `defineHandlers({ GET, POST })` | function | Optional sugar; returns its argument unchanged |

`ctx` fields in F1: `req`, `url`, `params`, `headers`, `db`, `fetch`, `secrets`, `log`, `deadline`.

The op-level types (`Ops`, `FetchRequest`, `FetchResponseHead`, `TxHandle`) are not exported: tenant code never sees ops, and the glue that calls them lives in `crates/renox-runtime/js`.

## Reserved, not in F1

Names reserved by ops.md section 8. They are not in `Ctx` yet, so using one is a type error until its phase ships.

| Phase | `ctx` fields and exports |
| --- | --- |
| F2 | `form`, `render`, `webhook`, `kv`; streamed `fetch` request bodies; `LoaderContext`/`ActionContext` and the page exports `load`, `actions`, `guard`; `cors` and `frame` options |
| F4 | `auth`, `session`, `config`, `events`, `hooks`; savepoints in `db`; query builders |
| F5 | `authz`, `realtime`, `db.scoped()`; `ws` and `sse` exports |
| F6 | `schedule` export for jobs; `datasource(name)` (F6–F7) |
| F7 | `ai`, `domains` |
| not scheduled | `offload` |

## Development

```sh
bun run --filter renox check   # tsc on src/ and the contract test, then on the bun tests
bun test sdk                   # error-code table and class behaviour
```
