# Contract: module manifest, `renox.toml [modules]`, `renox.lock`

| | |
| --- | --- |
| Version | **1.2** (F7, #318: `registry:` sources, `[publisher]`, the `module.sig` file, `[storage]`, `price`; the lock's `key_id`, `signature`, and `approved_version`; `renox publish`; the `isolate` mode taking effect; rule MF15; for `artifact.md` 1.4). 1.1 (F5, #272: `[authz.ownership]`, `[authz.entities]`, `[authz.default_roles]`, `[authz] sensitive`, `[realtime.feeds]`, `[[tools]]` carried, `permissions.roles` and `approved.roles`, the `auth.principal` convention, `renox.toml [authz]` and `[realtime]`; rules MF13–MF14). 1 (F4, #225) is the first version. History: "Changelog" at the bottom |
| Producers | Module authors write `module.toml`; tenants write `renox.toml [modules]`; `cli/` (P11) writes `renox.lock` (`renox add`, `renox install`, `renox approve`, #235) |
| Consumers | `cli/` (P11): resolves, approves, checks, and copies the lock into the artifact's `modules` field (`artifact.md` section 3, #227); the module broker in `crates/renox-runtime` and `crates/renox-cell` (P9, #230, #231): enforces what the lock approved, through the artifact; `sdk/` (P10, #236): generates `renox-modules.d.ts`; every official module (`modules/*`, #237–#239) |
| Machine-readable | [`schemas/module-manifest.schema.json`](schemas/module-manifest.schema.json) (root: `module.toml`; `$defs/renoxToml`: `renox.toml`), [`schemas/renox-lock.schema.json`](schemas/renox-lock.schema.json) (JSON Schema draft 2020-12, applied to the parsed TOML) |
| Examples | [`examples/manifest/`](examples/manifest/): single files and whole projects (section 8) |
| Checker | `bun run docs/contracts/validate.ts` (schemas, examples, rules MF1–MF15) |
| Sources | `docs/10-modules.md` (the module system), `docs/18-build-plan.md` (catalog, definition of done for a module), `docs/13-decisions.md` D12 (isolation modes), D14 (outbox), D17 (forward-only migrations, versioned views), `docs/06-data.md` (authorizer and prefixes), `docs/24-threat-model.md` (module publisher boundary) |

A module is a mini app with the same folder structure as an app (`docs/10-modules.md`). Its `module.toml` says what it is, what it needs, and what it offers. A tenant installs modules in `renox.toml [modules]`; the CLI resolves them, asks the tenant to approve their permissions, and records the result in `renox.lock`. The lock is the only input the artifact takes from this contract: what the runtime enforces is what the tenant approved, never what a manifest asks for later.

All three files are TOML. The schemas validate the document a TOML parser produces (`Bun.TOML.parse` in `validate.ts`), so a TOML table is a JSON object and an array of tables is an array.

## 1. Files

| File | Written by | Where | Contents |
| --- | --- | --- | --- |
| `module.toml` | module author | root of the module tree (`modules/<name>/module.toml`, or a `path:`/`git:` source) | Section 2 |
| `renox.toml` `[modules]` | tenant | app root | Section 4. The other sections of `renox.toml` belong to the CLI and to `artifact.md` |
| `renox.lock` | CLI | app root, committed with the app | Section 5. Never edited by hand: `renox check` refuses a lock that does not match (MF12) |
| `module.sig` | `renox publish` (1.2) | root of a module tree published to the registry | Section 5, "Registry modules". Not part of the module tree hash |

Generated from these files and defined elsewhere:

- `renox-modules.d.ts` (#236): the types of `renox:modules` and `ctx.services` for the app and each module, from `[exports.services]` and the services' TypeScript signatures (`ops.md` 1.3.0, #226).
- The artifact's `modules` field (#227, `artifact.md` section 3): the lock entries, in lock order, with each module's exports.

## 2. `module.toml`

Abridged from [`examples/manifest/module.billing.valid.toml`](examples/manifest/module.billing.valid.toml) (the manifest of `docs/10-modules.md`):

```toml
[module]
name = "billing"
version = "1.2.0"

[dependencies]
auth = "^1.0"
org  = "^1.0"

[config]
provider = { type = "enum", values = ["stripe", "checkout", "telr", "paytabs", "ngenius"] }
currency = { type = "string", default = "AED", max_length = 3 }

[permissions]
tables  = "billing__*"
network = ["api.stripe.com", "secure.telr.com"]
secrets = ["BILLING_PROVIDER_KEY"]
slots   = ["admin.sidebar"]
roles   = ["finance", "viewer"]                  # 1.1: the roles the module may assign

[exports]
views = ["billing__public_user_plans_v1"]

[exports.services]
getActivePlan = "The user's active plan, or null"

[exports.events."billing.invoice_paid"]
payload = { type = "object", required = ["invoice_id", "user_id"], properties = { invoice_id = { type = "string" }, user_id = { type = "string" } } }

[imports]
services = ["auth.currentUser", "org.currentOrg"]

[[slots]]
name = "admin.sidebar"
template = "partials/admin-menu.html"
requires = "invoice.read"

[[tools]]
name = "create_invoice"
file = "tools/create-invoice.ts"
action = "invoice.create"

[authz]
actions   = ["invoice.read", "invoice.create", "invoice.refund"]
sensitive = ["invoice.refund"]                   # 1.1: audited, and the Renox::Action::"sensitive" group

[authz.ownership]                                # 1.1: db.scoped()
"billing__invoices" = { owner = "user_id", org = "org_id" }

[authz.entities]                                 # 1.1: Cedar entity Billing::Invoice
Invoice = { table = "billing__invoices", attrs = ["amount", "org_id", "status"] }

[authz.default_roles]                            # 1.1
finance = ["invoice.read", "invoice.refund"]
viewer  = ["invoice.read"]

[realtime.feeds]                                 # 1.1: the change feed
"billing__invoices" = "invoices:{org_id}"
```

No other tables or keys are allowed at any level (`additionalProperties: false`), so a typo can never silently drop a permission or an export.

### `[module]`

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | `^[a-z][a-z0-9_]{0,31}$`, no `__`, no trailing `_`, not `app`, `renox` or `authz` (MF1) | yes | The module's name **and its table prefix** `<name>__`. `app` is the tenant's own code (`artifact.md` section 1); `renox` is the platform (`renox__*` tables); `authz` is the platform's event namespace (`authz.roles_changed`, #272). The catalog name in `docs/18-build-plan.md` may differ where it is not a valid name: `gcc-data` is installed as `gcc` (tables `gcc__*`), `2fa` as `twofa` |
| `version` | semver `MAJOR.MINOR.PATCH[-pre]`, no build metadata | yes | The version of this tree. Public API changes follow semver (`docs/10-modules.md`, rule 3) |
| `isolation` | `"shared"` \| `"isolate"` | no, default `"shared"` | D12. The least isolation the module accepts; a tenant may raise it, never lower it (MF11). `shared`: one context with the app and other modules; `isolate`: its own isolate with its own heap limit, serialised service calls, and only its approved secrets (`ops.md` 1.7.0, section 15.6; runs from #320) |
| `description` | string, ≤ 200 | no | One line for `renox add` and the dashboard |
| `price` | `{ amount, currency, period }` (1.2) | no | Informational, shown by the registry and `renox add`: `amount` a decimal string (`"49.00"`), `currency` ISO 4217 (`"AED"`), `period` `"once"`, `"month"`, or `"year"`. Nothing is charged through it in F7 (payouts are an owner decision, `docs/15`) |

### `[publisher]` (1.2)

Required in a tree published with `renox publish`; ignored for `path:` and `git:` sources.

| Key | Type | Meaning |
| --- | --- | --- |
| `name` | `^[a-z0-9][a-z0-9-]{0,38}$` | The registry publisher; `registry:<publisher>/<name>` names the module (section 4). Claimed once in the registry, never reused |
| `key_id` | `ed25519:<base64url of the 32-byte public key, no padding>` | The publisher's signing key. The registry lists a publisher's keys; a revoked key fails MF15 at install |

### `[storage]` (1.2)

`allowed_types`: the content types the module's `ctx.storage.put` accepts (`ops.md` section 21), MIME `type/subtype` without parameters, at most 64. Absent: the platform defaults (`artifact.md` 1.4, "Storage, AI, and the SBOM"). Copied to the artifact's module entry as `storage`.

### `[dependencies]`

Module name → semver range. A dependency is required for service calls and public views, and only for those (`docs/10-modules.md`, "Five communication mechanisms"): events, hooks, and slots need none. Every dependency must itself be installed in `renox.toml` (MF5); the CLI never installs a module implicitly.

Ranges are a fixed subset of npm's:

| Form | Matches | Example |
| --- | --- | --- |
| `^X.Y.Z` (also `^X.Y`, `^X`) | `>= X.Y.Z` and below the next change of the left-most non-zero part | `^1.2` = `>=1.2.0 <2.0.0`; `^0.3` = `>=0.3.0 <0.4.0`; `^0.0.4` = `=0.0.4` |
| `~X.Y.Z` (also `~X.Y`, `~X`) | `>= X.Y.Z` and below the next minor (the next major for `~X`) | `~1.2.3` = `>=1.2.3 <1.3.0` |
| `X.Y.Z` or `=X.Y.Z` | exactly that version | `1.0.0` |
| `>=A <B` (full versions, one space) | the interval | `>=1.2.0 <1.5.0` |

A pre-release version (`1.3.0-rc.1`) satisfies only an exact range naming it. Nothing else (`*`, `||`, `x`, hyphen ranges) is accepted.

### `[config]`

Key (`^[a-z][a-z0-9_]{0,63}$`) → declaration. The tenant sets values in `renox.toml`; the module reads the resolved object as `ctx.config` (`ops.md` 1.3.0, #226).

| Field | Applies to | Meaning |
| --- | --- | --- |
| `type` | all | `"string"`, `"enum"`, `"int"` (64-bit, within ±(2^53 − 1)), `"bool"` |
| `values` | `enum` only, required there | Allowed strings, unique, 1–64 |
| `default` | all | Must have the key's type and pass its bounds (MF10) |
| `required` | all | Default: `true` when there is no `default`, else `false`. `required = true` together with a `default` is rejected (MF10). An optional key without a default is absent from `ctx.config` when unset |
| `min`, `max` | `int` only | Inclusive bounds, `min ≤ max` |
| `max_length` | `string` only | Characters, 1–4096; without it a string value is at most 4096 characters |
| `description` | all | One line |

Secrets are never config: a value that must stay secret is a secret name under `[permissions]`, set with `renox secrets set`.

### `[permissions]`

What the module asks the tenant to approve (section 3). Every key is optional; an absent key asks for nothing.

| Key | Type | Meaning | Enforced by |
| --- | --- | --- | --- |
| `tables` | exactly `"<name>__*"` (MF4) | The module owns tables, views, indexes, and triggers named `<name>__…` and may write them. Absent: the module has no tables and no migrations | SQLite authorizer (`docs/06-data.md`); `artifact.md` V19 |
| `network` | allowlist entries, syntax of `ops.md` section 2 | Hosts the module's `fetch` may reach. Separate from the app's `[fetch] allow` and from every other module's | `op_fetch` with the module's list (`ops.md` 1.3.0, #226) |
| `secrets` | names `^[A-Z][A-Z0-9_]{0,63}$` that start with `<NAME>_`, the module name in upper case (MF4) | The secrets the module reads as `ctx.secrets`. The prefix keeps one module from asking for the app's or another module's secret by name | `op_secrets_get_all` (`ops.md` section 3), once per module from 1.3.0 (#226) |
| `slots` | slot names | The slots the module fills; must be exactly the names of its `[[slots]]` (MF8) | Renderer slot registry (`artifact.md` section 3) |
| `hooks` | hook names | The hook points the module fills from `hooks.ts`; each must be exported by another installed module (MF8). A filler can halt another module's flow (`auth.after_login`), so filling is approved | Broker (`ops.md` 1.3.0, #226) |
| `roles` (1.1) | role names, exactly the keys of `[authz.default_roles]` (MF13) | The roles the module may assign with `ctx.authz.roles.assign` (`ops.md` section 17). Assigning a role grants what its policies permit, so it is approved; any other role rejects with `RENOX_MODULE_UNDECLARED` | `op_authz_roles_*` (`ops.md` 1.5.0, #279) |

Reading another module's public view needs no permission: it follows from `[dependencies]` and `[imports]` (MF7), and the authorizer allows `SELECT` on `<dep>__public_*` for declared dependencies only. Defining actions, entities, owned tables, and feeds (`[authz]`, `[realtime]`) needs no permission either: they concern the module's own tables and resources (MF14), and a policy that grants an action still comes from the app's or the module's policy set.

### `[exports]`

The module's public API, versioned with `version` (`docs/10-modules.md`, rule 3).

| Key | Shape | Rule |
| --- | --- | --- |
| `views` | `["<name>__public_<id>_v<n>"]` | Views the module creates in its migrations for dependants (D17). `<name>` is this module (MF6); `<id>` matches `[a-z0-9_]+`; `v<n>` starts at `v1` |
| `services` | `{ <export name> = "<one-line doc>" }` | Named exports of `services.ts`. The name is a JavaScript identifier; the signature comes from the TypeScript source (#236) |
| `events` | `{ "<name>.<event>" = { payload = <schema>, description? } }` | Events the module emits. The name starts with this module's name (MF6). The payload schema is JSON Schema with the keyword subset of `validate.ts` (`README.md`, "Checking"); `op_events_emit` validates against it (`ops.md` 1.3.0, #226) |
| `hooks` | `{ "<name>.<hook>" = { args = <schema>, result? = <schema>, description? } }` | Hook points the module runs with `ctx.hooks.run`. Same naming and schema rules as events (MF6) |

### `[imports]`

What the module uses from its dependencies, so a broken contract shows up in `renox check` before any code runs (`docs/23-failure-modes.md`, "Module contract broken on upgrade").

| Key | Shape | Rule |
| --- | --- | --- |
| `services` | `["<dep>.<service>"]` | Each `<dep>` is in `[dependencies]`, and the installed version of `<dep>` exports `<service>` (MF7) |
| `views` | `["<dep>__public_<id>_v<n>"]` | Each view's prefix is a dependency that exports it (MF7) |

`renox check` (#235) compares `[imports]` with the code: every `renox:modules` member a module calls and every `<dep>__public_*` name in its SQL must be listed. The app has no manifest; it may use every installed module's exports.

### `[[slots]]`

| Key | Type | Meaning |
| --- | --- | --- |
| `name` | slot name | The `<r-slot name>` this module fills (rendered by another module's or the app's template) |
| `template` | `partials/….html` in the module tree | The partial inserted. Must exist in the module tree (MF9) |
| `requires` | action name | The authorization action a user needs for the content to render. Must be in `[authz].actions` (MF9). Evaluated from F5; carried from F4 |
| `priority` | integer 0–1000, default 100 | Order among the fillers of one slot: lower first, ties by module name |

### `[[tools]]`

MCP tools (`docs/20-ai-agents-mcp.md` section 2; `ops.md` section 19): `name` (`^[a-z][a-z0-9_]{0,63}$`), `file` (`tools/….ts` in the module tree, MF9), `action` (in `[authz].actions`, MF9), `confirm` (default `false`), `description`. From 1.1 they are **carried in the artifact** as `tool` routes (`artifact.md` 1.3): `renox build` reads the `tool(...)` the file default-exports, records its input schema, and takes `name`, `action`, `confirm`, and `description` from the manifest, which must equal the file's (`renox check`, #284). Tool names are unique across the app and its installed modules (`artifact.md` V25).

### `[authz]`

The module's side of `docs/11-authorization.md` (`ops.md` section 17). Everything here names the module's own tables and resources (MF14); the policies that grant actions live in `policies/*.cedar`, carried in the artifact (`artifact.md` section 1), and are evaluated from F5.

| Key | Shape | Meaning |
| --- | --- | --- |
| `actions` | `["<resource>.<verb>"]` | The actions the module defines. `slots[].requires`, `tools[].action`, `sensitive`, and the actions of `default_roles` name them (MF9, MF13) |
| `sensitive` (1.1) | a subset of `actions` (MF13) | Decisions on these actions are audited in `renox__authz_audit`, and the merged schema puts them in the group `Renox::Action::"sensitive"` (`docs/11`: "requires MFA, audit-logged") |
| `[authz.ownership]` (1.1) | `"<table>" = { owner = "<column>", org? = "<column>" }`, tables under `<name>__` (MF14) | The owned tables `db.scoped()` fences: `owner` is the user (or session) column, `org` the organisation column. Module code reaching an owned table without a scope is refused (`RENOX_DB_SCOPE`) |
| `[authz.entities]` (1.1) | `<Type> = { table? = "<name>__…", id? = "<column>", attrs = ["<column>", …] }`, `<Type>` matching `^[A-Z][A-Za-z0-9_]{0,63}$` | The Cedar entity types of the module, `<Module>::<Type>` with `<Module>` the module name capitalised: `attrs` are the only attributes sent to the engine; `table` (own prefix, MF14) and `id` (default `id`) let the cell load a `guard` resource |
| `[authz.default_roles]` (1.1) | `<role> = ["<action>", …]`, actions of the merged action set (MF13) | The roles the module ships; its default policies grant them these actions. `permissions.roles` lists exactly these role names (MF13), and the lock's `approved.roles` is the tenant's approval |

**The `auth.principal` convention (1.1).** The `auth` module (#291) exports the service `auth.principal(sessionId)` and the hook point `auth.principal` (`[exports.hooks."auth.principal"]`, `args = { principal }`). The cell calls the service once per request (`ops.md` section 17, "Principal"); the service builds the principal from its own tables and runs the hook, whose fillers extend `principal.attrs` and return `undefined` (a filler that halts is treated as a throw): `2fa` sets `attrs.mfa_verified`, `org` sets `attrs.org`. A module that wants an attribute on the principal fills this hook (`permissions.hooks = ["auth.principal"]`, approved at install like any hook fill); nothing else may add to a principal. `auth` also exports `auth.verifyAgentToken` for `/mcp` (`ops.md` section 19, #286).

### `[realtime]` (1.1)

`[realtime.feeds]`: `"<table>" = "<topic pattern>"`, tables under `<name>__` (MF14), the pattern a topic (`ops.md` section 18) whose `{column}` placeholders name columns of that table (`artifact.md` V26 checks the table against the module's migrations). After a commit that changes the table, the cell publishes `{ table, rowid, op }` to the topic to the connections that passed the subscribe check.

## 3. Permissions and approval

- **At install** (`renox add <module>`) and at every upgrade, the CLI shows the module's `[permissions]` and asks the tenant to approve them. The approved set is written to the module's lock entry as `approved` (section 5).
- **A changed request needs a new approval.** When a manifest's `[permissions]` differ from its lock entry's `approved` in any way (a host added, a secret removed, a hook filled), `renox check` and `renox build` fail with MF12 until the tenant runs `renox approve <module>`. Removing a permission also needs approval, so the lock always says exactly what runs. `docs/23-failure-modes.md`, "Marketplace module unsigned or permission diff on upgrade", is the F7 registry form of the same rule.
- **What runs is what was approved.** The artifact copies `approved`, not the manifest's request (`artifact.md` V22), and the runtime enforces the artifact (`ops.md` 1.3.0, #226). A module that asks for more after approval gets nothing more until the tenant approves.
- **Approval in the control plane.** The control plane records the artifact's module permissions as approved at upload, as it does for the app's (`deploy-api.md` section 4, "Outcomes"). Dashboard approval of module upgrades is F7.

## 4. `renox.toml [modules]`

```toml
[modules]
auth    = { version = "^1.0", mount = "/auth" }
org     = { version = "^1.0" }
billing = { version = "^1.2", mount = "/billing", config = { provider = "telr" } }
acme    = { version = "^0.4", source = "git:https://github.com/acme/renox-acme#v0.4.1", isolation = "isolate" }
```

The key is the module's name and must equal the manifest's `[module].name` (MF3).

**`[authz]` and `[realtime]` of the app (1.1).** `renox.toml` may carry the same `[authz]` (`actions`, `sensitive`, `[authz.ownership]`, `[authz.entities]`, `[authz.default_roles]`) and `[realtime.feeds]` tables as a module manifest, for the app's own `app__*` tables and resources (`App::<Type>` in Cedar); the CLI resolves them into the artifact's `authz` and `realtime` blocks (`artifact.md` 1.3) and `renox check` applies MF13 and MF14 to them with the prefix `app__`. The app's policies are `policies/*.cedar` in the app root, built into `policies/app/`, with the schema `policies/schema.cedarschema`.

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `version` | range (section 2) | yes | The versions the tenant accepts. The lock's version must satisfy it and every dependant's range (MF2) |
| `source` | `path:<dir>` \| `git:https://<repo>#<ref>` | no | Where the module tree is. `path:` is relative to the app root (`..` allowed, no absolute path, no drive letter); `git:` names a tag or a commit, which the lock pins to a 40-hex commit. **Absent = an official module**, resolved by the CLI from the official module set of its own release (Open 1). 1.2: `registry:<publisher>/<name>` resolves from the Renox module registry (section 5, "Registry modules"); `<name>` is the module's name (MF3). `docs/10-modules.md` writes `registry = "acme/reports"`; the contract spells it as a `source` value so one key names where a module comes from |
| `mount` | `/` or `/<segment>(/<segment>)*`, static segments | no, default `/<name>` | The path prefix of the module's routes (`artifact.md` section 3, "Modules"). Collisions after mounting are rejected at build (`artifact.md` V21) |
| `config` | key → string, integer, or boolean | no | Values for the module's `[config]` keys. Unknown keys, wrong types, values outside bounds, and missing required keys are rejected (MF10) |
| `isolation` | `"shared"` \| `"isolate"` | no, default: the manifest's | Overrides the mode **downward only**: from `shared` to `isolate`. Asking for `shared` when the manifest says `isolate` is rejected (MF11) |

## 5. `renox.lock`

```toml
version = 1

[[module]]
name = "auth"
version = "1.0.0"
source = "path:modules/auth"
hash = "<64 hex>"
isolation = "shared"
mount = "/auth"
dependencies = []
config = { registration = "open", session_days = 30, magic_links = true }
approved = { tables = "auth__*", network = ["accounts.google.com"], secrets = ["AUTH_GOOGLE_CLIENT_SECRET"], slots = [], hooks = [], roles = ["admin", "member"] }

[[module]]                                       # 1.2: a registry module
name = "tax_gcc"
version = "2.1.0"
source = "registry:gulfsoft/tax_gcc"
hash = "<64 hex>"
key_id = "ed25519:<43 base64url>"
signature = "<86 base64url>"
approved_version = "2.0.0"
isolation = "isolate"
mount = "/tax"
dependencies = []
config = {}
approved = { tables = "tax_gcc__*", network = [], secrets = [], slots = [], hooks = [] }
```

| Key | Meaning |
| --- | --- |
| `version` | `1`, this contract's lock format |
| `module[]` | One entry per installed module, in **topological order**: every module after all its dependencies, ties by name. This is the migration order and the artifact's `modules` order (`artifact.md` section 3) |
| `name`, `version` | The manifest's name and version (MF3, MF12) |
| `source` | `official`, `path:<dir>` (as in `renox.toml`), `git:https://<repo>#<40-hex commit>`, or (1.2) `registry:<publisher>/<name>` |
| `hash` | SHA-256 of the module tree: the canonical listing of `artifact.md` section 2 over every regular file under the module directory, `module.toml` included. Reproducible with the `sha256sum` pipeline there. A `path:` module whose tree changed fails MF12 until `renox install` updates the lock |
| `isolation` | The effective mode after the `renox.toml` override (MF11) |
| `mount` | The effective mount (`renox.toml` or the default) |
| `dependencies` | The names of the manifest's `[dependencies]`, sorted: the dependency edges (MF12) |
| `config` | The resolved config: every declared key that has a value, from `renox.toml` or the default (MF12) |
| `approved` | The permissions the tenant approved: `tables` (absent when none), `network`, `secrets`, `slots`, `hooks`, and from 1.1 `roles` (absent or empty when the module assigns no role; section 3) |
| `key_id`, `signature` | 1.2, registry sources only (MF15): the publisher key and the `module.sig` signature the CLI verified at install. Absent for every other source |
| `approved_version` | 1.2, optional: the module version `approved` was given for. Absent = `version`. After `renox install` upgrades a module whose permissions did not change, the approval carries over and this keeps the older version; when they changed, MF12 fails until `renox approve`, which shows the diff from the `approved_version` set and then sets `approved_version = version` |

### Registry modules (1.2)

- **Publishing.** `renox publish` (run in a module tree with `[publisher]`) computes the module tree hash (above), signs it, writes `module.sig`, and uploads the tree to the registry under `<publisher>/<name>@<version>`. A version, once published, is immutable; the registry refuses a second upload of the same version.
- **`module.sig`** is a JSON object (`module-manifest.schema.json` `$defs/moduleSig`): `{ "version": 1, "publisher", "key_id", "name", "module_version", "hash", "signature" }`. `signature` is the Ed25519 signature (base64url, no padding) of the UTF-8 bytes `renox-module-v1\n<publisher>/<name>@<module_version>\n<hash>\n`. The tree hash is computed **without** `module.sig`, so the signature does not sign itself.
- **Installing.** `renox add` and `renox install` download the tree, recompute the hash, check `module.sig` against the publisher's key from the registry (refusing a revoked key), check that `[publisher].name` and `[module].name` match the source, and then show the permissions for approval as for any source (section 3). The lock records `key_id` and `signature`; `renox check` re-verifies the signature over the locked hash offline (MF15).
- **Upgrades.** A registry upgrade with changed `[permissions]` shows the diff against the approved set (`approved_version`) and needs `renox approve` (section 3, MF12); `docs/23-failure-modes.md`, "Marketplace module asks for new permissions".

The lock is the input to the build: `renox build` resolves nothing; it reads the lock, checks it (MF1–MF12), and copies it into the artifact. `renox install` resolves (newest version satisfying every range) and rewrites the lock; `renox approve` rewrites `approved`.

## 6. Rules

Applied by `renox check`, `renox build`, and `renox install` (P11, #235). `validate.ts` implements them for the examples. "Single file" rules need only one document; "project" rules need `renox.toml`, `renox.lock`, and the module trees together.

| # | Rule | Scope |
| --- | --- | --- |
| MF1 | **Names.** A module name matches `^[a-z][a-z0-9_]{0,31}$`, contains no `__`, does not end with `_`, and is not `app`, `renox`, or (1.1) `authz`, the namespace of the platform event `authz.roles_changed` (`ops.md` section 17). This applies to `[module].name`, `[dependencies]` keys, `renox.toml [modules]` keys, and lock names. With this rule, no module's prefix `<a>__` is a prefix of another's tables: `a__x` cannot belong to a module `a_`, since `a_` is not a name (the authorizer's rule, `crates/renox-data/src/authorizer.rs`) | single file |
| MF2 | **Versions.** Every `version` is semver and every range is of section 2. The lock's version of each module satisfies its `renox.toml` range and the range of every installed module that depends on it | single file, project |
| MF3 | **One install per name and prefix.** The `renox.toml` key, the manifest's `[module].name`, and the lock entry's `name` are the same; no two installed modules (or a module and `app`) have the same name; no installed module's prefix is a prefix of another's; each `renox.toml` module has exactly one lock entry and the lock has no other | single file (lock), project |
| MF4 | **Own prefix only.** `permissions.tables`, when present, is exactly `"<name>__*"` (in the manifest and in the lock's `approved`); every secret name starts with `<NAME>_`, the module name in upper case | single file |
| MF5 | **Dependency graph.** Every dependency is installed; no module depends on itself; the graph has no cycle (rejected at build, not at call, `docs/10-modules.md` rule 1); the lock lists every module after its dependencies | single file (lock), project |
| MF6 | **Export names.** Views are `<name>__public_<id>_v<n>` with this module's name; events and hook points start with `<name>.`; payload, argument, and result schemas use only the keyword subset of `validate.ts` | single file |
| MF7 | **Imports.** Every `[imports]` service `<dep>.<service>` and view `<dep>__public_…` names a module in `[dependencies]` whose installed manifest exports it | project |
| MF8 | **Fills.** `permissions.slots` is exactly the set of `[[slots]].name`; every hook in `permissions.hooks` is exported by an installed module other than this one | single file, project |
| MF9 | **References.** Every `[[slots]].template` exists in the module tree; every `[[slots]].requires` and `[[tools]].action` is in `[authz].actions` | single file, project |
| MF10 | **Config.** A declaration's `default` has its `type` and passes `values`, `min`, `max`, `max_length`; `min ≤ max`; `required = true` has no `default`. Every `renox.toml` config key is declared; every value has the declared type and passes its bounds; every required key has a value | single file, project |
| MF11 | **Sources and isolation.** `source` is `path:`, `git:`, or (1.2) `registry:`; a `renox.toml` `isolation` is never lower than the manifest's (`shared` below `isolate`); the lock's `isolation` is the effective one | project |
| MF12 | **Lock matches.** For each module: the lock's `version` is the manifest's; `hash` is the hash of the module tree; `dependencies` are the manifest's; `config` is the resolved config; `mount` and `source` are the `renox.toml` values (or the defaults); **`approved` equals the manifest's `[permissions]`** (section 3), `roles` included from 1.1 | project |
| MF13 | **Actions and roles** (1.1). `permissions.roles` is exactly the set of `[authz.default_roles]` keys; every action of a `default_roles` entry, every `sensitive` action, every `slots[].requires`, and every `tools[].action` is in `[authz].actions` (MF9 for the last two); for the app's `renox.toml [authz]`, the same with the merged action set | single file |
| MF14 | **Own prefix** (1.1). Every `[authz.ownership]` table, every `[authz.entities].table`, and every `[realtime.feeds]` table starts with `<name>__` (`app__` in `renox.toml`); every `[[tools]].file` exists in the module tree | single file, project (the file) |
| MF15 | **Registry signatures** (1.2). A lock entry has `key_id` and `signature` exactly when its `source` is `registry:`; the source's `<name>` is the entry's `name`; the manifest of a registry module has `[publisher]` with the source's publisher and the lock's `key_id`; the signature verifies over the locked hash (section 5, "Registry modules") | single file (lock); the publisher and signature checks run in the CLI at install and in `renox check` (they need the registry tree and key) |

Every rejection names the rule (`MF1`–`MF15`), the file and key, and a one-line reason, and never a filesystem path outside the app.

## 7. What the other F4 contracts take from here

| Consumer | Takes | Where |
| --- | --- | --- |
| Artifact 1.1 (#227) | The lock entries, in order, plus each module's `exports` and `[[slots]]` | `artifact.md` section 3, "Modules" |
| Ops 1.3.0 (#226) | Per-module `ctx` from `approved` and `config`; dependency checks from `dependencies`; export checks from `exports` | `ops.md` 1.3.0 (#226, not merged yet) |
| SDK (#236) | `[exports.services]` and the services' signatures | `renox-modules.d.ts` |
| Migrations (#234) | Lock order as migration order; `permissions.tables` for which modules must have migrations | `artifact.md` V19 |
| Artifact 1.3 and ops 1.5.0 (#272, F5) | `[authz]`, `[realtime]`, `[[tools]]` on the module entry and as `tool` routes; `approved.roles` for `op_authz_roles_*`; the `auth.principal` service and hook for the principal | `artifact.md` section 3, "Authorization and realtime"; `ops.md` sections 17–19 |
| Artifact 1.4 and ops 1.7.0 (#318, F7) | `[storage]` on the module entry; `isolation = "isolate"` run by #320; `registry:` sources in the entry's `source` | `artifact.md` section 3, "Storage, AI, and the SBOM"; `ops.md` sections 15.6, 21 |

## 8. Examples

[`examples/manifest/`](examples/manifest/):

- `module.<case>.(valid|invalid).toml`: single manifests. The valid ones include the manifests of the F4 catalog modules in `docs/18-build-plan.md`: `auth` (M1), `org` (M2), `gcc` (M23, catalog name `gcc-data`), and `i18n` (M12 with the M19 core), plus the `billing` manifest of `docs/10-modules.md`, which carries the 1.1 `[authz]`, `[realtime]`, `[[tools]]`, and `permissions.roles` (section 2).
- `renox.<case>.(valid|invalid).toml` and `renox-lock.<case>.(valid|invalid).toml`: single `renox.toml` and lock files.
- `projects/<case>.(valid|invalid)/`: a whole app (`renox.toml`, `renox.lock`, `modules/<name>/…`) for the project rules. `projects/shop.valid` installs `auth`, `org`, `gcc`, and `i18n` from `path:` sources.

An invalid file names its reason as `[expect: <reason>]` in a TOML comment (for a project, in its `renox.toml`), and `validate.ts` checks that it fails for that reason.

## 9. Versioning

- The lock carries `version = 1`. A CLI refuses a lock with a version it does not know.
- **Minor** (no version bump): a new optional key with a default that keeps old behaviour, a new range form, a new rule that only rejects what was already meaningless.
- **Major**: renaming or removing a key, changing a default, changing the hash rule. Lands with the CLI and the broker in one PR.
- Contract edits are made only by `type:contract` issues.

## Open

1. **Official module distribution.** A `renox.toml` entry without `source` is an official module "from the CLI's release". Whether the CLI embeds `modules/*` or downloads them from the release assets (signed like the worker, #129) is decided by #235; the lock records `source = "official"` either way, and the hash pins the tree.
2. **`isolate` mode.** Settled in 1.2: the runtime semantics are `ops.md` 1.7.0 section 15.6, implemented by #320. Until #320 lands, #235's build error for `isolate` stays.
3. **Registry sources.** Settled in 1.2 (sections 2, 4, 5; MF15). Still open: the registry's own HTTP API (publish, fetch, key listing and revocation) belongs to the registry service of #329 and is not a tenant-facing contract here; payouts for `price` are an owner decision (`docs/15`).
4. **Slot exports.** A slot is filled by name; nothing declares which module renders `<r-slot name="admin.sidebar">`. A filled slot that nothing renders is harmless (it never appears). An `[exports].slots` list can be added as a minor change if `renox check` needs to warn about it.
5. **App events.** The app has no manifest, so it cannot export events or hook points in F4. `renox.toml [exports]` can be added as a minor change.

## Changelog

| Version | Issue | Changes |
| --- | --- | --- |
| 1 | #225 | First version (F4): `module.toml` (`[module]`, `[dependencies]`, `[config]`, `[permissions]`, `[exports]`, `[imports]`, `[[slots]]`, `[[tools]]`, `[authz]`), `renox.toml [modules]`, `renox.lock` with approved permissions, rules MF1–MF12 |
| 1.1 | #272 | Minor (no lock version bump; every new key is optional). `[authz] sensitive`, `[authz.ownership]`, `[authz.entities]`, `[authz.default_roles]`; `[realtime.feeds]`; `[[tools]]` carried in the artifact (`artifact.md` 1.3); `permissions.roles` and `approved.roles`; the `auth.principal` service and hook convention; `renox.toml [authz]` and `[realtime]` for the app; `authz` a reserved name (MF1); rules MF13–MF14. For `ops.md` 1.5.0 sections 17–19 |
| 1.2 | #318 | Minor (no lock version bump; every new key is optional). `source = "registry:<publisher>/<name>"` in `renox.toml` and the lock (MF11 relaxed); `[publisher]` (`name`, `key_id`) and `[module] price` in `module.toml`; `[storage] allowed_types`; the `module.sig` file and its signed message; the lock's `key_id`, `signature` (registry only), and `approved_version` for the upgrade diff; `renox publish`; the `isolate` mode settled (Open 2) and registry sources settled (Open 3); rule MF15. For `artifact.md` 1.4 and `ops.md` 1.7.0 |
