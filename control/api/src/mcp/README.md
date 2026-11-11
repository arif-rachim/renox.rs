# Remote platform MCP (#62)

The control API serves the platform MCP of `docs/20-ai-agents-mcp.md` (section 1, "remote"; section 5, agent security) to cloud agents: the same team operations the CLI has, behind OAuth 2.1. `mcp.renoxium.com` is a hostname for this API (the resource is named "Renoxium platform MCP"); the issuer and the resource are the origin a client used (`<origin>`, `<origin>/mcp`).

| File | What it holds |
| --- | --- |
| `oauth.ts` | Protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration (RFC 7591), the consent page with its sign-up form, the token endpoint (authorization code + PKCE S256, refresh token), revocation (RFC 7009) |
| `return.ts` | The sealed authorization request that a sign-up carries as `return_to`, the public origin, the script-free HTML pages |
| `server.ts` | `POST /mcp` (Streamable HTTP, stateless JSON answers), the tools, per-tool scopes, confirmation tokens, the audit row of each call |
| `seal.ts` | AES-256-GCM sealing with a key derived (HKDF) from `CONTROL_MASTER_KEY`; without a master key the OAuth endpoints answer 503 |
| `bridge.ts` | The owner connector's bridge (#698): `createBridge(deps).callAppTool(agent, app, tool, args)` mints an agent token of the app's own `auth` through the owning node and calls the app's `/mcp` with it |

## Flow

1. A client calls `/mcp` without a token and gets 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`. It reads that file, then `/.well-known/oauth-authorization-server`.
2. `POST /oauth/register`: public clients only (`token_endpoint_auth_method: none`), 1–5 redirect URIs, https or http on `localhost`/`127.0.0.1`/`[::1]`, no fragment. The client id is the sealed metadata (`rnxmcp_…`); nothing is stored.
3. `GET /oauth/authorize` needs a signed-in dashboard session in the browser (`__Host-renox_session`). Without one it shows a sign-in page with a "Create an account" form (step 4). An unknown client or a redirect URI the client did not register gets an error page, never a redirect. PKCE S256 is required, and `resource`, if sent, must be `<origin>/mcp`. The page lists the scopes the user's role allows, out of those asked for. It runs no script and cannot be framed.
4. Without a session, the page also carries a sign-up form (email, password, team id, the DPA checkbox) that posts to `POST /v1/account/signup` with `return_to` = the authorization request sealed (`rnxreq_…`, `seal.ts`, purpose `authreq`) for **30 minutes**. The friction rules of the existing sign-up apply unchanged: a disposable domain is 400, the per-IP and per-ASN buckets, the DPA. The page runs no script, so it cannot show a CAPTCHA widget: when `RENOX_CAPTCHA_SECRET` is set the form is replaced by a link to `<dashboard>/signup?return_to=<sealed request>`, whose sign-up page forwards `return_to` to the same `POST /v1/account/signup`. `return_to` is accepted only when it is a live sealed request of this API; anything else is ignored and the mail carries the dashboard link, so it is no open redirect. The verification email then links to `GET /oauth/verify?token=…&request=…`. That GET only checks that `request` is a live sealed request and shows a page with a "Verify and continue" button, because mail link scanners prefetch GET links and would burn the one-time token. The button posts (same origin) to `POST /oauth/verify`, which completes the verification as `verifyEmail` does (audit row included), sets the session cookie and answers a page that continues (a link and a meta refresh) to `GET /oauth/authorize?request=<sealed>`, which shows the consent page of the original client and scopes. The POST needs no CSRF token: the one-time token from the email is the secret. (The continuation is a page, not a 302: the cookie is `SameSite=Strict`, and a redirect after a click in a mail client is cross-site.) The sealed request is also what a signed-in user can resume. `mcpAuthorize` carries `signup: true` when the user was created after the request was sealed.
5. `POST /oauth/authorize` (Allow/Deny). The form carries the sealed consent request, which is bound to the session that saw the page and expires after 10 minutes. On Allow, a tenant token named `mcp: <client name>` is created for the user, so it holds at most their role. That token is not usable until its code is exchanged: its `expires_at` is set 60 s ahead, and its `family_id` is its own id. The code (`rnxcode_…`) seals the token and the PKCE challenge.
6. `POST /oauth/token` checks the client, `redirect_uri`, the PKCE verifier and `resource`. It then extends the token to one hour with a compare-and-set on `expires_at`, so a code works once. A second exchange revokes the token and its family (OAuth 2.1, 4.1.3). The answer carries `access_token`, `expires_in: 3600` and `refresh_token`.

The access token is an ordinary `renox_pat_` row, so `renox tokens list` and the dashboard show it and can revoke it. `/mcp` accepts only tokens named `mcp: …`. The token API cannot create such a name, because `CreateTokenRequest.name` has no `:`. Other deploy-API tokens get 401 on `/mcp`.

### Refresh tokens

The refresh token (`rnxrt_…`) is a sealed reference (`seal.ts`, purpose `refresh`) to a row of the token table with `kind = 'refresh'`, a 30-day expiry, bound to the client id and to the access token's row through `family_id`. Only its hash is stored. `grant_type=refresh_token` (with `client_id`, optionally `scope`, which may only narrow, and `resource`) validates it, rotates it and answers a new pair: the old refresh token is marked used with a compare-and-set on `used_at` (two concurrent refreshes cannot both succeed), a new one-hour access token and a new refresh token join the same family, and the 30 days start again, so a connection that is used within a month lasts. The scopes are those of the grant limited by the user's role now; a user who left the team gets `invalid_grant`. A refresh token of another client, a forged, expired or revoked one is `invalid_grant`.

**Reuse.** Using a refresh token that was already rotated revokes the whole family, the access tokens included (RFC 6819 5.2.2.3). Two refreshes of the same token racing count as a reuse.

**Revocation.** `DELETE /v1/tokens/{id}` and the dashboard's token list revoke the family of the row; `POST /oauth/revoke` (RFC 7009; form field `token`, optional `client_id`, answers 200 whatever the token was) accepts a refresh token or an access token this server issued and revokes its family. A refresh row is never a bearer token (the deploy API, `/mcp` and the MFA routes look up `kind = 'access'` only) and `GET /v1/tokens` does not list it: the family is shown as its access tokens.

**Audit.** `mcpRefresh` with outcome `ok` (a new access token was issued) and `rotated` (the refresh token was replaced; both rows on a successful refresh) or `reuse_detected`; `mcpRevoke` with the token type. No row holds a token.

## Scopes and tools

Scopes are the #113 token scopes. The MCP offers `apps:read`, `apps:write`, `deploy`, `logs:read` and `secrets:read`, each optionally narrowed with `:<app>`. Without a `scope` parameter the grant is `apps:read logs:read secrets:read deploy`. `secrets:write` and `tokens:write` are never granted to an agent.

| Tool | Scope | Confirmation | Deploy API call |
| --- | --- | --- | --- |
| `list_apps`, `get_app` | `apps:read` | — | `GET /v1/apps`, `GET /v1/apps/{app}` |
| `create_app` | `apps:write` | yes | `POST /v1/apps` |
| `list_deployments`, `get_deployment` | `apps:read` | — | `GET …/deployments[/{hash}]` |
| `activate` | `deploy` | yes | `POST …/activate` |
| `rollback` | `deploy` | yes | `POST …/rollback` |
| `get_logs` | `logs:read` | — | the app check, then the API's log store; the result carries `untrusted: true` |
| `list_secrets` | `secrets:read` | — | `GET …/secrets`: names, times, version; never a value |
| `list_domains`, `domain_status` | `apps:read` | — | `GET …/domains[/{hostname}]`: state, CNAME target and the DNS records still to create |
| `add_domain`, `remove_domain` | `domains:write` | yes | `POST …/domains`, `DELETE …/domains/{hostname}` (#477) |
| `get_usage` | `apps:read` | — | `GET …/usage` |
| `create_app_from_template` — owner connector (#686, #689) | `apps:write` | yes | `POST /v1/apps/from-template` with `setup` (#689); served. The plan names the company, the branches, the services, the people and the URL; the result (`untrusted: true`) is `{ app, url, hash, invitations }`, and when the app's setup failed the tool error `RENOX_SETUP_FAILED` names the live app |
| `get_app_summary`, `list_branches`, `list_services` — owner connector (#686) | `apps:read` | — | the bridge: the app's tools `get_settings`, `list_branches`, `list_services`, `list_people` |
| `update_settings`, `upload_logo`, `add_branch`, `update_branch`, `add_service`, `update_service` — owner connector (#686) | `app:settings` | yes | the bridge: the app tool of the same name |
| `invite_people` — owner connector (#686) | `app:people` | yes | the bridge: `org.invite_member`, one call per person |

The rows marked "owner connector (#686)" are the contract of `docs/20-ai-agents-mcp.md` section 1b (#687); `create_app_from_template` is served (#689); the bridge is built (#698, below); the others are not served yet: #699 (the app tools) and #700 (these tools and the scopes) build them. The scope profile `owner` = `apps:read apps:write domains:write app:settings app:people`.

**The bridge** (section 1b, "The bridge"; `bridge.ts`, #698). `createBridge(deps).callAppTool(agent, app, tool, args, { scopes? })` is how a bridged tool reaches the app, in four steps:

1. It resolves `app` inside the access token's tenant (another tenant's app, or a deleted one, is 404 `RENOX_NOT_FOUND`) and the owning node from the route table. An app with no active deployment, or a node without a listener, is 503 `RENOX_UNAVAILABLE`.
2. It asks the node for a token (`nodeMintAgentToken`, `deploy-api.md` 0.9 section 15). The request carries the signed-in account's **verified** email, never a tool argument: the access token's user, still a member of the team, the token live. It also carries `scopes` (default `["tools:<tool>"]`, only `tools:<name>`, never `tools:*`), `ttl_seconds: 300`, `client_name: "Renoxium connector"` and `grant_id` = the access token's id. The node runs the app's `auth.mintAgentToken` as the platform; tenant code cannot call it. A 404 with `not_an_app_user` becomes the tool error `not_an_app_user`, "Your account is not a user of this app", and is not retried.
3. It calls `POST https://<app>.<platform domain>/mcp` (`tools/call`) with the token, so the app's scopes, rate limit, confirmation and Cedar policies decide as that app user. The answer is `{ ok: true, untrusted: true, result }` or `{ ok: false, untrusted: true, status, error: { code, message, details? } }`; the app's own codes (`RENOX_TOOL_SCOPE`, a confirmation) pass through. A cached token the app answers 401 to (revoked in the app) is dropped and minted once more.
4. It keeps the token in memory only, per (access token hash, app, scopes), until 30 s before its `expires_at`, so the confirmation round of one tool reuses it.

The token is never written to the database, a log line, an audit row or a result: every answer is scrubbed of it (`tests/mcp-bridge.test.ts`, stubbed node and app). The node side is `crates/renox-cell/tests/agent_tokens.rs`, and the `auth` side is `modules/auth/tests/agents.test.ts`. The owner tools of #700 call the bridge. Until then nothing in `server.ts` does.

Each tool runs as an internal request to the deploy API with the agent's token. The token's scopes, the user's current role, the tenant scoping and IDOR rules of #113, and the deploy API's own audit row all apply unchanged. `tools/list` shows only the tools the token's scopes allow. A call to any other tool gets `insufficient_scope`.

**Confirmation.** The first call to a mutating tool does nothing. It returns `confirmation_required`, a plan in words, and a `confirmation_token` (`rnxconf_…`). The token is bound to the access token, the tool and its exact arguments, and expires after 5 minutes. A second call with the token runs the tool, once: the spent set is per API process, and the token expires anyway. The plan is meant for the human, and the server's `instructions` tell the agent to show it.

**Audit.** Every `tools/call` writes one row: actor `agent:token:<id>`, action `mcp.<tool>`, target `{ tool, client, app?, hash?, outcome }`, and the status. Outcomes are `ok`, `error`, `invalid_input`, `insufficient_scope`, `confirmation_required`, `confirmation_invalid`, `confirmation_reused` and `unknown_tool`. Consent decisions (`mcpAuthorize`) code exchanges (`mcpToken`, including `code_reused`), refreshes (`mcpRefresh`) and revocations (`mcpRevoke`) are audited too. No row holds a token, a code or a value.

**Transport.** `POST /mcp` takes one JSON-RPC message and answers JSON. Notifications get 202. `GET` and `DELETE` get 405, because there is no server stream and no session. A request with an `Origin` other than the API's own gets 403 (DNS rebinding). Supported protocol versions are `2025-11-25`, `2025-06-18` and `2025-03-26`.

Not in F3: `deploy` from an agent (an upload needs the artifact; agents call `renox deploy` through the local MCP or CLI), `db_*` and module tools (F4), and elicitation-based confirmation.

**Public origin.** The issuer, the resource (`<origin>/mcp`), the `resource_metadata` of the 401 challenge and the `Origin` check use `CONTROL_MCP_URL` when it is set, and the request's origin (`c.req.url`) otherwise. The request's origin is right when clients reach the API directly. Behind a TLS terminator that hands requests on as plain http, as the single host's Cloudflare Tunnel does (`ops/single-host.md`), it reads `http://…`, so `CONTROL_MCP_URL=https://mcp.renoxium.com` is required there (`tests/mcp.test.ts`, "behind a TLS terminator"). One origin is served: a client that reaches the same API under another host name (`api.renoxium.com/mcp`) gets the configured issuer and must send that `Origin`.
