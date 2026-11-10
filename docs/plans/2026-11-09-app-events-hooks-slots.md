# App-level event handlers, hook fillers, slot fillers and app events

**Goal:** an app takes part in the module system the way a module does: it handles module events (`org.member_added`, `whatsapp.message_received`), fills module hook points (`auth.principal`, `reports.nightly_to`), fills module slots (`admin.sidebar`, `admin.dashboard`) and emits its own declared events, so an app reacts at once instead of polling and extends `admin` instead of rebuilding it (#592; found by `examples/home-services`, #560 and #564).
**Done when:**
- An app with `hooks.ts` exporting `on` and `hooks` gets module events delivered (durable, at-least-once, same retries and dead letter as a module) and its hook fillers run in the module order with the app last; `renox check`, `renox build` and the worker accept it.
- `[[slots]]` in `renox.toml` renders an app partial inside `admin.sidebar` and `admin.dashboard` (and any other `<r-slot>`), with `requires` honoured.
- `[events]` in `renox.toml` declares app events with a payload schema; `ctx.events.emit("app.<name>", payload)` from app code works, modules and the app itself can handle them, and an undeclared or non-matching payload is refused as for a module.
- `examples/home-services` handles `org.member_added` (pending role applied at once) and `whatsapp.message_received` (dispatcher task), fills the two admin slots, and drops `jobs/inbox-sweep.ts`, `app__inbox_seen` and its own `/admin` pages; its tests pass.

## Decisions
- Where handlers live → `hooks.ts` at the app root exporting `on` and `hooks`, the module convention (`docs/10-modules.md` lines 92–111); one mechanism to learn, one discovery path to build.
- Hook fillers in v1 → yes, in the same file; #590 and #594 already rely on an app filling `auth.agent_orgs` / `reports.nightly_to`. The app needs no `permissions.hooks` (it is the tenant's own code).
- App-exported events → yes, declared under `[events."app.<name>"]` in `renox.toml` with `payload` (JSON Schema) and `description`, mirroring a module's `[exports.events]`; closes `ops.md` Open 8 and `manifest.md` Open 5.

## Assumptions (not asked, simplest option taken — change here if wrong)
- The app's module identity is `app` everywhere, as the runtime already has it (`bootstrap.js` lines 155–162; `ops.md` line 757 "the app itself is the module `app`"); its code entry is `hooks` (next to `modules/<name>/hooks`), its system principal `Renox::System::"app"`, its meter route `EVENT app <name>`.
- Event names an app emits are `app.<name>` only; handling a module event needs no declaration (today's rule, `ops.md` line 844); a module may handle `app.*` events the same way, with no dependency, and an app event with no handler is dropped as today.
- Slot fillers: `[[slots]]` in `renox.toml` with `name`, `template` (`partials/<x>.html`), optional `requires` (an action in `[authz] actions`) and `priority` (default 100); the manifest filler gets `module: "app"`; the compiler's "filler is a partial of its own module" check accepts the app's partials; order is by priority then module name with `app` sorting last on ties.
- Which module renders a slot is still undeclared (`manifest.md` Open 4); the app fills a slot by name and `renox check` warns when no installed module's templates contain `<r-slot name="…">` for it (a warning, not an error).
- The contract bumps: `artifact.md` 1.7 → 1.8 (top-level `events`, `hooks` code entry for the app in V7/V23, `module: "app"` fillers in V18/V22, `renox.toml` `[[slots]]` and `[events]` in the `renox.toml` section), `ops.md` → 1.11.0 (section 15.4: the app as a handler and an emitter; Open 8 closed), `manifest.md` a patch note on Open 5. Schemas and `validate.ts` follow.
- In-memory (`durable: false`) app handlers run inside the emitter's transaction, after every module's, as section 15.4 already says; a throw fails the emit with `RENOX_MODULE_SERVICE` as for a module.
- No `events/` directory, no per-event files; `renox check`'s lint and MF7 scan add `hooks.ts` to the app files they read.

## Scope
### In (v1)
- Contract: `artifact.md` 1.8, `ops.md` 1.11.0, `manifest.md` note, `manifest.schema.json`, `validate.ts`, examples under `docs/contracts/examples/` (an artifact with an app `hooks` entry, app slot fillers and an `events` map; an invalid one with an undeclared app event).
- CLI: `renox.toml` parsing of `[[slots]]` and `[events]`; `hooks.ts` as the `hooks` code entry; manifest `events` and `slots` for the app; `renox check` rules (template exists and is a partial, `requires` is a declared action, event names `app.<name>` with a valid JSON Schema, a warning for a slot nobody renders); templates compile with app fillers.
- Runtime and cell: register the app's `hooks` namespace (`isolate.rs` lines 2741–2793 register modules only), `register` in `bootstrap.js` accepts `app` without the `permissions.hooks` check, `eventHandlers` holds `app`, in-memory order app last, `deliver` runs app handlers with the system principal `app`, `op_events_emit` allows `app.*` names declared in the manifest `events` map with payload validation, outbox fan-out includes `app`; a worker release and pin.
- Docs: `docs/07-app-model.md` (tree: `hooks.ts`; sections "Events and hooks", "Slots"), `docs/10-modules.md` (an app as handler, filler and emitter), `docs/11-authorization.md` (the system principal of app handlers, `requires` on app fillers), `docs/tutorial` one short step or a note in step 10, `www` docs and `llms*.txt`.
- The example follow-up (epic #554): `examples/home-services/hooks.ts` handling `org.member_added` and `whatsapp.message_received`, `[[slots]]` for `admin.sidebar` and `admin.dashboard`, removal of `jobs/inbox-sweep.ts`, `app__inbox_seen`, the app's own `/admin` pages and the `/system/admin` mount; the template re-synced (#566 must have landed first).

### Out (later or never)
- Hook points exported by the app (`[hooks]` an app offers to modules): no consumer yet.
- Declaring which module renders a slot (`manifest.md` Open 4, `[exports].slots`).
- App events handled across tenants or by the platform; event payload versioning.
- A visual slot editor or per-tenant slot toggles.

## Approach
Numbered steps, each one small PR, in dependency order.
1. **Contract** (`type:contract`): `artifact.md` 1.8 (fields, V7, V18, V22, V23 updated; `renox.toml` section gains `[[slots]]` and `[events]`), `ops.md` 1.11.0 section 15.4 (the app handles, fills and emits; Open 8 closed), `manifest.md` Open 5 note; `manifest.schema.json` (`code.entries` `hooks`, `slots[].module` accepts `"app"`, top-level `events`), `validate.ts` rules and the example artifacts; `ctx.d.ts` unchanged (`EventContext`, `HookContext` already exist for modules).
2. **CLI build and check** (`track:T`, `cli/`): `cli/src/lib/project.ts` or `renox-toml` parsing for `[[slots]]` and `[events]`; `cli/src/lib/build.ts` adds the `hooks` code entry when `hooks.ts` exists, app fillers into `compilerSlots` and `slots`, the `events` map; `cli/src/lib/templates-compile.ts` and `crates/renox-template` `compiler/mod.rs` lines 350–359 accept app partials as fillers; `cli/src/commands/check.ts` rules above; `cli/src/lib/modules/build.ts` MF7 scan adds `hooks.ts`; tests in `cli/tests/build-events.test.ts` (new), `cli/tests/check-authz.test.ts`.
3. **Runtime and cell** (`track:R`): `isolate.rs` registers `hooks` for the app; `bootstrap.js` `register` (lines 890–941) accepts `app` (no `permissions.hooks` check, `hooks` fillers sorted with app last), `runInMemory` (949–961) app last, `deliver` (2259–2302) with `kind: "system", id: "app"`, `makeEvents().emit` (990–1016) allows `app.*` names from the manifest `events` map with the module's payload validation path; `crates/renox-cell/src/outbox.rs` fan-out includes `app` from `Isolate::event_handlers`; tests in `crates/renox-runtime/tests/events.rs` and `crates/renox-cell/tests/outbox.rs` (copies of `delivered_after_commit_to_both_modules` with an app handler; an app event emitted and handled by a module; an undeclared app event refused), `crates/renox-cell/tests/modules_pages.rs` (`slot_fillers_render_in_order_and_requires_skips` with an app filler); worker release and pin.
4. **Docs** (`track:O` docs): `docs/07`, `docs/10`, `docs/11`, tutorial note, `www` and `llms*.txt`, `CHANGELOG.md`.
5. **Example follow-up** (epic #554, after #566 and the worker pin): `examples/home-services/hooks.ts`, `[[slots]]`, removals above, tests (`tests/notifications.test.ts` inbound reply handled at once with `t.job` no longer needed for the sweep; `tests/admin.test.ts` the app's tile and sidebar entry inside `/admin`), template re-sync.

## Risks and how we handle them
- An app handler that throws on every attempt dead-letters after 8 attempts like a module's → same retry table, the dashboard's outbox view already shows dead letters → accept.
- App code running under the system principal in handlers could bypass page policies → the handler's `ctx.authz` is the system principal as for module handlers today; `db.scoped` is available (#612); documented in `docs/11` → accept.
- A slot filler from the app renders inside a module layout with the module's CSS → fillers are partials; the admin layout's CSS variables are documented in `modules/admin/README.md` → accept.
- `renox check` cannot know whether a slot name exists (Open 4) → a warning naming the slot, not an error; a typo shows up as an unrendered filler in `renox dev` → accept.
- Artifact 1.8 and worker: an old worker given a 1.8 artifact → the cell refuses an unknown artifact version as today (section 8 of `artifact.md`); the CLI pins the new worker → handled by the release order (contract → CLI → worker → pin).
- The example's `/admin` removal changes URLs seeded in docs and screenshots → #567 (screenshots) runs after this → handled by ordering.

## Verification
- Automated: step 1 `make docs-check` and `bun run docs/contracts/validate.ts`; step 2 `cd cli && bun test tests/build-events.test.ts tests/check-authz.test.ts tests/build-modules.test.ts`; step 3 `cargo test -p renox-runtime --test events`, `cargo test -p renox-cell --test outbox --test modules_pages`; step 5 `renox test --seed seeds/001_demo.sql` in the example and `cli/tests/examples.test.ts`.
- Manual: under `renox dev` with the pinned worker, invite a technician in the example, accept the invitation in a second browser, and see the role applied without opening `/admin/users`; send a WhatsApp "cancel" to the sandbox webhook and see the dispatcher task appear; open `/admin` and see the app's tile and sidebar entry.

## Open questions deferred
- Whether an app filler should be able to replace (not add to) a module's filler for the same slot (implementer: no; additive only).
- The exact warning text for a slot nobody renders (implementer picks; one line naming the slot and the installed modules).
- Whether `ctx.events.emit` from an app may be `durable: false` (implementer: yes, same as modules).
- Payload schema size limit for `[events]` (implementer: the module manifest's existing limit).
