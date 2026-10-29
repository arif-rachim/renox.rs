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
mcp.renox.dev        # remote, Streamable HTTP + OAuth 2.1; for cloud agents
```

### Tools

All results are structured JSON with the same error shapes as the CLI (`file`, `line`, `code`, `hint`), so an agent can fix problems without parsing prose.

| Group | Tools | Notes |
| --- | --- | --- |
| Apps and deploys | `list_apps`, `create_app`, `deploy`, `rollback`, `get_deployment`, `list_deployments` | `deploy` returns the validation report (templates, policies, routes, permissions) |
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
- Every call is audit-logged with actor type `agent`, the client name, and the model if reported.
- Tokens are short-lived; the local server inherits the developer's CLI login.

## 2. App MCP: every tenant application can be an MCP server

Tenants do not write MCP servers. They declare tools, and the platform exposes `/mcp` for the app with authentication, authorization, rate limiting, and metering already applied.

```ts
// functions/tools/create-invoice.ts
import { tool } from "renox";
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
| Confirmation | Tools marked `confirm: true` (payments, refunds, deletes) return a preview; the agent must send a confirmation token to execute |
| Discovery | `/.well-known/oauth-authorization-server` and tool descriptions are served so general-purpose agents can find and connect to the app |
| Transport | Streamable HTTP on `/mcp`; SSE for server-initiated notifications (job finished, new message) |

Tool inputs are validated by the declared schema before `run`; outputs are serialized with a size cap and labeled as application data.

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
| Attribution | Audit log distinguishes human and agent actors with client name and model; tenants can list and revoke agent tokens in the dashboard |
| Data exfiltration via tools | Output size caps; resources are policy-filtered; `db_export` requires a dedicated scope |

## 6. Build phases

| Part | Phase | Reason |
| --- | --- | --- |
| Local `renox mcp` (dev_status, dev_errors, run_check, run_tests, docs resources) | F2–F3 | Cheap, and immediately speeds up our own agent-assisted development of Renox |
| Remote control-plane MCP with OAuth and scopes | F3–F4 | Needs the control plane and the token system |
| App MCP (`functions/tools/`, module tools, `/mcp` per app) | F5 | Needs Cedar and the `auth` module acting as OAuth server |
| `ctx.ai`, AI gateway, durable agent jobs | F7 | Needs mature metering and billing |

Components are tracked as P21 (platform MCP) and P22 (app MCP + `ctx.ai`) in `18-build-plan.md`.
