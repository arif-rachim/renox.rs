# Chapter 10: Deploy and a custom domain

**What you build:** the board, live on `https://<app>.renoxium.app`, with its logs and usage in the dashboard and, if you have one, your own domain in front of it. The checkpoint adds one page: the app's own "not found" page.

## A page for "not found"

`pages/_404.html` replaces the platform's default 404 page; like `_layouts/`, a file whose name starts with `_` is not a route:

`pages/_404.html`:
```html
<r-layout use="main">
  <r-group slot="title">Not found</r-group>
  <h1>Not found</h1>
  <p>There is no page at this address. <a href="/board">Back to the board</a>.</p>
</r-layout>
```

## Sign in once

```sh
renox login
```

```
Open https://dashboard.renoxium.com/device?code=BCDF-GHJK
and check that it shows the code BCDF-GHJK, then approve.
Waiting for approval…
Signed in to my-workspace. Token saved to /home/you/.config/renox/credentials.json
```

Create the account at https://dashboard.renoxium.com first if you have none. In CI, set `RENOX_TOKEN` to a token from the dashboard's **Tokens** page instead.

## Deploy

App names are global. `board` is likely taken, so give yours its own name in `renox.toml` first, for example `name = "acme-board"`. Then:

```sh
renox deploy
```

```
Bundling… <n> routes, <n> modules, <n> templates
  Created app acme-board
  Uploading <size> → api.renoxium.com
  Validating… ✓ manifest ✓ routes ✓ templates ✓ permissions ✓ bundle (validated)
  Activating… ✓ migrations ✓ cell ✓ probe
  Live: https://acme-board.renoxium.app  (<deployment hash>)
```

(The shape of the output; your counts, sizes and times go where the `<…>` are.) `renox deploy` type checks first, as `renox check` does, and stops on a type error before anything is uploaded. The migrations run before the new code takes traffic. Every deployment is kept: `renox deploy --rollback` switches back to the previous one at once, without a build. Rolling back never undoes a migration, so a new column must be one the older code can ignore, as `team_id` with its default is ([Developer experience, deploy without downtime](../12-developer-experience.md#deploy-without-downtime)).

Open the live URL, register, create a team and invite a colleague. The invitation link is in the `outbox__mail` table: from CLI 0.1.4, `renox add email` delivers invitations too; the board keeps `modules/outbox` so the tutorial runs without a mail provider (chapter 6). [What you should see: the finished board](screenshots/10-finished.png).

**The finished app, deployed:** not yet. Deploying this checkpoint on `renoxium.app` is an owner step of #430; its link goes here when it is live.

## Logs and usage

```sh
renox logs --follow
```

prints your app's log lines as they happen, the browser errors of chapter 2 included (`source: client`). In the dashboard, open the app:

| Page | What it shows |
| --- | --- |
| **Logs** | The same lines, filtered by source and deployment |
| **Client errors** | Browser errors grouped by cause, per deployment, with the original TypeScript line |
| **Usage** | Requests, CPU time, database time and egress per hour: what the bill is made of |
| **Deployments** | Every deployment, with rollback |
| **Secrets** | Names only; values are set with `printf %s "$VALUE" \| renox secrets set NAME` |
| **Domains** | Custom domains with their state and the DNS records to create |

## Your own domain

Custom domains go through Cloudflare for SaaS: you point a CNAME at the platform, Cloudflare checks you own the name and issues the certificate, and the domain serves the same deployment as `<app>.renoxium.app`.

**Use `www.`, not the bare domain.** The platform has no fixed address to give you for `example.com` itself. Add `www.example.com`, and redirect `example.com` to it at your DNS provider or registrar (or use CNAME flattening if your DNS provider offers it).

Add the name from the app's folder (or pass `--app`):

```sh
renox domains add www.example.com
```

It prints the records to create. The CNAME is `www.example.com → <cname_target>`; the two TXT records are `ownership` (Cloudflare's pre-validation) and `dcv` (the certificate's). Create all three at your DNS provider. The platform asks Cloudflare every minute; when the name is verified, it serves your app. Check with:

```sh
renox domains status www.example.com
```

`status` moves from `pending` to `verified`. `renox domains list` shows every domain of the app, and `renox domains rm www.example.com` removes one. The dashboard's **Domains** page under the app does the same, and so does the MCP tool `add_domain` (with `list_domains`, `domain_status` and `remove_domain`). Adding and removing need the `domains:write` scope; in CI, give the token that scope. A name another account holds answers 409, and without Cloudflare configured on the platform the answer is 503 `RENOX_UNAVAILABLE`. The whole lifecycle: [Tenant lifecycle, custom domains](../05-tenant-lifecycle.md#custom-domains-and-dns).

## Limits to know

Cloudflare sits in front of every app:
- **100 seconds idle.** A response that sends nothing for 100 s is cut (524). Long work belongs in a job, not in a request. SSE routes get a heartbeat every 15 s from the platform.
- **100 MB request body.** A larger upload is refused at the edge before it reaches your app.

Your app's own limits (CPU time per request, memory, database size, egress) depend on the tier: [Limits](../contracts/ops.md).

## If it does not work

| You see | Why, and what to do |
| --- | --- |
| `RENOX_UNAUTHENTICATED` | Run `renox login` again: the token expired (90 days) or was revoked |
| `RENOX_CONFLICT`, "not available", on the first deploy | Someone has that app name: change `name` in `renox.toml` |
| `RENOX_DEPLOY_REJECTED` | Validation failed: the message names the rule (`V…`) and the file. Run `renox check` |
| `RENOX_ACTIVATION_FAILED` | A migration or the probe failed; the previous deployment keeps serving. `renox logs` has the cause |
| `RENOX_TOKEN_SCOPE` on `renox domains add` | The token lacks `domains:write` |
| The domain stays `pending` | The CNAME or a TXT record is missing or wrong; DNS changes can take a while to reach Cloudflare |
| 413 on an upload | The body is over the limit (100 MB at the edge, less on smaller tiers): keep large files out of a single request |

## Building with an AI agent

The platform MCP has `deploy`, `rollback`, `get_logs`, `list_deployments` and `add_domain` for agents, with the scopes of the token you give them ([AI agents and MCP](../20-ai-agents-mcp.md)). Keep a person in the loop for rollbacks, secrets and domains.

## Where next

- Replace `modules/outbox` with the `email` module (`renox add email`, from CLI 0.1.4 it delivers invitations too); add `2fa` (`renox add 2fa`) for owners; add `audit` to record who removed what.
- [Modules](../10-modules.md), [Authorization](../11-authorization.md), [Fragments and realtime](../09-htmx-realtime.md) and [App model](../07-app-model.md) go deeper into what you used here.
- To react to a module's events, fill its hook points or slots, or emit events of your own, the app has `hooks.ts` and `renox.toml [[slots]]` and `[events]`: [App model](../07-app-model.md#events-and-hooks), "Events and hooks", "Slots" and "App events".

**Checkpoint:** [`examples/tutorial/step-10`](../../examples/tutorial/step-10/), the finished app.
