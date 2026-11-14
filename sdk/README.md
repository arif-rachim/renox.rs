# `@renoxium/sdk`: the SDK for tenant code

Types and small helpers for Renox functions. Contract: [`docs/contracts/ops.md`](../docs/contracts/ops.md) version `1.1.0` and [`docs/contracts/ctx.d.ts`](../docs/contracts/ctx.d.ts). The types here are identical to the contract; `tests/contract.test-d.ts` fails the `check` script if they drift.

The package is published to npm as `@renoxium/sdk` (below, "Install"; npm refuses the unscoped name `renox` as too close to `redux` and `detox`, D28); inside this repository the workspace link (`"@renoxium/sdk": "workspace:*"`) resolves the same `exports`. It is runtime-neutral: no Bun, Node, or Deno APIs, so the same import works under `renox dev`, in the worker, and in `bun test`.

```ts
// functions/api/notes/[id].ts
import type { Handler } from "@renoxium/sdk";

export const GET: Handler = async ({ db, params }) => {
  const note = await db.queryOne("select id, title from notes__notes where id = ?", [params.id as string]);
  return note ? Response.json(note) : new Response(null, { status: 404 });
};
```

## Install

```sh
bun add @renoxium/sdk        # or: npm install @renoxium/sdk
```

`renox new` writes this dependency at the CLI's own version (`"@renoxium/sdk": "^<cli version>"`, `cli/src/commands/new.ts`): the CLI and the SDK are released together from one `cli-v<version>` tag, by `.github/workflows/release-cli.yml` (binaries) and `.github/workflows/release-sdk.yml` (this package, `npm publish --provenance`). Keep them at the same version.

The package is MIT licensed (`LICENSE`). It ships compiled JavaScript and declarations under `dist/` (`bun run build`, `tsconfig.build.json`), plus this README and the license; `exports` maps `@renoxium/sdk`, `@renoxium/sdk/kysely`, `@renoxium/sdk/drizzle`, `@renoxium/sdk/fakes` and `@renoxium/sdk/test` to them, so `tsc`, Node and editors resolve it like any published package. `@renoxium/sdk/test` is Bun-only (`bun:test`, `bun:sqlite`); the rest has no runtime dependency. `tests/pack.test.ts` packs the package, installs the tarball into a fresh `renox new` app outside the repository, type-checks it and runs a test with `@renoxium/sdk/fakes`. Every publish carries npm provenance from the release workflow (`npm view @renoxium/sdk --json | jq .dist.attestations`, or the Provenance badge on npmjs.com).

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
import { type Action, type Loader, validate } from "@renoxium/sdk";
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

## Modules (`ops.md` 1.3.0, #226, #236)

`Ctx` carries `module`, `config`, `services`, `events`, `hooks`, and `password` (types identical to `docs/contracts/ctx.d.ts`). They are untyped there; the CLI generates the precise types of the installed modules from `renox.lock` and the manifests:

- `.renox/types/modules.d.ts`: `Modules` (per module: `services`, `events` with payload types from the manifest's JSON schemas, `hooks` with argument types, `config`) and `ModuleCtx<M>`, the ctx of module `M` (`"app"` by default).
- `.renox/types/renox-modules.d.ts`: `declare module "renox:modules"` with one export per module.

Service signatures are the module's own `services.ts`, inferred by the type checker (`ServicesOf<typeof import(".../services.ts")>`): the leading `ctx` is dropped and the result becomes a promise, so a call with a wrong argument is a type error. Helpers that only add types: `defineServices({...})`, `defineHooks({ hooks, on })`, `on<Payload>(handler)`. Errors: `ModuleUndeclaredError`, `ModuleServiceError` (`module`, `service`, `details.cause_code`), `EventPayloadError`.

```ts
import { defineServices } from "@renoxium/sdk";
import type { ModuleCtx } from "../../.renox/types/modules";

export const { chargeUser } = defineServices({
  async chargeUser(ctx: ModuleCtx<"billing">, userId: string, amount: number) {
    const user = await ctx.services.auth.getUser(userId); // typed from auth's services.ts
    return ctx.events.emit("billing.invoice_paid", { invoice_id: "inv_1", user_id: userId, amount }); // payload checked
  },
});
```

## Query builders: `@renoxium/sdk/kysely`, `@renoxium/sdk/drizzle` (#237)

Thin drivers over `ctx.db` (`docs/06-data.md`, "API layers"): every statement goes to `db.query` or `db.execute` with its `?` parameters in order, so the limits and the module authorizer apply as to raw SQL; there is no second execution path. Both libraries are optional peer dependencies (`kysely` 0.29, `drizzle-orm` 0.45): an app that does not import the subpath does not need them.

```ts
import { kysely } from "@renoxium/sdk/kysely";
import type { Tables } from "../.renox/types/db";
const rows = await kysely<Tables>(ctx).selectFrom("app__products").selectAll().where("id", "=", id).execute();
await kysely<Tables>(ctx).transaction().execute(async (tx) => { /* one IMMEDIATE transaction, a savepoint when nested */ });

import { drizzle } from "@renoxium/sdk/drizzle";
await drizzle(ctx).select().from(products).where(eq(products.id, id));
await ctx.db.transaction(async (tx) => drizzle({ db: tx }).insert(orders).values(row));
```

Drizzle's own `db.transaction()` sends `BEGIN` as SQL and is refused; use `ctx.db.transaction` with `drizzle({ db: tx })`. Drizzle wraps a failed statement in `DrizzleQueryError`; the platform's `RenoxError` is its `cause`. Kysely's error is the `RenoxError` itself. No streaming. Tests: `tests/{kysely,drizzle}.test.ts` (unit over bun:sqlite; on the worker with `RENOX_WORKER_PATH`, including the refusal of a table outside the app's prefix with the same error as raw SQL).

## Realtime, tools, jobs, TOTP and WebAuthn (#284)

| Module | Exports | What for |
| --- | --- | --- |
| `src/realtime.ts` | `defineWs`, `defineSse`, `topic(...segments)`, `isTopic` | Type a `ws` / `sse` export; build a topic the platform accepts (`ops.md` section 18). `ctx.realtime` itself is typed in `ctx.ts` |
| `src/tools.ts` | `tool(def)`, `toolInputSchema(schema)`, `INPUT_KEYWORDS` | Declare an App MCP tool (`ops.md` section 19). `tool()` checks the name, description, action and Standard Schema input, and defaults `confirm` to false. `toolInputSchema` gives the JSON Schema `renox build` records, through `~standard.jsonSchema.input` (zod 4.2+) or `toJSONSchema()`, reduced to the platform's keywords |
| `src/jobs.ts` | `defineJob`, `parseSchedule`, `isTimeZone` | A job's `schedule` (five cron fields) and `tz` (`ops.md` section 20); `renox build` uses the same parser (V27) |
| `src/totp.ts` | `generateTotpSecret`, `totpUri`, `totp`, `verifyTotp`, `base32Encode`, `base32Decode` | RFC 6238 on Web Crypto (SHA-1, SHA-256, SHA-512). `verifyTotp` accepts ±1 step (`window`) and refuses a step not after `lastStep`, so a code works once. Tests: the RFC's vectors |
| `src/webauthn.ts` | `verifyRegistration`, `verifyAssertion`, `webauthnChallenge`, `WebAuthnError`, `decodeCbor`, `base64url`, `fromBase64url` | Passkeys on Web Crypto. Registration checks the client data (type, challenge, origin), the RP id hash, user presence (and verification when asked), the attested credential (COSE ES256 or RS256), and `none` or `packed` self attestation; certificate chains are refused. Assertion checks the same, verifies the signature over `authenticatorData` and the client data hash, and refuses a counter that did not grow. Errors carry a `reason` |

Comparisons of secrets go through `timingSafeEqual` (`crypto.ts`).

## Authorization (`ops.md` 1.5.0 section 17, #283)

`ctx.authz` (`require`, `can`, `canBatch`, `explain`, `roles`), `ctx.principal`, the `Guard` export type, `ctx.db.scoped(scope)` and the errors `ForbiddenError` (`RENOX_FORBIDDEN`) and `DbScopeError` (`RENOX_DB_SCOPE`) are typed in `ctx.ts` and `errors.ts`, identical to `docs/contracts/ctx.d.ts`. `src/authz.ts` adds:

| Export | What it does |
| --- | --- |
| `defineGuard({ action, resource? })` | Types a page, function, ws or sse module's `export const guard` and returns it unchanged. It checks the shape: `action` is `<resource>.<verb>`, and `resource.id` is a literal or `":<param>"`. `renox build` reads the literal into the route entry |
| `resource(type, row)` | A `ResourceRef` from a database row (`id` as a string, the row's columns as attributes) |
| `isForbidden(e)` | Whether `e` is the `RENOX_FORBIDDEN` of a deny |
| `userScope(principal, extra?)` | `{ user_id, ...extra }` for `ctx.db.scoped()`; throws `ForbiddenError` without a user |
| `ScopedDb`, `ActionName` | The type of `ctx.db.scoped(...)`, and the `<resource>.<verb>` string type |

`@renoxium/sdk/test`: `policyCases(dir?)` and `policies()` run the policy test cases of `policies/tests/*.json` as tests (cli README, "Authorization").

## Tests: `@renoxium/sdk/test` (#238)

`app()` starts the worker of `renox test` on a fresh tenant file for the test file; the `TestApp` it returns has `request`, `page`, `action`, `as(user)`, `service(module)`, `tool`, `tools`, `ws`, `sse`, `logs`, `meters`, a read-only `db` and `dbFile` (`docs/12-developer-experience.md`, "renox test"). Two helpers stand in for hand-written outbox rows and JSON-RPC (#593):

```ts
const t = await app();
await t.job("nightly");                                  // jobs/nightly.ts runs now; resolves after its commit
await t.job("import", { payload: { batch: 2 } });        // a queued run, as ctx.jobs.enqueue("import", payload) writes it
await t.deliver("whatsapp.message_received", { message_id: "m1", from: "+971500000000" }, { module: "whatsapp" }); // a module event, to the app's on handler
const alice = t.as("alice");                             // signed in through the auth module's pages
const p = await t.tool("create_job", { day: "2026-11-09" }, { as: alice }); // { ok, preview, confirmation }
const r = await t.tool("create_job", { day: "2026-11-09" }, { as: alice, confirm: true }); // { ok, result }
await t.tool("create_job", { day: "2026-11-09" }, { as: alice, confirmation: "any-token" }); // that string as _meta["renox/confirmation"], as given: { ok: false, error: RENOX_TOOL_CONFIRM }
const { tools } = await t.tools({ as: alice, scope: "tools:job_status" }); // the tools/list result of that agent's token
```

- `job(name, { module?, timeoutMs? })` writes a tick of the job (as `renox jobs run`) and waits until its outbox row is gone; it rejects with the job's error text when a run fails, or after `timeoutMs` (10 s).
- `deliver(event, payload, { module, to?, timeoutMs? })` writes one durable delivery of the module event `event` (emitted by `module`) to `to` (`"app"`, the default, or a module name), as the outbox worker writes one (`ops.md` section 15.4, "Delivery"), and waits until the handler ran. Every call is its own delivery, so two calls run the handler twice. It rejects when `to` has no `on` handler for `event` (a typo fails the test), when the handler fails (the error names its failure), or after `timeoutMs` (10 s).
- `tool(name, input, { as?, scope?, confirm? })` gets an agent token for `as` (default the calling user) through the `auth` module's OAuth flow, once per user and scope, then calls `tools/call` on `/mcp`. A refusal is `{ ok: false, error: { code, message } }` (`RENOX_FORBIDDEN`, `RENOX_TOOL_SCOPE`, ...). Without the `auth` module it throws.
- `db` waits up to five seconds on the worker's write lock. A connection a test opens on `dbFile` with `bun:sqlite` should run `pragma busy_timeout = 5000` too, or it fails with `SQLITE_BUSY` while the worker writes.

## Reserved, not yet available

Names reserved by ops.md section 8. They are not in `Ctx` yet, so using one is a type error until its phase ships.

| Phase | `ctx` fields and exports |
| --- | --- |
| F2 | `kv`; streamed `fetch` request bodies; the page export `guard`; `cors` and `frame` options |
| F4 | query builders (`@renoxium/sdk/kysely`, `@renoxium/sdk/drizzle`, #237); `auth` and session data come from the `auth` module as services, not ctx fields |
| F5 | `ws` and `sse` exports' typed helpers (#284); `authz`, `realtime` and `db.scoped()` are typed above |
| F6 | `schedule` export for jobs; `datasource(name)` (F6–F7) |
| F7 | `ai`, `domains` |
| not scheduled | `offload` |

## Development

```sh
bun run --filter renox check   # tsc on src/ and the contract test, then on the bun tests
bun test sdk                   # error-code table, class behaviour, validate() with zod and valibot
```
