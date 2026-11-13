# Changelog

Releases of the developer toolkit: the `renox` CLI (GitHub Release `cli-v<version>`), the SDK `@renoxium/sdk` (npm, same version) and the `renox-worker` the CLI pins (GitHub Release `worker-v<version>`). The platform itself (control plane, production workers) deploys from `main` and is not versioned here.

## 0.1.15 (unreleased)

**Modules**

- `auth` 1.3.0: sign-up by phone. With `phone_login` and the new config `phone_signup = true`, a phone with no account gets a one-time code through `auth.send_otp` (same answer, same buckets, same cost as a known phone), and the correct code creates the account (phone verified, no email, no password, empty name) and signs it in. At most 3 accounts an hour and 20 a day per IP address; past that the request answers the generic message and sends nothing. `auth.user_registered` has `source: "phone"`; new services `setDisplayName(name)` and `hasPassword()`; migration 008 (`auth__phone_signups`). (#773)
- `email` 1.2.0: a `url` that is a path of the app (`/org/accept/<token>`, as `org` writes it in an App MCP request, which has no request origin) is completed with the app's origin: the origin of the request that queues the mail, else the new `app_url` config (an `https://` origin, at most 200 characters); the result must have exactly that origin. `//host`, a backslash, a control character, more than 2,000 characters, any other relative value and any non-`https` scheme are dropped as before. With no origin the link is dropped and one warning `EMAIL_LINK_NO_ORIGIN` is logged. The invitation mail of an agent's `invite_people` or `invite_member` now carries its button (#765).
- `whatsapp` 1.3.0: the rows of `inbox()`, `outbox()` and `message()` gain `error: string | null`, the provider's failure reason of a failed or retried send (redacted, at most 200 characters, never a token or a secret), and the service `mode()` answers `{ sandbox }`, so an app can show why a message failed and a sandbox banner without reading the module's table or config. (#771)

**SDK**

- The `tx` of `ctx.db.transaction(async (tx) => ...)` is typed `TxDb`, so `tx.scoped(scope)` needs no `(tx as TxDb)` cast (the cast advice of 0.1.14 is no longer needed; it still compiles). A `Db` fake that implements `transaction` passes `{ ...statements, scoped: () => statements }` to `fn` (`ops.md` 1.17.1) (#756).
- `t.job(name, { payload })` of `@renoxium/sdk/test` runs a queued run of the job with that payload, as `ctx.jobs.enqueue(name, payload)` writes it: one run per call, so a test can run a queued job again (#770).

## 0.1.14 (2026-11-12)

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.14/install.sh | sh
```

On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`.

**Modules**

- `2fa` 1.1.0: the service `reset(user_id)` for an administrator holding the new sensitive action `twofa.reset` on that user, with a recent second factor of their own and never on themselves; it deletes the user's second factors, recovery codes and verified sessions so the next sign-in enrols again, and emits `twofa.reset { user_id, by }`. (#735)
- `audit` 1.1.0: the listener records `twofa.reset` (2fa 1.1.0) with the administrator as the actor and the user as the resource `twofa:User`. (#735)
- `audit` 1.0.1: the row of an App MCP `mcp.tool_called` event keeps the event's optional `grant_id` (the owner connector grant the agent token was minted under) in `details`. (#748)

**Worker**

- Pins `renox-worker` 0.9.0.
- The cell puts the verified token's `client.grant_id` into the `mcp.tool_called` event when `verifyAgentToken` answered one (`ops.md` 1.16.0). `ops.md` section 19 now documents the answer's optional `expires_at` and `client.grant_id`, and that the 60 s verified-token cache never outlives `expires_at`, with a test that a token expiring in 5 s is refused at second 6. (#748)
- The `tx` of `ctx.db.transaction(async (tx) => ...)` has `tx.scoped(scope)`, the transaction's statements behind the ownership fence of `db.scoped()`; the app's `ctx.db.scoped()` used inside a transaction now fails at once with `RENOX_DB_TX_STATE` ("use tx.scoped(...) inside a transaction") instead of waiting and answering "database is busy"; in TypeScript, write `(tx as TxDb).scoped(...)` for now (ops 1.15.0) (#749).
- Behaviour change for templates: an attribute whose whole value is one expression (`name="{{ expr }}"` or `:name="expr"`) is omitted when the value is the boolean `false`, `none`/`null` or undefined, where it printed `name="false"` or `name=""`. The string `"false"` still gives `name="false"`, `""` gives `name=""`, `true` gives `name="true"` (the bare name on an HTML boolean attribute); mixed text such as `class="btn {{ x }}"`, escaping and the URL filter are unchanged. A template that needs the text `false` (say `aria-pressed` on a toggle button) passes the string: `:aria-pressed="'true' if on else 'false'"` (`docs/08-template-engine.md`, "Attributes whose value is false, none or undefined", #737).
- A module service that throws inside a transaction now rolls back only its own call: the broker runs each service call in a savepoint, so a page action that catches, say, `reports.readXlsx` failing on a corrupt file can still write and commit, where its next write used to fail with `RENOX_DB_TX_STATE`. Nested calls nest the same way; an uncaught error still fails the action, and hook fillers and event handlers that throw still roll the whole transaction back (ops 1.17.0) (#734).

## 0.1.13 (2026-11-11)

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.13/install.sh | sh
```

On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`.

**CLI**

- `[security.csp] form_action` in `renox.toml`: a list of at most 8 `https://` origins a form may post to; the page's `form-action` becomes `'self'` plus them. A wildcard host, `http://`, `data:` or a source with `;` is refused by `renox check` and dropped by the gateway; modules cannot add form targets (`artifact.md` 1.10, #740).
- `renox export` no longer writes `localhost` into `routes.json`: the worker's route table refuses a one-label name (V13), so an exported app did not start. The control plane now gzips the artifact it exports (`deploy-api.md` 0.10.1), which `renox export` refused before ("not a gzip file"). `docs/self-host.md` takes an export to a VPS behind Caddy and systemd, and `cli/tests/export-selfhost.e2e.test.ts` runs the exported app on `renox-worker` (#674).

**Modules**

- `admin` 1.0.1: the sidebar links and the dashboard card are built from `base_path` (`/admin/`, `/admin/users`, `/admin/audit`), so they work on the dashboard at `<mount>` with no trailing slash; they were relative and resolved to `/users` and `/audit` (#704); its audit page shows the resource as `type:id` (the column was always empty), and an agent's tool call as `agent (client)` and a system event as `system` next to the actor id (#709).
- auth 1.2.0: the platform-only service `auth.mintAgentToken({ email, scopes, ttl_seconds, client_name, grant_id })` mints a short-lived (at most 300 s) agent token for the app user with that verified email, scoped to named `tools:<name>`, for the owner connector's bridge; callable only by the platform, never from tenant code, a route or another module; `verifyAgentToken` also answers `expires_at` and `client.grant_id` (#698).
- whatsapp 1.2.0: the service `whatsapp.message(id)` returns one stored message (the shape of an `inbox()` row) or `null`, by primary key, so a handler of `whatsapp.message_received` reads the text of the message the event names without scanning the inbox; the event payload stays `{ message_id, from }` (#705).
- `reports` 1.2.0: the service `reports.readXlsx(bytes)` returns the first sheet of an `.xlsx` (written by Excel, LibreOffice or `reports.xlsx`; shared and inline strings, a formula's cached value) as rows of `string | number | null`; a `Uint8Array` of at most 10 MiB and 100,000 cells, else `TypeError`, `RangeError` or "not an .xlsx file" (#724).

**Worker**

- Pins `renox-worker` 0.8.0.
- `<x-image>` writes an author-given `loading="eager"` or `loading="lazy"` instead of always `lazy`, and passes a literal `fetchpriority="high|low|auto"` through; a bound or other value is a compile error naming the template and line, and the default stays `loading="lazy"` (#738).
- An app's `pages/_404` and `pages/_error` receive `locale`, `dir` and `app_name`: the cell resolves the locale from `?lang=`, `Accept-Language` and the `i18n` module's default, without an isolate or the database, so `<html lang dir>` and `<r-t>` follow it; without `i18n`, `en` and `ltr` (artifact 1.9.3, errors 0.11.1) (#739).
- The gateway writes `form-action 'self' <origins>` from the artifact's `security.csp.form_action` and drops any source that is not an `https://` origin, with a platform warning; without the key the header is unchanged (artifact 1.10) (#740).

## 0.1.12 (2026-11-10)

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.12/install.sh | sh
```

On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`.

**Worker**

- Pins `renox-worker` 0.7.1.
- The node listener streams a tenant's stored files as one gzip tar (`GET /nodes/{node}/tenants/{tenant}/files?database=`, `deploy-api.md` 0.8 section 15), with the SHA-256 of the archive and the file counts in headers; image variants are not exported (#670).
- The gateway drops a `security.csp.*` source that holds `;` or `,` at load, with a platform warning, and never merges it into the `Content-Security-Policy` header: `;` ends a directive and `,` starts a second policy, so a source must not change the policy's structure (artifact 1.9.2, manifest 1.6.2, MF17) (#679).

**CLI**

- `renox export [--out <dir>] [--app <name>] [--json]` downloads a runnable copy of the deployed app (the database, the stored files and the active artifact, every SHA-256 checked) into a directory that `renox-worker --config worker.toml` runs; secret values stay on the platform and their names are in `secrets.txt` (#673). The control API serves the files and artifact exports through signed URLs (`exportFiles`, `exportArtifact`, #671).
- `renox check` refuses a `[security].csp.*` source with `;` or `,` with the MF17 message, the same grammar as a module's CSP source; the contract schema's `cspSource` pattern no longer allows them (#679).
- `renox approve <module>` resolves the whole `[modules]` table, so a module with dependencies (billing with auth and i18n) no longer fails MF5; approving a changed permission set no longer needs `renox add <module> --yes` (#678).
- `renox new --template home-services` uses the app's `hooks.ts`, `[[slots]]` and `[events]` (artifact 1.8): a customer's WhatsApp "cancel" or "reschedule" becomes the dispatcher's task when `whatsapp.message_received` arrives (the minute `jobs/inbox-sweep.ts` is gone); the app role of an invited person is applied on `org.member_added` (no longer when the owner opens the users page), which emits the app's own `app.member_ready`; the nightly report goes to the settings' accounts email through `reports.nightly_to` (the `reports` config `email_to` is empty); the `admin` module is mounted at `/admin` (was `/system/admin`) and the app fills its `admin.sidebar` and `admin.dashboard` slots, so the app's duplicate dashboard and audit pages are gone, and its users page is now `/admin/people` (#636). Its tests check that an agent's `create_job` reaches the audit trail as an `agent` row with the client's name, on a worker newer than 0.7.0 (skipped with the reason on 0.7.0, #683).

## 0.1.11 (2026-11-10)

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.11/install.sh | sh
```

On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`.

**Worker**

- Pins `renox-worker` 0.7.0.
- The app handles module events, fills hook points and emits its own events (artifact 1.8, ops.md 1.12.0 section 15.4): the `hooks` code entry registers as module `app` (no `permissions.hooks`; in memory and in hook order after the modules of equal priority; deliveries as `Renox::System::"app"`, route `EVENT app <name>`, the same retries and dead letter); `ctx.events.emit("app.<name>", …)` is allowed for the names of the manifest `events` map, with the payload checked against its schema; an undeclared `app.*` name, or one emitted by a module, is `RENOX_MODULE_UNDECLARED`. App slot fillers render in a module's `<r-slot>` (#633).
- `ctx.pdf.render` embeds images (`ops.md` 1.13.0, section 24): `<img src="/_img/<key>?w=<n>">` (a tenant file by key, private keys included, at most 1600 px, JPEG or PNG, through the `/_img` variant cache) and `data:image/png;base64,` / `data:image/jpeg;base64,` URIs (at most 2 MiB each); at most 50 images and 20 MB of image bytes per document, else `RENOX_PDF_LIMIT`; any other `src` is dropped. The template engine lets these two `data:` types through on `<img src>` only (#582).
- A template that runs out of fuel or iterations now logs the innermost template and the line (an output-size stop still names the page only) (`RENOX_RENDER_LIMIT` carries `template` and `line`; `RenderStats` has `template` and `line`), and `renox dev`'s overlay shows them, as `docs/23-failure-modes.md` promises (#657).
- Every App MCP `tools/call` that passed the token check is audited (`docs/20`, `docs/24`; `ops.md` section 15.4, "Platform events"): one `RENOX_TOOL_CALL` tenant log line (`tool`, `client`, `outcome`, `request_id`) and the durable platform event `mcp.tool_called` with `outcome` `preview`, `ok`, `forbidden` (scope or Cedar), `input`, `rate_limited` or `failed`. A missing or invalid bearer and an unknown tool leave nothing (#658).
- `renox_security_events_total{tenant_id, kind}` counts the five security events per tenant on `/metrics`: `fetch_denied` (`RENOX_FETCH_BLOCKED`), `db_auth_refused` (`RENOX_DB_AUTH`), `csrf_failed`, `rate_limited` (a per-route 429) and `login_failed` (auth's `auth.login_failed` event); the gateway's per-IP 429s are `renox_gateway_rate_limited_total`. Alerts `RenoxSecurityEventsSpike` and `RenoxLoginFailuresBurst` (`ops/observability`) (#659).

**Modules**

- `audit` 1.0.0: listens to `mcp.tool_called` and records one `audit__events` row per tool call with `actor_kind = agent`, the client, the tool as `resource_id` and the outcome (`result` and `details.outcome`) (#658).
- `auth` emits `auth.login_failed { reason: "password" | "unknown_user" | "locked", ip_hash }` on a failed password sign-in (no email, no user id), in memory (`durable: false`: a login flood writes nothing to the outbox); the runtime counts it at the emit as `renox_security_events_total{kind="login_failed"}` (#659).

**CLI**

- Artifact 1.8: the app's own `hooks.ts` (project root) is the `hooks` code entry (`on` handlers for module events, `hooks` fillers for module hook points); `renox.toml [[slots]]` (`name`, `template = "partials/<x>.html"`, `requires?`, `priority?` 0 to 1000) fills slots as module `app` (after a module's filler of equal priority); `[events."app.<name>"]` (`payload`, `description?`) declares the events the app may emit, written to the manifest as `events`. `renox check` reports a filler whose template is missing or not a partial, a `requires` outside the merged actions, and an event name that is not `app.<name>` or a payload outside the schema keyword subset as errors, a slot no installed module renders and a handled event of a module that is not installed as warnings (#630).
- `renox new --template home-services`: invalid forms answer 422 and re-render with the typed values and the field errors (no more error page), jobs and event handlers use `ctx.db.scoped`, the App MCP tools are gated by plain role policies, and the tests use `t.job` and `t.tool` (#624). Every form keeps its own typed values on a 422, per row where a page has several (branches, user roles, the job's schedule and assign forms, the visit's part form, the services' active checkbox), and the tests use only the public `@renoxium/sdk/test` helpers (#627).
- `renox deploy` of an app that uses `hooks.ts`, `[[slots]]` or `[events]` is no longer rejected at upload: `@renox/artifact-validate`, which the control plane runs on every upload, accepts artifact 1.8 (the app's `hooks` entry, `module: "app"` slot fillers, the `events` map, rule V31) (#638).
- `renox dev` warns when a handler writes to global scope (`globalThis.x = ...`, a module-level `let`): a `warn: <file>:<line> ...` line after every build and a yellow "warnings" badge on every page (#656).
- Modules declare CSP sources (manifest 1.6, artifact 1.9.1, rule MF17): `[permissions] csp = { script_src = [...], frame_src = [...], ... }` in `module.toml` (`https://` origins with an optional `*.` wildcard, `data:`, `blob:`; never `'unsafe-*'`). `renox add` lists them, `renox approve` shows them per directive, a changed set fails MF12 until approved, and `renox build` merges only the approved sources of every installed module into `security.csp.*` (sorted, at most 32 per directive, a build error naming the module beyond that); the gateway is unchanged. `renox check --security` lists each merged source with the app or module it comes from (#660).
- `@renox/artifact-validate` follows artifact 1.9 (ADR D32, #640): a module's `services` entry, and a `hooks` entry that records its `hooks` and `on` names, may be lazy (`eager: false`). `renox build` does not write such entries yet, and the worker still refuses them until the runtime work of #640 lands.

**Modules**

- billing 1.0.1: an abandoned 3DS challenge no longer leaves the order stuck: `checkout.session.expired` and `payment_intent.canceled` (reason `abandoned`) expire the checkout, cancel its pending subscription and emit `billing.checkout_expired`; a job (`jobs/checkouts.ts`) expires card checkouts open for 24 h; the order gets a new session (#655).
- billing 1.1.0 declares the CSP sources Stripe's checkout needs (`script_src` and `frame_src` for `js.stripe.com`, `frame_src` for `hooks.stripe.com`): an app no longer lists them in its own `[security]`; approve a changed set with `renox approve billing` (#660).

**SDK**

- `ActionContext.db` is `TxDb` (statements plus `scoped`), as it is at run time; `ops.md` 1.13.1 (#627).
- `@renoxium/sdk/test`: `t.tool(name, input, { confirmation })` sends `_meta["renox/confirmation"]` as given in one call (a made-up, replayed or other-argument confirmation), and `t.tools({ as?, scope? })` returns the `tools/list` result of that agent token (#627).

## 0.1.10 (2026-11-09)

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.10/install.sh | sh
```

On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`.

**Worker**

- Pins `renox-worker` 0.6.1.
- **macOS is back.** `renox-worker` 0.6.1 is built for macOS again (x86_64 and arm64, default and pdf), next to Linux and Windows, and the CLI pins it on every target; `install.sh` installs the worker on a Mac as before 0.1.9 (#625). Worker 0.6.1 has the same code as 0.6.0.
- `cli-v0.1.9` was tagged but never published as a CLI release: its Windows smoke test could not download the worker (GitHub answered HTTP 504). Only `@renoxium/sdk` 0.1.9 reached npm. Its notes below are part of 0.1.10.

## 0.1.9 (2026-11-09)

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.9/install.sh | sh
```

On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`.

**Worker**

- Pins `renox-worker` 0.6.0.
- **No macOS worker in this release.** `renox-worker` 0.6.0 is built for Linux (x86_64, aarch64) and Windows only: the macOS builds failed on the release runner (HTTP 504 downloads) and are off until #625. On macOS, `install.sh` installs the CLI without a worker and says so; `renox new`, `check` and `build` work, `renox dev` and `renox test` need `RENOX_WORKER_PATH` to a worker you trust, or stay on `cli-v0.1.8` (worker 0.5.0).
- App MCP: an agent's roles from `verifyAgentToken` keep their scope (`{ role, scope_type, scope_id }`, mapped with `with_role`), and `authz.roles_changed` and `auth.principal_changed` drop the user's cached agent tokens, so a role revoke applies to the next `tools/call` (#590).

**Modules**

- auth 1.1.0, org 1.1.0: an agent token's principal is built like the user's session: the `auth.principal` hook runs for it (`agent: true`, `org_id`), `verifyAgentToken` returns `principal.roles` (`[{ role, scope_type, scope_id }]`), and `principal.org` is the organisation picked on the consent page (new hook `auth.agent_orgs`, filled by org; a user of one organisation gets it without a choice; an `org_id` outside the list is 422; migration 006), set only while the user is still a member; `mfa_verified` stays false (#590).
- 2fa 1.0.1: the `auth.principal` filler sets `mfa_verified = false` for an agent token (`agent: true`) without reading a session; before, it threw in the cell's `/mcp` check and the token was refused with 401 (#590).
- org 1.1.0: a `rename` service (`org.rename({ org, name })`, admin or owner, 1 to 80 characters; the slug and URLs stay) and the `org.renamed` event `{ org_id, name }`; the members page has a name form (#610).
- booking 1.0.1: `setHours` replaces a staff member's hours for that weekday or day instead of appending a row (migration 003 keeps the newest of duplicated rows and adds unique indexes); `setHours(staff, when, null)` closes it; the README names the `booking.manage` grant an app's own roles need (#572).
- whatsapp 1.1.0: `sandbox = true` records each outgoing message as sent (`wa_id` `sandbox-<id>`, a template's name, language and components in `body`) without calling the Cloud API, and needs no `WHATSAPP_*` secrets; `api_host` points the module at a fake Cloud API in tests (the host must be in the app's network allow-list); a read-only `outbox(limit)` service lists outgoing messages (#591).
- email 1.1.0: a display name on the sender, from the `from_name` config or per message (`send` and `sendRaw` take `from_name`; at most 80 characters, no `<`, `>` or line breaks; migration 004): mails go out as `"Name" <address>` (an RFC 5322 quoted name, `\` and `"` escaped) to Resend and SES; no name keeps the bare address; a config name that breaks the rule fails the message as `not_configured` (#611).
- reports 1.1.0: the service `reports.xlsx(sheet, rows)` returns a one-sheet .xlsx (numbers stay numbers, strings are never formulas; a sheet name of 1 to 31 characters without `[]:*?/\`, at most 100,000 cells, else `ValidationError`); the nightly summary goes to the addresses a filler of the new hook `reports.nightly_to` pushes onto `args.to`, with `email_to` as the fallback (#594).
- `r-can` inside a `ctx.render` fragment answers for the request's principal against the deployment's policies, as on a page: a permitted principal sees the block, others and anonymous do not; realtime fragments still deny (`ops.md` section 25) (#603).
- Scheduled jobs and event handlers get `ctx.db.scoped(scope)`: the run's statements carry the scope and are fenced as on a request (owner predicate, `RENOX_DB_SCOPE` `owner_mismatch`); the scope is explicit, never derived from the System principal (`ops.md` 1.11.0) (#612).
- The gateway answers no CORS preflight (405, `Allow: GET, HEAD, PUT`) and adds no `Access-Control-*` header for `PUT /_files/`, whatever `security.cors` says: signed uploads stay same origin (`ops.md` section 21) (#607).
- The seccomp allowlist includes `pkey_mprotect` and `pkey_free`, which V8 calls on CPUs with memory protection keys; a worker under `[sandbox] mode = "enforce"` on such a host was killed with SIGSYS (#608).
- App MCP: a `confirm: true` tool whose preview returns an object with a top-level `error` gets a tool error (`isError: true`, `structuredContent.preview` holds the object) and no confirmation token, so the call cannot be confirmed (#609).

**CLI**

- `renox new <name> --template home-services` writes the reference app `examples/home-services` (#566): a bilingual app for a UAE home-services company built from 16 official modules, with its own `renox.toml`, `renox.lock`, demo seed (`renox db seed`) and tests (`renox test --seed seeds/001_demo.sql`). The template is generated from the example by `examples/home-services/sync-template.ts`, and images and fonts are written byte for byte. The guide is the new docs page "Reference app" (`docs/reference-app.md`).
- The `storage` module has the service `uploadUrl(owner, name, { contentType, maxBytes, public })`: a signed URL for one browser `PUT` of up to `maxBytes` (capped at `max_upload_bytes`; SVG refused; the owner's quota checked at signing), for files past the 1 MiB action limit, and the browser helper `upload.js` (#581).
- `renox --help` lists `home-services` in the `new` usage line and summary; a test checks that every template under `cli/templates/` is named there (#618).
- The home-services template now uses the module features instead of its own workarounds: the `whatsapp` sandbox and `outbox`, `booking.setHours` on every sync, `reports.xlsx`, the `email` `from_name` and `org.rename` (#622).
- `renox check` (#595): the MF7 module-call scan matches imported `renox:modules` bindings in code only (comments, strings and `ctx.<name>.x` no longer count), and `missing-guard` skips `functions/tools/**`, whose `action` the cell already checks.
- `renox test`: the test worker looks for outbox rows written from another connection every 50 ms (`[jobs] poll_ms`), the harness writes a job tick as `renox jobs run` does (`runJob`), and its own SQLite connections wait on the worker's lock (`busy_timeout = 5000`) (#593).

**SDK**

- `JobContext.db` and `EventContext.db` are the new `TxDb` (statements plus `scoped`, no `transaction`), so `ctx.db.scoped(...)` type-checks in jobs and event handlers (#612).
- `@renoxium/sdk/test`: `t.job(name, { module?, timeoutMs? })` runs a scheduled job now and resolves after its commit (rejects with the job's error text); `t.tool(name, input, { as?, scope?, confirm? })` calls an App MCP tool as a user's agent (the auth module's OAuth flow, then `tools/call`, with the confirmation loop); `t.db` waits on the worker's write lock instead of failing with `SQLITE_BUSY` (#593).

## 0.1.8 (2026-11-08)

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.8/install.sh | sh
```

On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`.

**Worker**

- Pins `renox-worker` 0.5.0.
- `ctx.render(template, data)` renders a page or partial of the deployment to an HTML string (`op_render_template`, `ops.md` 1.8.0 section 25), in the request's locale and direction; the time counts as `render_ms` and `render_fuel`, a limit is `RENOX_RENDER_LIMIT`, an unknown id or one with `..` or a leading `/` is a `TypeError` (#577).
- `ctx.render` and `ctx.pdf.render` of a module read the module's own tree: the op adds the prefix `modules/<name>/` (`ops.md` 1.9.0 sections 24 and 25) (#577).
- A page action can return `{ status: 422, ...data }` (200, 400, 409 or 422): the page or the htmx fragment is rendered as before with that response status, and `status` is not template data; any other value is 500 `RENOX_INTERNAL` and the action's transaction is rolled back (`ops.md` 1.9.0 section 14) (#577).
- `ctx.storage.signUpload(key, { contentType, maxBytes, ttlSeconds, public })` (`op_storage_sign_upload`, `ops.md` 1.10.0 section 21) answers a URL on the app's own host for one browser upload of up to `maxBytes` bytes (at most the tier's per-file limit): `PUT /_files/<key>?exp=&max=&ct=&pub=&sig=`. The cell checks the signature (HMAC-SHA-256, base64url; anything wrong is 404 `RENOX_STORAGE_NOT_FOUND`), the `Content-Type` (`RENOX_STORAGE_TYPE`) and `max` (413 `RENOX_BODY_TOO_LARGE`, a declared length before a byte is read), then stores the file as `ctx.storage.put` does (sniffing, allowed types, quota) and answers 201 with the `StoredFile`. A successful upload spends the URL (409 `RENOX_STORAGE_CONFLICT` for the next one, table `renox__upload_sigs`); a refused one does not. Same origin only: no CORS headers. The gateway bounds a `PUT` to `/_files/` by 100 MiB instead of 1 MiB (#580).
**CLI**

- `renox apps list`, `renox apps rm <name>` and `renox apps restore <name>` (#536): delete one app without erasing the tenant. `rm` asks for the name again (or `--yes`), stops serving the app at once and keeps it restorable for 7 days; then the platform purges it. Needs a token with the scope `apps:delete` (owners and admins; a new `renox login` token has it).
- `renox apps rename <old> <new> [--yes] [--json]` (#537): rename an app; it keeps its deployments, data, secrets, custom domains, logs and meters, and is served at `<new>.renoxium.app` at once (the old hostname stops; its users sign in again). In the app's folder it offers to update `[app] name` in `renox.toml` (`--yes` updates it, changing only that value and keeping the line endings). `renox deploy` from a `renox.toml` with a name the tenant renamed away stops with `renamed to <new>; update renox.toml` (exit 1) instead of creating a new app. Same scope as `rm`: `apps:delete`.

## 0.1.7 (2026-11-07)

Fixes from the first native Windows use of 0.1.6. The pinned `renox-worker` stays 0.4.0.

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.7/install.sh | sh
```

On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`.

**CLI**

- `renox dev` tells the browser to reload only after the worker re-read its routes file (its `route table reloaded` line, at most 2 s). On Windows the worker polls that file every 500 ms, so a page edit was often fetched from the previous deployment and the browser did not seem to refresh.
- `renox dev` and `renox build` retry the rename of a just-written artifact or source-map folder while Windows reports `EPERM`, `EACCES` or `EBUSY` (a virus scanner or indexer holding it). An already existing content-addressed folder is kept. Before, `renox dev` printed `build failed: EPERM: operation not permitted, rename ...\.renox\sourcemaps\...` now and then.
- `renox test` in an app whose `@renoxium/sdk` is not installed says to run `bun install`, instead of bun's `Cannot find module '@renoxium/sdk/test'`.

**SDK**

- `@renoxium/sdk/test`: `app()` closes its read-only database before the test worker's folder is removed. On Windows the open file made `renox test` end with `EBUSY: resource busy or locked, rm '...\renox-test-...'` and a failed unnamed test after the app's tests had passed. The CLI's harness also retries that removal and leaves the folder with a warning instead of failing.

## 0.1.6 (2026-11-07)

The CLI pins `renox-worker` 0.4.0 (#526, #532), the first worker release with the pdf variant and a native Windows build.

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.6/install.sh | sh
```

On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`. It installs `renox.exe` and `renox-worker.exe`; `renox dev` and `renox test` run without WSL 2.

**Worker**

- Pins `renox-worker` 0.4.0 for the four Linux and macOS targets, with the pdf variant available: `RENOX_WORKER_VARIANT=pdf` in `install.sh`, `fetch-worker.ts --pdf` from a checkout (#524, #526).
- Apps with only `.html` pages and `public/` files (an empty `code.entry`, #495) now run in `renox dev` and `renox test`: 0.4.0 starts no isolate for them.
- Pins the native Windows x64 development worker, `renox-worker-0.4.0-x86_64-pc-windows-msvc.exe`: on Windows, `renox dev`, `renox test`, `migrate` and apps with `.html` pages or policies run natively, without WSL 2, and no longer stop with `RENOX_CLI_WORKER_UNAVAILABLE` (#532, #442). `install.ps1` installs it beside `renox.exe`. No pdf variant on Windows.

## 0.1.5 (2026-11-07)

A release of the same code as 0.1.4, made so that `@renoxium/cli` and `create-renox` are published by `release-cli.yml` through npm trusted publishing, with npm provenance. 0.1.4 of both was published by hand to register the names, so it has no provenance. The pinned `renox-worker` stays 0.3.0.

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.5/install.sh | sh
```

On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex`.

**CLI and SDK**

- No change in behaviour from 0.1.4. The CLI, `create-renox` and `@renoxium/sdk` carry the version 0.1.5.

**Release**

- `@renoxium/cli` and `create-renox` are published by the workflow's OIDC identity, without a token, and carry npm provenance from this version on (D30, #440). Check with `npm view @renoxium/cli@0.1.5 dist.attestations`.

## 0.1.4 (2026-11-07)

The tutorial template, `renox db seed` and `renox domains`, the first native Windows CLI, and the CLI and `create-renox` on npm (#483, #490, #492, #513, #440). The pinned `renox-worker` stays 0.3.0; the worker changes of #495 ship with the next `worker-v*` release and the CLI pin that follows it.

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.4/install.sh | sh
```

On Windows (x64, PowerShell): `irm https://github.com/arif-rachim/renox.rs/releases/latest/download/install.ps1 | iex` (#441).

**CLI**

- On Windows x64 the CLI can fetch, verify and run the native development `renox-worker.exe` (`fetch-worker.ts`, `install.ps1` installs it beside `renox.exe`); `renox dev` reloads routes there without `SIGHUP`. The CLI still reports `RENOX_CLI_WORKER_UNAVAILABLE` on Windows until the worker's SHA-256 is pinned (#531, #442).
- `renox new <name> --template tutorial` writes the checkpoint of chapter 1 of the tutorial (`docs/tutorial/`), a board with one page, one API route and one test (#483).
- `renox db seed` loads `seeds/*.sql` into the dev database: it applies the pending migrations, then runs the files in name order in one transaction; a failing statement rolls everything back and the error names `seeds/<file>:<line>` (#490).
- The SQL lint (rule `sql-interpolation`) sees through type arguments: `db.query<T>(`, `queryOne<T>(` and `execute<T>(` are checked like the untyped calls, and `db.scoped(...)` and `tx.scoped(...)` count as receivers (#490).
- `renox check` and the deploy type check generate the `renox:modules` types (`.renox/types/`) before running `tsc`, and the template `tsconfig.json` includes them and accepts `.ts` import extensions; errors inside installed module trees are not reported as the app's (#490).
- `renox authz explain --attr <key=value>` sets principal attributes for the check, and the output lists them (#492).
- `renox domains add|list|status|rm` manages the app's custom domains: `add` prints the CNAME and the two TXT records to create, `status` shows pending, then verified; the hosted MCP server has matching domain tools (#492).
- The tutorial is in the docs `search_docs` returns, and the tutorial checkpoints' tests run without the `RENOX_TEST_SPEC` guard (#492).
- Native Windows CLI: `renox-<version>-windows-x64.exe` and `install.ps1` in the release. `new`, `check` and `build` of an app without `.html` pages or policies, `login`, `deploy`, `logs`, `secrets`, `db`, `add`, `remove` and `mcp` run natively; `renox dev`, `test`, `migrate` and apps with pages or policies need WSL 2 and stop with `RENOX_CLI_WORKER_UNAVAILABLE` until the worker runs on Windows (#442). Credentials and the module cache live under `%APPDATA%` and `%LOCALAPPDATA%`, and artifact paths and hashes are the same as on Linux (#513).
- `@renoxium/cli` and `create-renox` on npm as Bun packages (`bun create renox`) (D30, #440).
- An app with only `.html` pages and `public/` files builds with an empty `code.entry` (artifact 1.6) and is accepted by `renox dev` and `renox test`; the worker that starts no isolate for it (#498, #499) is not in `renox-worker` 0.3.0, so running such an app needs the next `renox-worker` release and the CLI pin that follows it (#495).
- `renox add email` also delivers org invitations: email fills `org.send_mail` with the `org_invite` mail in EN/AR, in the organisation's locale, when `org` is installed (#475).
- Manifest 1.4: a module can list `[optional_dependencies]`; a hook of an optional dependency that is not installed is ignored instead of failing the build (rules MF5 and MF8, #503).

**SDK**

- `@renoxium/sdk` is licensed under Apache-2.0 from this version (`LICENSE`, ADR D29, #469); 0.1.0 to 0.1.3 were published under MIT and stay so.

**Worker**

- No new `renox-worker` release: the CLI pins 0.3.0. The worker changes of #495 (an empty `code.entry` is accepted under rule V30 and starts no isolate) are on `main` and wait for the next `worker-v*` release.

## 0.1.3 (2026-11-05)

What the first hour on a Mac found (#462; the pinned `renox-worker` stays 0.3.0).

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.3/install.sh | sh
```

**CLI**

- `renox test` works on macOS. The harness wrote the worker's `artifacts_dir` relative to its state directory under `$TMPDIR`, which on macOS is a symlink under `/var`; the worker resolved it into `/private/Users/...` and was refused at start-up. Every path in the generated worker configuration is now absolute.
- A worker that exits during `renox test` start-up now names its last error line and the configuration file in the hint, instead of only the exit code.
- `renox dev` no longer prints the worker's `disk usage unreadable` warning every 5 seconds on macOS, where the disk probe is unsupported.
- CI runs the first-hour smoke test on macOS as well as Linux; the script no longer needs `realpath`, which macOS before 13 does not have.

## 0.1.2 (2026-11-05)

The first hour of a new developer, from sign-up to a live deploy (batch ONBOARD-1: #443, #444, #445, #446, #447, #448, #449, #450). The pinned `renox-worker` stays 0.3.0; the worker change of #444 ships with the next `worker-v*` release and the CLI pin that follows it.

**Install**

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.2/install.sh | sh
```

**CLI**

- `renox test` works in the installed binary: it runs the real `bun` (exit 3 with the install hint when it is missing) instead of spawning itself without end, and refuses to run inside another `renox test` (#448).
- `renox add auth` works in the installed binary: the official modules are embedded and extracted to `~/.cache/renox/modules/<digest>/`, checked against their digest. Adding an official module offers the official modules it needs in the same prompt (`auth` brings `i18n`) (#448).
- `renox check` type checks the TypeScript with the app's own `typescript` (findings of rule `types` with file, line and column; one warning when `typescript` or `tsconfig.json` is missing; `--types-only`, `--no-types`). `renox deploy` refuses an app with type errors (exit 2) unless `--skip-types`. `run_check` over `renox mcp` returns the type findings (#443).
- `renox new` prints every step to a live app and the docs URL, writes a `README.md`, and `--template hello` adds a home page with its layout and a test; the app gets `typescript` and `bun-types` as devDependencies and a `typecheck` script (#449, #443).
- `renox dev` no longer prints the production node's warnings (`fetch_blocked_addresses`, `platform_key_file`, the disk watermark); other worker lines are one short line (`RENOX_DEV_RAW=1` for the JSON). It stops its worker on SIGTERM too. A handler that returns something other than a Response is named with a hint, with a worker that has #444 (#449, #444).
- `renox <command> --help` for every command, "did you mean" for an unknown command, unknown flags named, grouped `renox --help` (#449).
- `renox login` prints a link to the dashboard's `/device` page with the code filled in, and stops at once when the request is denied there (#446).

**Dashboard and site** (deployed from `main`, listed here for the developer's view)

- Sign in with email and password, the second factor (authenticator code, recovery code, passkey) and its set-up, and "forgot password"; the verification link signs you in (#445). The `/device` page approves `renox login`; a Tokens page creates, lists and revokes tokens (#446).
- The real install line instead of `bunx renox`, only the templates the CLI has, "Docs" in the navigation (#447). Broken links fixed, with a link checker (#449).

**Release**

- A CI job and a release step run the compiled CLI from outside the repository through the first hour (`cli/scripts/smoke.sh`) (#448).

## 0.1.1 (2026-11-04)

No change in behaviour; the CLI, the SDK and the pinned `renox-worker` 0.3.0 are those of 0.1.0. What changes is how the SDK is published:

- `@renoxium/sdk` 0.1.1 is the first version published by `.github/workflows/release-sdk.yml` through npm trusted publishing (the workflow's OIDC identity, no long-lived token), with npm provenance: `npm view @renoxium/sdk@0.1.1 --json | jq .dist.attestations`, or the Provenance badge on npmjs.com.
- The install line moves to `cli-v0.1.1`:

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.1/install.sh | sh
```

## 0.1.0 (2026-11-03)

The first public release of the CLI and the SDK (#431).

**Install** (Linux and macOS, x64 and arm64):

```sh
curl -fsSL https://github.com/arif-rachim/renox.rs/releases/download/cli-v0.1.0/install.sh | sh
```

The installer checks every file's SHA-256, and its sigstore signature when `cosign` is installed (`RENOX_REQUIRE_SIGNATURE=1` makes the signature mandatory). Verify by hand and the WSL 2 steps: `docs/12-developer-experience.md`, "Installing the CLI".

**What is in it**

- `renox` 0.1.0: four signed binaries (`bun build --compile`, no Bun needed to run them) with SLSA provenance. Commands: `new`, `build`, `dev`, `check`, `test`, `migrate`, `add`, `remove`, `approve`, `publish`, `jobs`, `authz explain`, `mcp`, `login`, `tokens`, `deploy` (with `--rollback`), `logs`, `secrets`, `db`. `renox --version` prints the CLI version and the pinned worker.
- Pins `renox-worker` 0.3.0 for all four targets (`x86_64` and `aarch64` Linux, `x86_64` and `aarch64` macOS), signed, the version production runs. `install.sh` installs it beside `renox`; the CLI refuses a worker without the pinned sha256 (closes #219).
- `@renoxium/sdk` 0.1.0 on npm: types and helpers for tenant code, with `@renoxium/sdk/kysely`, `/drizzle`, `/fakes` and `/test`. MIT licensed. `renox new` depends on it at the CLI's version. The SDK is scoped because npm refuses the unscoped name `renox` (D28).
- `renox login` defaults to `https://api.renoxium.com`; `renox deploy` puts the app live on `https://<app>.renoxium.app`.

**Known limits**

- No native Windows build: `renox-worker` runs on Linux and macOS only. Use WSL 2; `install.sh` prints the steps when it runs under Git Bash, MSYS2 or Cygwin.
- CLI 0.x: commands, flags and the `renox.toml` keys can still change between minor versions; breaking changes are listed here.
- `@renoxium/sdk` 0.1.0 was published by hand, so it carries no npm provenance; later versions are published by `.github/workflows/release-sdk.yml` with provenance.
- Not yet: Homebrew, Scoop, `npx` as an installer.
