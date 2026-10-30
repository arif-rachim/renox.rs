# renox-authz

The policy engine of a deployment: Cedar (`cedar-policy`, ADR D15) behind a fail-closed API. The design is `docs/11-authorization.md`; the contract is `docs/contracts/ops.md` 1.5.0 section 17 and `artifact.md` 1.3 ("Policies", V24). A leaf crate: no other Renox crate, no V8, no database.

## What it does

| Call | What |
| --- | --- |
| `MergedSchema::build(owners, app_schema)` | The platform schema, one namespace per owner from its `authz` block, and the app's `policies/schema.cedarschema`, merged. Duplicate actions or entity types, an action declared outside `[authz] actions`, a `sensitive` action the owner does not define, and a role granting an unknown action are errors |
| `PolicySet::load(files, &schema)` | Parses every `policies/**/*.cedar` file and validates the set in **strict** mode. Every error is collected as `PolicyError { file, line, column, message }`, the body of `RENOX_POLICY_INVALID`. Policy ids: `@id("…")` when present, else `<file>#<n>` |
| `Engine::check` / `check_batch` | One decision (or one per resource) for a principal given as a value |
| `Engine::check_topic` | `realtime.subscribe` on `Renox::Topic::"<name>"` |
| `Engine::action_set` | The resource-less actions allowed: `r-can` without a resource, fragment cache keys |
| `Engine::explain` | The deciding policies in text, and the errors (dev mode only: the caller enforces that) |
| `DecisionCache` | Decisions keyed by principal, action, resource, and context; TTL from the caller; `invalidate(principal_id)`; `stats()` for the metrics endpoint |

## Entity model

| Cedar | Built from |
| --- | --- |
| `Renox::User::"<id>"` | A `user` principal; attributes from `attrs` (JSON → Cedar: string, boolean, integer → `Long`, array → `Set`, object → record; floats and `null` dropped); parents: the roles **in effect** |
| `Renox::Role::"<role>"` | No attributes. A `global` assignment is in effect always; any other while the principal's attribute named by `scope_type` equals `scope_id` |
| `Renox::Anonymous::"anonymous"`, `Renox::System::"<module>"` | No attributes, no parents |
| `Renox::Topic::"<name>"` | `name`, `segments` (`Set<String>`, the `:`-separated parts) |
| `<Module>::<Type>::"<id>"` | A resource from `[authz.entities]`: only the declared `attrs` |
| `Renox::Action::"<action>"` | Every action of the merged set; `Renox::Action::"sensitive"` groups the `sensitive` ones |

The schema declares these `Renox::User` attributes (what `auth.principal` and the official fillers set): `id: String` (always the principal id, set by the platform), `created_at: Long`, `email_verified: Bool`, `mfa_verified: Bool`, `org: String`, `phone_verified: Bool`. A policy may name only these. They are declared required, so a policy that reads one needs no `has` guard; a principal without it is an evaluation error at run time, hence a deny.

Entity attribute types: a manifest names attributes only, so the caller passes their Cedar types (`Owner::with_type`; `AttrType::from_sqlite` maps a SQLite declared column type: `INT` → `Long`, `BOOL` → `Bool`, else `String`). When the app's schema declares an `App::<Type>` itself, its declaration is used and none is generated.

The context of every evaluation is the caller's `context` with `mfa_verified` (from the principal, `false` when absent), `now` (Unix ms), and `request` (`{ method, path }`, absent outside a request) written over it. Caller keys are passed through; a policy reads them after `context has <key>`.

A check without a resource is evaluated against `Renox::Action::"<action>"` (the contract). A Cedar schema cannot list an action as a resource type, so the schema's `appliesTo` carries the stand-in `Renox::Global` for type checking: a policy for such a check leaves `resource` unconstrained.

## Fail closed

| Case | Decision |
| --- | --- |
| No permitting policy | deny, `deny` |
| A `forbid` applies | deny, `deny`, `policies` = the forbids |
| An action outside the merged set (also `realtime.subscribe` through `check`) | deny, `unknown_action` |
| Unknown resource type, missing or `null` declared attribute, no `id` | deny, `missing_attribute` |
| Any policy errors (a missing principal attribute, a type error) | deny, `evaluation_error` with the messages, **even when a permit applies**: Cedar alone skips an erroring forbid |

The eval limit (`eval_limit`) and `dev_only` are the cell's (#279).

## The cache

`CacheKey::new(principal, action, resource, context)` hashes the principal's id, kind, roles in effect and attributes, the resource's type, id, and attribute values, and the context. The cell uses one `DecisionCache` per cell with the principal cache's TTL and calls `invalidate` on the principal cache's three invalidations (`ops.md` section 17). A full cache is emptied; it is never a correctness boundary.

## What the cell must supply

- The owners: the app's `authz` and each module entry's `authz`, with attribute types from the entity tables.
- The policy files and the app schema from the artifact's `policies/`.
- The principal (from `auth.principal`, cached), the `PlatformContext`, and the `module` of the `ctx` a call came through.
- The eval count (`authz_evals`), the 10,000 limit, the audit row for `is_sensitive` actions, and the dev-mode rule for `explain`.

## Performance

`benches/eval.rs`: 200 policies, a principal with 20 roles. Targets (`docs/11`, "Performance"): cached ≤ 50 µs, cold ≤ 500 µs. Results: `bench/results/*-authz-eval-dev-container.md`.
