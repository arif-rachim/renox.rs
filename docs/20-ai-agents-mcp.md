# 20 — AI agents and MCP

AI agents touch Renox at three points, each with its own mechanism and trust boundary. The Model Context Protocol (MCP) is the integration surface for the first two; the third is tenant code calling model providers.

| Entry point | Who the agent is | Talks to | Example |
| --- | --- | --- | --- |
| 1. Platform MCP | A developer's Claude Code / Cursor / Codex | The Renox control plane and the local dev server | "Deploy this app, show the last errors, why was this refund denied?" |
| 2. App MCP | An end user's agent (Claude, ChatGPT, a custom agent) | A tenant application | "Create an invoice for PT Maju, check stock for shoe size 42" |
| 3. In-app agents | Tenant code | Model providers (Anthropic, OpenAI, local) | A support chatbot in a shop, report summaries |

A fourth, non-protocol surface is the repository itself: `AGENTS.md`, `docs/`, and agent-friendly CLI output.

## 1. Platform MCP: Renox as an MCP server for developers

```
renox mcp            # local, stdio transport; for Claude Code, Cursor, Codex
mcp.renoxium.com     # remote, Streamable HTTP + OAuth 2.1; for cloud agents
```

### Tools

All results are structured JSON with the same error shapes as the CLI (`file`, `line`, `code`, `hint`), so an agent can fix problems without parsing prose.

| Group | Tools | Notes |
| --- | --- | --- |
| Apps and deploys | `list_apps`, `create_app`, `deploy`, `rollback`, `get_deployment`, `list_deployments` | `deploy` returns the validation report (templates, policies, routes, permissions) |
| Domains | `list_domains`, `domain_status`, `add_domain` (`domains:write` + confirmation), `remove_domain` | `add_domain` returns the CNAME target and the two TXT records to create (#477) |
| Observability | `get_logs(filter, since, limit)`, `get_metrics(range)`, `get_trace(request_id)` | Logs are truncated and secret-redacted |
| Data | `db_schema`, `db_query(sql)` (read-only by default), `db_execute(sql)` (write scope + confirmation), `db_export` | Same authorizer; row and time limits |
| Modules | `search_registry`, `add_module`, `module_permissions_diff`, `upgrade_module`, `list_module_contracts` | Permission diffs are returned to the agent, never auto-approved |
| Security | `authz_explain(user, action, resource)`, `security_check` | JSON form of `renox check --security` |
| Local dev | `dev_status`, `dev_errors`, `run_check`, `run_tests`, `generate_types` | The agent sees the same error overlay a human sees in the browser |
| Docs | `search_docs(query)` | Full-text search over this documentation and module READMEs |
| Authorization (local, #294) | `authz_explain(user, action, resource?, roles?)`, `list_policies` | Read-only. The deciding policies with their text; the merged set's files, actions, entities and default roles |
| App MCP (local, #294) | `list_tools`, `list_agent_tokens`, `revoke_agent_token(id, confirm)` | The app's tools from a build; the dev app's agent tokens. Revoking is destructive: `confirm` repeats the id |

### Resources

`docs://` (this documentation), `config://effective` (resolved `renox.toml`), `routes://`, `schema://db`, `types://generated`, `modules://permissions`, `module://<name>/readme`.

### Prompts

Task templates with the right context preloaded: `add-module`, `debug-failing-deploy`, `write-migration`, `explain-denied-action`, `optimize-slow-route`.

### Security of the platform MCP

- OAuth 2.1 tokens with **per-tool scopes**: `apps:read`, `apps:write`, `deploy:write`, `logs:read`, `db:read`, `db:write`, `modules:write`, `secrets:none` (secrets are never readable through MCP; only names and versions). Default grant for an agent: read scopes + `deploy:write`.
- Destructive tools (`rollback`, `db_execute`, `delete_app`, `upgrade_module`) return a **plan plus a confirmation token**; execution requires a second call with that token. In the local stdio server, the confirmation is shown to the human in the terminal.
- Every call is audit-logged with actor type `agent`, the client name, and the model if reported (the platform MCP: `control/api/src/mcp/server.ts`, one `audit` row per call, whatever the outcome; the App MCP: the `mcp.tool_called` event and the `audit` module row, section 2, "Attribution", #658).
- Tokens are short-lived; the local server inherits the developer's CLI login.

## 1b. The owner connector (#686, #687)

The platform MCP of section 1, served to a **business owner** instead of a developer: the owner adds one connector (`https://mcp.renoxium.com/mcp`) to ChatGPT or Claude, signs in or signs up inside the consent page, and asks in plain words for an app built from a finished template, their own web address, and **settings-level** changes (name, colours, logo, branches, services, people, the texts the app exposes as settings). It is the same server as section 1 (`control/api/src/mcp/`), with a grant profile, more tools and a bridge into the app's own MCP (section 2). Code-level changes ("add a warranty line to the PDF") need a hosted workspace that edits, checks and deploys the app's code; they are a follow-up epic and stay out of this section.

### What each promise of the landing page maps to

The four promises of the landing page (#675, section 3):

| Promise | Fulfilled by | Not in this contract |
| --- | --- | --- |
| "Build me the app for my business." | `create_app_from_template` (template `home-services`, with the company, branches, services and people); `get_app_summary` to read back what was set up | Templates other than the ones `TEMPLATES` lists |
| "Put it on my web address." | `add_domain` and `domain_status` (section 1, #477): the one CNAME record plus the two TXT records, and the state until the certificate is issued | Buying the address; DNS changes at the registrar (the owner adds the records) |
| "Give my team email at my address." | Nothing yet. `invite_people` gives the team **accounts in the app**, at the addresses they already have; it creates no mailbox | Mailboxes through a mail partner: out of scope until the partner is decided (#692); its tool joins the table below then |
| "Change this." | `update_settings`, `upload_logo`, `list_branches` / `add_branch` / `update_branch`, `list_services` / `add_service` / `update_service`, `invite_people` | Pages, steps, wording outside the settings, reports and PDFs: the code-change follow-up epic; until it ships, done with us on WhatsApp (the landing page's "Change this" status line) |

### Grant profile and consent texts

A connector asks for the profile with `scope=owner` (or lists the scopes); the consent page shows each scope in plain words and only those the user's team role allows (section 1, "Security of the platform MCP"):

| Scope | Consent text | Tools |
| --- | --- | --- |
| `apps:read` | "See your apps and what they contain" | `list_apps`, `get_app`, `get_app_summary`, `list_branches`, `list_services`, `domain_status`, `list_domains` |
| `apps:write` | "Create and change your apps" | `create_app_from_template` |
| `domains:write` | "Add your domains" | `add_domain` |
| `app:settings` | "Change your app's settings" | `update_settings`, `upload_logo`, `add_branch`, `update_branch`, `add_service`, `update_service` |
| `app:people` | "Invite people" | `invite_people` |

`owner` expands to `apps:read apps:write domains:write app:settings app:people`. `app:settings` and `app:people` are deploy-API token scopes (`deploy-api.md` 0.9 section 2), held by the roles `owner` and `admin` and narrowable with `:<app>` like the others. `secrets:*`, `tokens:write`, `deploy` and `apps:delete` are never part of the profile; a connector that asks for them in `scope` gets the consent page without them.

### Tools

Every tool's output is JSON and carries `untrusted: true` when it contains text the app or its users wrote (names, settings, branch and service names), so the assistant treats it as data. Every mutating tool follows the existing confirmation mechanism (`control/api/src/mcp/README.md`, "Confirmation"): the first call does nothing and answers `confirmation_required` with a **plan in plain English** naming what will change, and a `confirmation_token`; the second call with the token runs it once. Inputs are JSON Schema 2020-12 with `additionalProperties: false`; strings are trimmed; `app` is an app name (`deploy-api.md` section 1).

| Tool | Input | Output | Scope | Confirmation and plan | Reaches |
| --- | --- | --- | --- | --- | --- |
| `create_app_from_template` | `{ name: AppName, template: "home-services", setup: Setup }` | `{ app, url, hash, invitations: [{ email, role }] }` | `apps:write` | yes: "CoolAir: 2 branches (Dubai, Sharjah), 5 services, 3 people invited, live at coolair.renoxium.app" | `POST /v1/apps/from-template` with `setup` (`deploy-api.md` 0.9 section 21, #689) |
| `add_domain` | `{ app, hostname }` | the domain with its CNAME target and TXT records | `domains:write` | yes (exists) | `POST …/domains` |
| `domain_status` | `{ app, hostname }` | state, `ssl_status`, the records still to create | `apps:read` | — (exists) | `GET …/domains/{hostname}` |
| `get_app_summary` | `{ app }` | `{ app, url, brand_name, brand_color, logo: bool, branches: [{ name, emirate }], services_count, people: [{ email, role, status }], domains: [hostname] }` and a `summary` sentence for the assistant to read back | `apps:read` | — | the bridge: app tools `get_settings`, `list_branches`, `list_services` and `list_people`; `GET …/domains` |
| `invite_people` | `{ app, people: [{ email, role }] }` (1 to 20; `role` one of `owner`, `manager`, `dispatcher`, `technician`, `accountant`) | `{ invited: [{ email, role }], skipped: [{ email, reason }] }` | `app:people` | yes: "Invite 3 people to CoolAir: a@…, b@… (technician), c@… (accountant). Each gets an email." | the bridge: `org.invite_member`, one call per person |
| `update_settings` | `{ app, settings: { brand_name?: 1–80, brand_color?: "#RRGGBB", sender_name?: 1–80, accounts_email?: email, footers?: { invoice?: 0–500, quote?: 0–500, job_card?: 0–500 } } }` (at least one key) | the settings after the change | `app:settings` | yes: each changed key as "brand colour: #0A7 → #E40" | the bridge: app tool `update_settings` |
| `upload_logo` | `{ app, image: base64, content_type: "image/png" \| "image/jpeg" \| "image/svg+xml" }`, at most 512 KiB decoded | `{ logo_url }` | `app:settings` | yes: "Replace CoolAir's logo with the 48 KB PNG you sent" | the bridge: app tool `upload_logo` (the `storage` module) |
| `list_branches` | `{ app }` | `{ branches: [{ id, name, emirate }] }` | `apps:read` | — | the bridge: app tool `list_branches` |
| `add_branch` | `{ app, branch: { name: 1–80, emirate } }` | the branch | `app:settings` | yes | the bridge: app tool `add_branch` (an `org` organisation) |
| `update_branch` | `{ app, id, branch: { name?, emirate? } }` | the branch | `app:settings` | yes | the bridge: app tool `update_branch` |
| `list_services` | `{ app }` | `{ services: [{ id, name, price_aed, active }] }` | `apps:read` | — | the bridge: app tool `list_services` |
| `add_service` | `{ app, service: { name: 1–80, price_aed: 0–1,000,000 } }` | the service | `app:settings` | yes | the bridge: app tool `add_service` |
| `update_service` | `{ app, id, service: { name?, price_aed?, active? } }` | the service | `app:settings` | yes: "Price of AC service: 150 AED → 180 AED" | the bridge: app tool `update_service` |

`Setup` is the object of `deploy-api.md` 0.9 section 21: `{ company: { name: 1–80, trn?: 15 digits, phone: E.164, emirate }, branches: [{ name, emirate }] (1 to 5), services: [{ name, price_aed }] (1 to 50), people: [{ email, role }] (0 to 20) }`, `emirate` one of `abu_dhabi`, `dubai`, `sharjah`, `ajman`, `umm_al_quwain`, `ras_al_khaimah`, `fujairah`. The signed-in owner becomes the app's first user with the role `owner` (their platform account's verified email); `people` are invited on top.

The app tools named "app tool" above are tools the **template** declares under `functions/tools/` (the home-services template: `get_settings`, `update_settings`, `upload_logo`, `list_branches`, `add_branch`, `update_branch`, `list_services`, `add_service`, `update_service`, `list_people`), each with the Cedar action its admin page already uses, so the app's own policies decide, not the platform. `org.invite_member` is the `org` module's tool (`modules/org/module.toml`). A template that does not declare a tool makes the platform tool answer the tool error `not supported by this app's template`, never a fallback.

### The bridge: how a platform call reaches the app

**Decision: the platform mints a short-lived agent token for the owner's user in the app, through the owning node, and calls the app's own `/mcp` with it** (option (a) of #687). The other option, an owner assertion signed with the platform key that the cell verifies (option (b)), was not chosen: it adds a second way to authenticate into a cell's `/mcp` that bypasses the `auth` module's token table, its revocation list and its consent records, and the platform key would then sign authority over every app of the node. Option (a) adds one operation and no new trust path into the app: the app sees an ordinary agent token of its own `auth` module.

One bridged call, in order:

1. The platform MCP checks the connector's access token, its scope for the tool, and that `app` is an app of the token's tenant (the #113 tenant scoping; another tenant's app is 404, as for every tool).
2. It asks the owning node to mint a token: `nodeMintAgentToken` (`deploy-api.md` 0.9 section 15), `POST /nodes/{node_id}/tenants/{tenant_id}/apps/{app}/agent-tokens` on the node listener, with `{ email, scopes: ["tools:<name>", …], ttl_seconds ≤ 300, client_name: "Renoxium connector", grant_id }`. `email` is the platform account's **verified** email of the signed-in user, never an argument of the tool; `scopes` are exactly the app tools the platform tool needs; `grant_id` is the connector's access-token id (for the app's audit row).
3. The node runs the app's `auth` service `mintAgentToken` in the app's cell: it looks up the app user with that email (`email_verified` true, not disabled), inserts an `auth__agent_tokens` row (client `renoxium-platform`, the given scopes, `expires_at` ≤ 5 minutes ahead) and answers the token (`renox_agt_…`). No such user → 404 `RENOX_NOT_FOUND` (`details: [{ field: "email", reason: "not_an_app_user" }]`), and the platform tool answers "Your account is not a user of this app" without retrying.
4. The platform calls `POST https://<app>.<platform domain>/mcp` (`tools/call`) with that token, exactly as an outside agent would. The cell's seven steps of section 2 apply unchanged: the token check, the token's scopes, the per-token rate limit, the input schema, the app's own `confirm` tools (a preview, then the real call with the app's confirmation token), the **Cedar action as the owner's app user**, the output cap and `untrusted`.
5. The platform keeps the minted token in memory only, per (access token, app, scopes), until 30 s before it expires, so the confirmation round of one tool uses the same app token; it is never written to the database, a log line, an audit row or a tool result, and the connector never sees it.

Security argument against `docs/24-threat-model.md`:

- **At most the owner's role.** The app token is a token of the app's `auth` for the app user with the owner's verified email; what it may do is what the app's policies allow that user (section 2, "What an agent token may do"). The platform adds nothing: a platform role does not become an app role. A team member of the tenant who is not that app's user cannot reach it through the bridge.
- **Never across tenants.** Step 1 resolves the app inside the token's tenant; step 2 names the tenant in the node path, and the node mints only in a cell of that tenant's app (another tenant's app on the same node is 404). The node listener is reachable only from the control plane's private network with the callback token (section 15).
- **Bound and short-lived.** The token is bound to one app (its own `auth__agent_tokens` table) and one user, carries only the scopes of the tool, and expires within 5 minutes; the app's own revocation (`auth.revokeAgentToken`, the user's connected agents list) applies. Revoking the connector's access token on the platform stops new mints at once; an app token already minted lives out its ≤ 5 minutes, during which only that tool's scopes work.
- **Audited on both sides.** The platform row `mcp.<tool>` (section 1) and the app's `mcp.tool_called` event and `audit__events` row (section 2, "Attribution") with the client `Renoxium connector` and the `grant_id` (the event payload carries it as `grant_id` and the row keeps it in `details`, #748; `ops.md` section 15.4).

**Known limit (#748): a tenant in its own process.** `nodeMintAgentToken` answers 404 for a tenant placed in its own process: the node listener mints in the cells of its own process only. So the owner connector's app tools are not available to an app that runs in its own process yet; the platform tools of section 1 are unaffected. This is kept as it is, not built: the connector's tool answers "not available" for such an app, and the day it is built is a new decision with its own issue.

### Sign-up inside the consent flow

`GET /oauth/authorize` without a dashboard session shows sign-in **and** "Create an account" on one page. The form posts `POST /v1/account/signup` (`deploy-api.md` section 21: `email`, `password`, `dpa_accepted`, `captcha_token`; the friction rules unchanged: a disposable domain is 400, the per-IP and per-ASN buckets, the CAPTCHA before anything is stored) with `return_to` = the sealed authorization request. On this path the sealed request lives **30 minutes** instead of 10, so the owner has time to open the verification email. The email's link completes `verifyEmail`, which sets the session and redirects to `GET /oauth/authorize?request=<sealed>`; that shows the consent page with the original client and scopes. `return_to` accepts only a sealed request of this API (anything else is ignored and the user lands on the dashboard), so it is no open redirect. The consent decision's audit row `mcpAuthorize` carries `signup: true` when the user was created in the flow. Implemented by #688.

### Sessions: refresh tokens

The code exchange also answers a `refresh_token` (`rnxrt_…`): a sealed reference to a token row of kind `refresh`, bound to the client id and to the access token's row through a `family_id`, valid **30 days** (RFC 6749 section 6). `grant_type=refresh_token` rotates it: the old one is marked used and a new pair is answered (a one-hour access token, a new refresh token in the same family). A refresh token used twice revokes the whole family, the access tokens included (RFC 6819 5.2.2.3, reuse detection). A refresh token of another client or older than 30 days is `invalid_grant`. `DELETE /v1/tokens/{id}` and the dashboard's token list revoke the family of the row; `POST /oauth/revoke` (RFC 7009) accepts an access or refresh token and revokes its family. Audit rows: `mcpRefresh` (`ok`, `rotated`, `reuse_detected`) and `mcpRevoke`. Implemented by #688.

### Audit

One platform audit row per tool call as in section 1 (`mcp.<tool>`, outcome); a bridged call is audited by the app as well (step 4 above). No row on either side holds the minted token, a code or a secret value.

### Implementation issues

The parts this contract names that no issue of #686 builds yet are filed as sub-issues of #686: #698, the bridge (the `auth` service `mintAgentToken`, the node operation `nodeMintAgentToken`, the platform's client and token cache); #699, the home-services template's settings, branches, services and people tools; #700, the platform MCP's owner tools with the scopes `app:settings` and `app:people` and the `owner` profile.

## 2. App MCP: every tenant application can be an MCP server

Tenants do not write MCP servers. They declare tools, and the platform exposes `/mcp` for the app with authentication, authorization, rate limiting, and metering already applied.

```ts
// functions/tools/create-invoice.ts
import { tool } from "@renoxium/sdk";
import { z } from "zod";

export default tool({
  name: "create_invoice",
  description: "Create a draft invoice for a customer",
  input: z.object({
    customerId: z.string(),
    items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })),
  }),
  action: "invoice.create",            // the same Cedar action as the UI button
  confirm: false,
  async run({ input, billing }) {
    return billing.createInvoice(input.customerId, input.items);
  },
});
```

| Concern | Behavior |
| --- | --- |
| Registration | Every file under `functions/tools/` plus tools declared by installed modules (`[[tools]]` in `module.toml`) appear in `tools/list` at `GET /mcp`. The `billing` module ships `create_invoice`, `get_subscription`; `storage` ships `upload_file`; `org` ships `invite_member`; and so on |
| Identity | End users' agents authenticate through OAuth 2.1 provided by the `auth` module (Renox acts as the authorization server). The token carries the user and scopes, so "Alice's agent" can only do what Alice can |
| Authorization | Each tool declares an `action`; Cedar evaluates it with the token's user as principal, exactly like a UI action. No bypass path |
| Resources | Declared public views and read models can be exposed as read-only MCP resources (`resource://billing/invoices/{id}`), filtered by the same policies |
| Limits | Rate limit per token, timeout per tool call, output size cap, and per-call metering billed to the tenant |
| Confirmation | Tools marked `confirm: true` (payments, refunds, deletes) return a preview; the agent must send a confirmation token to execute; a preview that returns an error gets no confirmation |
| Discovery | `/.well-known/oauth-authorization-server` and tool descriptions are served so general-purpose agents can find and connect to the app |
| Transport | Streamable HTTP on `/mcp`; SSE for server-initiated notifications (job finished, new message) |

Tool inputs are validated by the declared schema before `run`; outputs are serialized with a size cap and labeled as application data.

**What an agent token may do (#590).** An agent token authorizes like the user's session, so an app authorizes its tools with the policies it already has for pages. The principal has the same attributes (`email_verified`, `phone_verified`, `created_at`, and what the `auth.principal` hook's fillers add) and the user's role assignments, global and scoped. `org` is the organisation the user picked on the consent page; a user of exactly one organisation gets it without a choice. It holds only while the user is still a member, and tools take no `org` argument. `mfa_verified` is always false for an agent token. The cell caches a verified token for 60 seconds and drops the user's tokens on `authz.roles_changed` and `auth.principal_changed`, so a revoked role or a removed membership applies to the next call.

Status: served by the cell since #285 (`crates/renox-cell/src/mcp/`, README "App MCP"); resources and server-initiated SSE are not served yet.

## 3. In-app agents: tenant code calling models

```ts
const reply = await ctx.ai.chat({
  model: "claude-sonnet-5-5",
  system: "You are the support assistant for this shop.",
  messages,
  tools: [lookupOrder],        // local tools run in the same isolate under the same authz
  maxTokens: 800,
});
```

| Concern | Design |
| --- | --- |
| Outbound access | Through the `fetch` op with the provider host in the allowlist (`api.anthropic.com`, `api.openai.com`, or a local endpoint); API keys in secrets |
| Platform AI gateway (optional) | `ctx.ai` can route through a Renox-managed gateway that holds shared provider keys, meters tokens, enforces per-tenant spend limits, and caches identical requests. Small tenants need no provider account |
| Long-running agent loops | Run as durable jobs (outbox), not inside an HTTP request; progress streamed to the UI via SSE; resumable after restarts |
| Embeddings and semantic search | `sqlite-vec` in the tenant file; the `search` module adds a semantic mode |
| Limits | Tokens per request and per month count toward the tenant quota; wall-clock limits apply per tool call; the watchdog applies to local tool execution |
| Model choice | Default to the latest Claude models; provider is configurable per tenant |

## 4. Agent-friendly repository and CLI

- Every CLI command supports `--json` and `--yes` (non-interactive) and emits structured errors with `file:line`.
- `renox skill` generates skill files for popular agents (`.claude/skills/renox/SKILL.md`, Cursor rules, Codex instructions) containing the routing, template, module, and MCP tool conventions for the current project.
- `renox dev` exposes the error overlay through `dev_errors`, so an agent sees what a human sees in the browser.
- `AGENTS.md` and `docs/` in this repository are the canonical instructions for agents working on the platform itself.

## 5. Agent-specific security

| Risk | Mitigation |
| --- | --- |
| Prompt injection through data (a product name containing "ignore previous instructions") | Tool results from the database, logs, and user content are labeled `untrusted: true` in the MCP payload; SDK documentation requires agents to treat them as data; no tool executes free text as a command |
| Over-privileged agents | Per-tool scopes, read-only defaults, two-step confirmation for destructive tools, short-lived tokens, per-app grants |
| Secret leakage | Secrets are never serialized through MCP; logs and errors are redacted before leaving the cell |
| Quota exhaustion by runaway agents | Rate limits and metering per token; alerts to the tenant owner; automatic token suspension on anomalies |
| Attribution | Audit log distinguishes human and agent actors with client name and model; tenants can list and revoke agent tokens in the dashboard. Every `tools/call` that passed the token check (allowed, forbidden, invalid input, failed, preview, rate limited) emits the platform event `mcp.tool_called` (`ops.md` section 15.4) and writes one `RENOX_TOOL_CALL` line to the tenant log; the `audit` module records it as an `audit__events` row with `actor_kind = agent`, the client, the tool and the outcome. Proof: `every_tool_call_is_audited` in `crates/renox-cell/tests/mcp.rs`; `modules/audit/tests/audit.test.ts` (#658) |
| Data exfiltration via tools | Output size caps; resources are policy-filtered; `db_export` requires a dedicated scope |

## 6. Build phases

| Part | Phase | Reason |
| --- | --- | --- |
| Local `renox mcp` (dev_status, dev_errors, run_check, run_tests, docs resources) | F2–F3 | Cheap, and immediately speeds up our own agent-assisted development of Renox |
| Remote control-plane MCP with OAuth and scopes | F3–F4 | Needs the control plane and the token system |
| App MCP (`functions/tools/`, module tools, `/mcp` per app) | F5 | Needs Cedar and the `auth` module acting as OAuth server |
| `ctx.ai`, AI gateway, durable agent jobs | F7 | Needs mature metering and billing |

Components are tracked as P21 (platform MCP) and P22 (app MCP + `ctx.ai`) in `18-build-plan.md`.
