# control/dashboard

The Renox control-plane dashboard, built as a Renox app (design principle 7, dogfooding; `docs/03-architecture.md`, "Dashboard"; #57). Pages, partials and htmx fragments render on the cell like any tenant's; the data comes from the control API (`docs/contracts/deploy-api.md`).

## Screens

The F3 subset of `docs/19-platform-wireframes.md`:

| Page | Wireframe | What it does |
| --- | --- | --- |
| `/signin`, `/signout` | — | Sign in with a tenant token; sign out deletes it (below) |
| `/apps` | 3.1 Org overview, 3.2 New app | The tenant's apps: status, live version, hostnames; create an app (`apps:write`) |
| `/apps/:app` | 3.3 App overview | Status, live version and deploy time, hostnames, the last 24 h of usage, recent deployments with Promote/Rollback, the latest log lines |
| `/apps/:app/deployments[?hash=]` | 3.4 Deployments | Every deployment with its state; Promote (`validated` or `superseded` → live) and Rollback (`deploy`); with `hash`, the validation violations, permissions, secret-set version and activation error |
| `/apps/:app/logs` | 3.5 Logs | Level, source (`all`/`server`/`client`), search, window (15m–7d) and deployment filters; Live streams new lines over SSE (`/sse/logs`), with the 2-second poll of the `log_lines` fragment as the fallback |
| `/account/security` | 3.14 (account) | The signed-in user's second factors with their own token: authenticator app, passkeys, recovery codes (step-up inline), removal; the team's requirement shown |
| `/apps/:app/usage[?range=24h\|7d\|30d]` | 3.13 Usage, per app | Requests, CPU, egress and average latency (mean wall time per request) per hour as SVG bars; totals; the tenant's monthly quota with `over` flagged. Latency percentiles and realtime connections need the usage API to carry them (`UsageHour` in deploy-api.yaml has neither, #296) |
| `/apps/:app/secrets` | 3.9 Secrets | Names and update times (never values); add or replace (`secrets:write`), delete with a confirmation |
| `/apps/:app/database` | 3.8 Database | Size, quota, WAL, replication status and lag (`GET …/backups`); the Backups panel (generations, a restore point, "Restore to new app" with a confirmation and a link to the new app); the Export panel (a signed link the browser downloads; the dashboard never proxies the bytes). The Tables and Query panels are F7 (`admin`) (#258) |
| `/ops/tenants/:tenant` | 5 Operator console | With `OPS_CONSOLE` on: change the tier, move to a named node, move to a microVM, each with a reason, a confirmation, and the operator's `renox_op_` token. The token is passed to the API for that one request and never stored: the dashboard is a tenant (D23). The API decides `ops:write` (only an account flagged `operator` mints it) (#259). "Show status" reads `getOpsTenant` (0.3.1) with the operator's token, kept no longer than that request either: tier and process, node and pin, the microVM state, the replication each database's node last reported (stale after two heartbeats) and the last five operator actions with their reasons (#296). **Break-glass** (#310, 0.4 section 17): "Start break-glass" with a reason and a token created with `ops:impersonate` signs this dashboard session in with the read-only impersonation token for 60 minutes (it replaces the operator's own sign-in; the operator token is used for that one call); every page then shows a banner (tenant, impersonation id, end time) from `app__impersonations` (`migrations/003_impersonations.sql`); the status panel lists active impersonations first with an End button; the time box, End and Sign out each end it |

Not in F3: metrics (3.6, needs #77), modules (3.7, F4), the Tables and Query panels of database (3.8, F7), domains (3.10), realtime and jobs (3.11, 3.12, F5/F6), team (3.14), app settings (3.15), the operator console. The URL scheme drops the `/o/<org>` prefix of the wireframes: one sign-in is one tenant token, bound to one tenant, so the org is implied (the tenant id is shown on `/apps`).

Every page works without JavaScript except the Live log view and adding a passkey (`public/live-logs.js`, `public/passkey.js`); forms are `<x-form>` (CSRF-checked by the cell, htmx-swapped into `#page`) or plain forms with `<x-csrf>`. The layout collapses to one column on a phone.

## How it reaches the control API (ADR D23)

The dashboard is an ordinary tenant. It calls the API at its public hostname, `api.renox.app`, declared in `renox.toml` `[permissions] network`, with `ctx.fetch` under every tenant rule (allowlist, DNS in Rust, blocked ranges, `fetch_blocked_addresses`). There is no exemption, no `internal` flag, no node token.

The credential is the signed-in user's own **tenant token** (`renox_pat_…`), forwarded on every API call, so the user acts with exactly their scopes and role (`control/api/README.md`, "Roles"). The dashboard does not proxy the API's password login: the API's per-IP sign-in buckets would see the node's address for every user (D23, Consequences). A user gets a token from `renox login` or, for the dashboard only:

```sh
renox tokens create dashboard --scope apps:read --scope apps:write --scope deploy --scope logs:read --scope secrets:read --scope secrets:write --expires-days 7
```

`lib/session.ts` keeps the token per platform session (`ctx.session.id`, the signed `__Host-renox_sid` cookie) in `app__sessions`, encrypted with AES-256-GCM under a key derived by HKDF-SHA-256 from the `DASHBOARD_KEY` secret, with the session id as associated data. Sign-ins expire after 24 h idle or 30 days, like API sessions, and when the API answers 401 (the token expired or was revoked). Signing out deletes the row; the token stays valid at the API until it expires or `renox tokens revoke` revokes it. No shared service token is used: a token in `ctx.secrets` would show one tenant's data to every visitor.

`lib/guard.ts` decides the redirect to `/signin` from SQLite alone, before the first API call: a loader slower than the 50 ms shell delay can no longer answer with a `Response` (`docs/contracts/ops.md` section 14, "Streaming the shell"), so API failures (unreachable, 401, 403, 404) are rendered in the page, not sent as a status.

## Configuration

| Secret | Required | Meaning |
| --- | --- | --- |
| `DASHBOARD_KEY` | yes | At least 32 characters; derives the key of stored sign-ins. Changing it signs everyone out |
| `RENOX_API_URL` | no | Another control API (`https://` only); its host must also be in `[permissions] network` |
| `OPS_CONSOLE` | no | `operators` turns on the operator console (`/ops/tenants/:tenant`) on this deployment; anything else answers 403 there |

## Run

```sh
cd control/dashboard
printf 'DASHBOARD_KEY=%s\n' "$(openssl rand -base64 32)" > .env
bun ../../cli/src/main.ts dev --port 8790
```

`renox dev` runs it like any app. A control API on `localhost` cannot be reached from it: tenant `fetch` blocks loopback and private addresses for the dashboard as for everyone (`tests/dashboard.e2e.test.ts` proves the refusal). To use a local control API, publish it under a public HTTPS hostname (a tunnel), set `RENOX_API_URL` to it in `.env`, and add its host to `network` in `renox.toml` for the session.

## Deploy as the first internal tenant

1. Sign up the platform's own tenant and its owner (`POST /v1/account/signup` with `tenant_id`, then verify the email), and sign in with `renox login`.
2. `renox secrets set DASHBOARD_KEY --app dashboard` (a random 32-byte value), then `renox deploy` from this folder.
3. Attach the dashboard hostname (`CONTROL_DASHBOARD_URL` of the API, default `https://dashboard.renox.app`) to the app: `POST /v1/apps/dashboard/domains` (`domains:write`; the CLI has no `domains` command yet).
4. The node that runs it lists the control plane's node-facing addresses in `fetch_blocked_addresses`, not the public API address (D23).

The deployment is recorded in the F3 review (#61).

## Tests

`bun test` in this directory:

- `tests/session.test.ts`: the token is stored only encrypted, a row copied to another session or read with another key does not decrypt, idle and absolute expiry, no key no sign-in, only `renox_pat_` tokens.
- `tests/pages.test.ts`: every loader and action against the real control API in process (`control/api` on PGlite) through a fake `ctx` whose `fetch` reaches only `https://api.renox.app`: sign-in and `next` (no open redirect), sign-out, a revoked token, the app list and create, Promote/Rollback and the deployment detail, logs filters and the live fragment, usage bars and quota, secrets set/list/delete with the value never returned or logged, and the API's 403 and 404 shown on the page.
- `tests/client-errors.test.ts`: the Browser errors page (#128) against the real control API: groups, the original TypeScript position from a privately uploaded sourcemap, resolve/ignore/reopen, the 80 % quota warning, and the link from a client log line to its group. With `RENOX_WORKER_PATH`, the screenshot test renders the group view and the Logs page filtered to `source: client` through the worker and checks the HTML. A local control API cannot be reached from `renox dev` (see above), so `devWithData` in `tests/helpers.ts` runs `renox dev` on a copy whose two loaders return what the real loaders returned in process. Where Node resolves Playwright (or `PLAYWRIGHT_PATH`), it also shoots both pages in Chromium and fails on any console error or CSP violation. The PNGs go to `RENOX_SCREENSHOTS` (default: a temporary directory). The map is the committed fixture in `control/api/test/fixtures/sourcemaps/`.
- `tests/database.test.ts`: the Database page (#258) against the real control API with a fake node: the header, the generations, restore into a new app (bad input refused before the API, `apps:read` refused by it), and an export that answers a signed link the dashboard never fetches. With `RENOX_WORKER_PATH`, it renders the page through the worker and shoots it like the test above.
- `tests/ops.test.ts`: the operator console (#259): 403 without `OPS_CONSOLE`; with it, a tier change sent once with the operator token, which is not kept and does not replace the sign-in; bad input refused before the API; a token without `ops:write` shown as the API's refusal; the status panel (#296) read once with the operator token, not kept, an unknown token shown as the API's 401. With `RENOX_WORKER_PATH`, the worker renders the status panel and the three actions.
- `tests/dashboard.e2e.test.ts` (with `RENOX_WORKER_PATH`): the build's routes, fragments and permissions, `renox check`, and under `renox dev` the redirects, the sign-in form with CSRF, every signed-in screen rendered by the worker, the `log_lines` fragment, and a loopback control API refused with `RENOX_FETCH_BLOCKED`.

## Second factors and live logs (#293, #307)

The control API holds the second factors of accounts (`control/api/README.md`, "Second factors"). The dashboard signs in with the user's own token, never with a password (ADR D23, above), and from deploy API 0.4 (section 18, "User token rule") the MFA endpoints accept that token, acting for its user. `/account/security` (`pages/account/security.ts`) uses it: the factors on the account, adding an authenticator app (the key and the `otpauth://` link, then a code) or a passkey (`public/passkey.js` asks the browser for the credential the API's options describe), new recovery codes, and removal with the password and a code. A token's verification counts for that token only and lasts 15 minutes; when the API answers `step_up_required`, the page asks for a code inline and then does what it was asked. A refused code shows a message and keeps the sign-in. The team's `mfa_required` stays session only in the contract (`setTeamMfaRequired`): the page shows the requirement and never sends it with a token. The sign-in challenge itself still happens where the password is: at `POST /v1/account/login`, before the device flow (`renox login`) creates the token.

Live logs: the Logs page in Live mode opens `GET /sse/logs?app=…&level=…` (`functions/sse/logs.ts`). Before anything is sent, the handler needs a dashboard sign-in and the control API's answer to the user's token for that app (so only a member of the app's tenant gets a stream), then subscribes the connection to a topic of its own (`logs:<app>:<128 random bits>`; `policies/logs.cedar` permits only that shape), records a row of `app__log_followers` (`migrations/002_log_followers.sql`) and queues the job `log-follower` (`jobs/log-follower.ts`, ops.md section 20). Each run of the job reads the lines after the last one sent with that session's token (a non-follow `GET …/logs?since=`, so one attempt stays far below the wall-clock limit), publishes the ones that pass the page's filters as rows of `partials/log-rows`, and queues its next run a second later. Closing the page deletes the row and the job stops; so it does after 15 minutes or when the sign-in ends, and the page then falls back to its 2-second poll (`public/live-logs.js` also falls back when the stream cannot open). One attempt per second per open page is metered as a job record.

## Languages (#336)

Every template's text is in `i18n/en.json` and `i18n/ar.json` (keys `dash.<page>.<name>`, `<r-t key>` and `'key' | t`; the Arabic follows `modules/i18n/GLOSSARY.md` and is machine translated until a native speaker reviews it). The dashboard installs no modules, so `lib/locale.ts` chooses the locale itself: `?lang=en|ar` (on a full-page GET a 303 to the same address without `lang`, with a `renox_lang` cookie for a year), then that cookie, then `Accept-Language`, then English; `ctx.setLocale` sets `<html lang dir>` and the catalog. `lib/guard.ts` `signedIn()` calls it first, and the pages without a sign-in (sign-in, sign-up, verification, the legal pages) call it in their loaders. The header links to both languages. Messages built in TypeScript (notices, form errors, problem messages, `ago()`, the state labels, the checklist, the chart titles) come from the same catalogs through `lib/i18n.ts`: `trOf(ctx)` looks a key up in the request's locale, with the ICU subset of the renderer (`{name}`, `plural` with the Arabic categories); the pure helpers of `lib/` take the lookup as a last argument and default to English. `renox check` (`i18n-missing-key`) keeps both catalogs complete; `tests/i18n.test.ts` checks the catalogs and renders pages in Arabic through the worker.

## Notes

- Actions call the API inside the action's transaction (`ops.md` section 14 asks to avoid `fetch` there): Promote and Rollback wait for the node's prepare, so the dashboard's one writer is held meanwhile. The dashboard writes nothing but sign-ins, so only concurrent sign-ins wait.
- `verification_uri` of the API's device flow points at `<dashboard>/device`; approving a device needs an API session, which the dashboard does not hold, so that page is not here (`renox login` approval stays with the API session).
- `public/htmx-2.0.4.min.js` is htmx 2.0.4 (0BSD), vendored unchanged as in `examples/shop`.
