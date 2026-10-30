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
| `/apps/:app/logs` | 3.5 Logs | Level, source (`all`/`server`/`client`), search, window (15m–7d) and deployment filters; Live polls the `log_lines` fragment every 2 s |
| `/apps/:app/usage[?range=24h\|7d\|30d]` | 3.13 Usage, per app | Requests, CPU and egress per hour as SVG bars; totals; the tenant's monthly quota with `over` flagged |
| `/apps/:app/secrets` | 3.9 Secrets | Names and update times (never values); add or replace (`secrets:write`), delete with a confirmation |
| `/apps/:app/database` | 3.8 Database | Size, quota, WAL, replication status and lag (`GET …/backups`); the Backups panel (generations, a restore point, "Restore to new app" with a confirmation and a link to the new app); the Export panel (a signed link the browser downloads; the dashboard never proxies the bytes). The Tables and Query panels are F7 (`admin`) (#258) |
| `/ops/tenants/:tenant` | 5 Operator console | With `OPS_CONSOLE` on: change the tier, move to a named node, move to a microVM, each with a reason, a confirmation, and the operator's `renox_op_` token. The token is passed to the API for that one request and never stored: the dashboard is a tenant (D23). The state shown is the last action's answer, because 0.3 has no read endpoint for operators. The API decides `ops:write` (only an account flagged `operator` mints it) (#259) |

Not in F3: metrics (3.6, needs #77), modules (3.7, F4), the Tables and Query panels of database (3.8, F7), domains (3.10), realtime and jobs (3.11, 3.12, F5/F6), team (3.14), app settings (3.15), the operator console. The URL scheme drops the `/o/<org>` prefix of the wireframes: one sign-in is one tenant token, bound to one tenant, so the org is implied (the tenant id is shown on `/apps`).

Every page works without JavaScript except the Live log poll; forms are `<x-form>` (CSRF-checked by the cell, htmx-swapped into `#page`) or plain forms with `<x-csrf>`. The layout collapses to one column on a phone.

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
- `tests/ops.test.ts`: the operator console (#259): 403 without `OPS_CONSOLE`; with it, a tier change sent once with the operator token, which is not kept and does not replace the sign-in; bad input refused before the API; a token without `ops:write` shown as the API's refusal. With `RENOX_WORKER_PATH`, the worker renders the three actions.
- `tests/dashboard.e2e.test.ts` (with `RENOX_WORKER_PATH`): the build's routes, fragments and permissions, `renox check`, and under `renox dev` the redirects, the sign-in form with CSRF, every signed-in screen rendered by the worker, the `log_lines` fragment, and a loopback control API refused with `RENOX_FETCH_BLOCKED`.

## Second factors and live logs (#293)

The control API holds the second factors of accounts (`control/api/README.md`, "Second factors"). The dashboard signs in with the user's own token, never with a password (ADR D23, above). So the factor is given where the password is: at `POST /v1/account/login`, in a browser session of the API, before the device flow (`renox login`) creates the token the dashboard uses. Approving that device login is itself stepped up. The dashboard therefore has no sign-in challenge step and no security page of its own yet: it would need the MFA endpoints to accept a token, which #293 did not change.

The Logs page stays on its 2-second poll of the `log_lines` fragment. A live SSE feed needs something to follow `GET /v1/apps/{app}/logs?follow=1` and publish into a topic. A Renox handler runs only for the length of a request, so that follower has to be a platform job (#297) or a node-side subscriber. Until one exists, every poll is one bounded request.

## Notes

- Actions call the API inside the action's transaction (`ops.md` section 14 asks to avoid `fetch` there): Promote and Rollback wait for the node's prepare, so the dashboard's one writer is held meanwhile. The dashboard writes nothing but sign-ins, so only concurrent sign-ins wait.
- `verification_uri` of the API's device flow points at `<dashboard>/device`; approving a device needs an API session, which the dashboard does not hold, so that page is not here (`renox login` approval stays with the API session).
- `public/htmx-2.0.4.min.js` is htmx 2.0.4 (0BSD), vendored unchanged as in `examples/shop`.
