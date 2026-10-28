# `renox`: the SDK for tenant code

Types and small helpers for Renox functions. Contract: [`docs/contracts/ops.md`](../docs/contracts/ops.md) version `1.1.0` and [`docs/contracts/ctx.d.ts`](../docs/contracts/ctx.d.ts). The types here are identical to the contract; `tests/contract.test-d.ts` fails the `check` script if they drift.

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
| `LoaderContext`, `ActionContext`, `Session`, `Loader`, `Action`, `ActionResult`, `PageData`, `PageModule` | types | ops.md section 14 (pages) |
| `definePage({ load, actions })` | function | Optional sugar for a page module; returns its argument unchanged |
| `validate(input, Schema)`, `ValidationError`, `formToObject`, `StandardSchemaV1` | function, class, types | Input validation (`docs/04-isolation-security.md`), below |

`ctx` fields in F1: `req`, `url`, `params`, `headers`, `db`, `fetch`, `secrets`, `log`, `deadline`. Pages add `fragment` and `session` (loaders and actions) and `action`, `form` (actions); an action's `db` is its own transaction (`DbStatements`, no `transaction()`).

## Pages

```ts
// pages/products/[id].ts
import { type Action, type Loader, validate } from "renox";
import { z } from "zod";

export const load: Loader = async ({ db, params }) => {
  const product = await db.queryOne("select id, name, stock from app__products where id = ?", [params.id as string]);
  return product ? { product } : new Response(null, { status: 404 });
};

const AddToCart = z.object({ qty: z.coerce.number().int().min(1).max(99) });

export const actions: Record<string, Action> = {
  addToCart: async ({ form, db, session, params }) => {
    const { qty } = await validate(form, AddToCart);
    await db.execute("insert into app__cart (session_id, product_id, qty) values (?, ?, ?)", [session.id, params.id as string, qty]);
    return { fragments: ["cart_badge"] };
  },
};
```

## `validate(input, Schema)`

Validates before the handler body and returns the schema's output (transforms and defaults applied, typed from the schema). The schema is any [Standard Schema v1](https://standardschema.dev) implementation: zod 3.24+, valibot 1.0+, arktype. The SDK has no dependency on any of them.

| `input` | Read as |
| --- | --- |
| `Request` | Its body, once: JSON for `application/json` and `*+json`, a form for `application/x-www-form-urlencoded` and `multipart/form-data`. Any other content type fails |
| `FormData` (`ctx.form`), `URLSearchParams` (`ctx.url.searchParams`) | An object: a key seen once maps to its value (`string`, or `File`), a repeated key to an array of its values (`formToObject`) |
| anything else | As is |

On failure it throws `ValidationError` with `issues: { message, path }[]` (malformed JSON and an unsupported content type are one issue on the root path `[]`). It is not a `RenoxError` (no platform code): uncaught, it is a 500 like any other exception, so catch it and answer with `e.toResponse()` (400, `{ "issues": [...] }`) or your own page. A schema that is not a Standard Schema is a `TypeError`.

```ts
export const POST: Handler = async ({ req }) => {
  try {
    const order = await validate(req, OrderSchema);
    return Response.json(await place(order), { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) return e.toResponse();
    throw e;
  }
};
```

The op-level types (`Ops`, `FetchRequest`, `FetchResponseHead`, `TxHandle`) are not exported: tenant code never sees ops, and the glue that calls them lives in `crates/renox-runtime/js`.

## Reserved, not yet available

Names reserved by ops.md section 8. They are not in `Ctx` yet, so using one is a type error until its phase ships.

| Phase | `ctx` fields and exports |
| --- | --- |
| F2 | `render`, `webhook`, `kv`; streamed `fetch` request bodies; the page export `guard`; `cors` and `frame` options |
| F4 | `auth`, session data beyond `session.id`, `config`, `events`, `hooks`; savepoints in `db`; query builders |
| F5 | `authz`, `realtime`, `db.scoped()`; `ws` and `sse` exports |
| F6 | `schedule` export for jobs; `datasource(name)` (F6–F7) |
| F7 | `ai`, `domains` |
| not scheduled | `offload` |

## Development

```sh
bun run --filter renox check   # tsc on src/ and the contract test, then on the bun tests
bun test sdk                   # error-code table, class behaviour, validate() with zod and valibot
```
