# Developer journey end-to-end test, and app deletion

**Goal:** one automated test that follows a developer through the whole product (sign up in a browser, approve `renox login`, create and deploy an app, read logs and browser errors in the dashboard, install a module, redeploy, delete the app, erase the tenant), so the joints between the pieces that are tested today in isolation are tested too; and the one missing feature it needs, deleting an app.
**Done when:**
- `cli/tests/journey.e2e.test.ts` runs the chain above against the real control API, a controlled `renox-worker`, the real CLI as a process and Chromium (Playwright), and passes.
- A workflow `journey.yml` runs it on every push to `main` and nightly, and opens or comments on an issue labelled `journey` when it fails (the `chaos.yml` pattern); the existing browser tests (`control/dashboard/tests/account.browser.test.ts`, `cli/tests/browser/client-events.test.ts`) run in the same workflow instead of always skipping.
- `DELETE /v1/apps/:app` soft-deletes an app (served 404, hidden from the list, name reserved), `POST /v1/apps/:app/restore` undoes it within 7 days, and a sweep purges deployments, artifacts, routes and client-error groups after 7 days; `renox destroy <app>` and a Delete button on the app's settings page call it.

## Decisions
- Journey scope → the developer core, no billing (D31 defers payments; the billing path keeps its own API and dashboard tests).
- Delete an app → soft delete with a 7-day restore window and a purge sweep (undoable; the hard delete can be added later as `--now` if ever wanted).
- Where it runs → a separate workflow on `main` and nightly, not on every PR (keeps PR feedback fast; Playwright and the chain cost minutes).
- Live platform → not in scope; the journey runs only against a local control plane. Synthetic monitoring of `renoxium.com` stays the existing uptime check.

## Assumptions (not asked, simplest option taken — change here if wrong)
- Playwright is installed in the workflow with `bunx playwright@<pinned> install chromium --with-deps` and found through `PLAYWRIGHT_PATH` (the loader in `control/dashboard/tests/playwright.ts` and `cli/tests/browser/`); it is still not a dependency of any `package.json`.
- The journey test lives in `cli/tests/journey.e2e.test.ts`, built from `cli/tests/deploy.e2e.test.ts` (control API on PGlite, in-memory artifact store, controlled worker, CLI as a process) plus the dashboard served by the worker as `control/dashboard/tests/dashboard.e2e.test.ts` does. It is tagged so `make ts-test` does not run it (`RENOX_JOURNEY=1` gate), and `make journey` runs it locally.
- The verification and device-approval steps are done in Chromium against the dashboard pages; the mail is read from the in-process mailer's outbox as `account.browser.test.ts` does.
- The app deployed is `cli/templates/hello`; the module installed is `auth` (`renox add auth --yes`), the same steps `cli/scripts/smoke.sh` already runs.
- "See an error in the UI": the test deploys a second version whose page throws in the browser, opens the dashboard's Browser errors page and asserts the group with the file and line; and reads one line in the Logs page.
- Soft delete: a nullable column `apps.deleted_at bigint` (new migration `control/api/migrations/0033_apps_deleted.sql`); every app read (`listApps`, `getApp`, the router's host lookup, deployments, domains, secrets, logs) excludes rows with `deleted_at`; the name stays in the table until the purge so nobody else can take the hostname meanwhile. Delete needs the session permission `apps:delete` (owner, admin; `control/api/src/tenancy/roles.ts`) and is written to the audit log.
- Purge: `sweepAppDeletions(deps)` on the control API's existing `setInterval` list (`control/api/src/main.ts`), every 10 minutes, deleting rows older than 7 days from `routes`, `domains`, `client_error_groups`, `backups`, `deployments` (and their artifacts through the existing pruning path), then `apps`. Tenant erasure (`control/api/src/tenants/erasure.ts`) already covers apps in bulk and is not changed.
- CLI: `renox destroy <app>` asks to type the app's name (`--yes` skips), prints the restore window and `renox destroy --restore <app>`. Dashboard: a Delete section on `pages/apps/[app]/settings.html` with the same typed confirmation; the deleted app is listed in a "Deleted, restorable until <date>" block on `pages/apps/index.html` with a Restore button.
- The workflow reuses the packaged worker the `rust` job builds (download from the latest `main` run, else build), as `single-host-e2e` does; it does not add a second worker build.

## Scope
### In (v1)
- `journey.yml`: Playwright install, the journey test, the two existing browser test files, issue on failure, `workflow_dispatch`.
- `cli/tests/journey.e2e.test.ts` with the chain: sign-up → verify from mail → signed-in dashboard → `renox login` with the device page approved in the browser → `renox new` → `renox deploy` → page answers on its hostname → Logs page shows the request → deploy a version with a browser error → Browser errors page shows the group → `renox add auth --yes` → `renox deploy` → `/auth/login` answers → `renox destroy` → 404 and the app gone from the list → restore → 200 → destroy again → tenant erasure through the existing settings flow → the API refuses the token.
- `DELETE /v1/apps/:app`, `POST /v1/apps/:app/restore`, the sweep, the migration, API tests in `control/api/tests/api.test.ts` (or a new `apps-delete.test.ts`), dashboard tests in `control/dashboard/tests/pages.test.ts`.
- `renox destroy` with `--yes` and `--restore`, tests in `cli/tests/destroy.test.ts` against the fake API as `deploy.test.ts` does; the command in `cli/README.md`, `docs/12-developer-experience.md` command table, `www/public/llms*.txt`.
- `make journey` target and a line in `docs/12-developer-experience.md` ("Tests", what the journey covers and where it runs).

### Out (later or never)
- Billing, tier upgrade, invoice mail in the journey (D31).
- The journey against the live platform, synthetic monitoring, test accounts in production.
- Domains and team pages in the dashboard (API only today; separate issues).
- Hard delete without the 7-day window; deleting from `www`.
- Running the journey on pull requests.
- `install.sh` in `cli-smoke` (worth doing, separate small issue).

## Approach
Numbered steps, each one small PR, in dependency order.
1. App deletion in the control API: migration `0033_apps_deleted.sql`, `deleted_at` filtering in `control/api/src/apps/repo.ts` and the router's host lookup, `DELETE /v1/apps/:app` and `POST /v1/apps/:app/restore` in `control/api/src/apps/routes.ts` with `apps:delete`, the audit entry, `sweepAppDeletions` and its interval in `main.ts`; `deploy-api.md` section for the two endpoints; tests.
2. `renox destroy <app> [--yes] [--restore]` in `cli/src/commands/destroy.ts`, wired in `cli/src/main.ts`; docs lines; tests against the fake API.
3. Dashboard: Delete section on the app settings page, the restorable list on the apps index with Restore; tests in `control/dashboard/tests/pages.test.ts`; i18n strings EN and AR.
4. Playwright in CI: `.github/workflows/journey.yml` (push to `main`, nightly `cron`, `workflow_dispatch`; Chromium install; `PLAYWRIGHT_PATH`; runs `control/dashboard/tests/account.browser.test.ts` and `cli/tests/browser/client-events.test.ts`; issue on failure as `chaos.yml`); the same install documented in `docs/12` for local runs.
5. The journey test `cli/tests/journey.e2e.test.ts` and `make journey`, added to `journey.yml`; `docs/12` paragraph.

## Risks and how we handle them
- Flaky browser steps on the runner → every wait is a `waitForURL` / `waitForSelector` with a timeout, no sleeps; one retry of the whole job in the workflow (`nick-fields/retry` is not used; the workflow re-runs the step once with `if: failure()`), and a failure opens an issue rather than blocking a PR → accept.
- The app's name is a global primary key; a soft-deleted app must not free its hostname to another tenant → the row stays until the purge; the sweep deletes it last → handled.
- Foreign keys from `routes`, `domains`, `client_error_groups`, `backups`, `deployments` to `apps(name)` → the purge deletes children first in one transaction; artifacts through the existing deployment pruning so the store does not leak → handled; a test counts the rows and store objects after the purge.
- Chromium plus control API plus worker on one runner is slow → the journey is on `main` and nightly only; budget 10 minutes for the job → accept.
- The journey duplicates steps of `smoke.sh` and `single-host-e2e` → it does not replace them: the smoke tests the binary on two OSes, the single-host test tests the units; the journey tests the joints → accept.

## Verification
- Automated: `control/api` tests for delete, restore, filtering, the sweep; `cli/tests/destroy.test.ts`; dashboard page tests; `journey.yml` green on `main` with the three browser suites.
- Manual: run `make journey` locally with `RENOX_WORKER_PATH` and Playwright installed and watch the chain finish in under 3 minutes; then on the live dashboard delete and restore a scratch app by hand once.

## Open questions deferred
- Whether `renox destroy` should also remove the app's custom domains at once or leave them for the purge (implementer: leave them; they stop resolving because the app is 404).
- Whether the deleted app's secrets are purged at delete or at purge (implementer: at purge, so restore keeps them).
- The exact issue title and label for a journey failure (implementer copies `chaos.yml`, label `journey`; create the label).
- Whether the nightly also runs `examples/shop/tests/browser-check.ts` and `examples/chat/tests/browser-check.ts` (implementer: yes if they pass on the runner within 2 minutes, else a follow-up issue).
