# Remote platform MCP (#62)

The control API serves the platform MCP of `docs/20-ai-agents-mcp.md` (section 1, "remote"; section 5, agent security) to cloud agents: the same team operations the CLI has, behind OAuth 2.1. `mcp.renox.dev` is a hostname for this API; the issuer and the resource are the origin a client used (`<origin>`, `<origin>/mcp`).

| File | What it holds |
| --- | --- |
| `oauth.ts` | Protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration (RFC 7591), the consent page, the token endpoint (authorization code + PKCE S256) |
| `server.ts` | `POST /mcp` (Streamable HTTP, stateless JSON answers), the tools, per-tool scopes, confirmation tokens, the audit row of each call |
| `seal.ts` | AES-256-GCM sealing with a key derived (HKDF) from `CONTROL_MASTER_KEY`; without a master key the OAuth endpoints answer 503 |

## Flow

1. A client calls `/mcp` without a token and gets 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`. It reads that file, then `/.well-known/oauth-authorization-server`.
2. `POST /oauth/register`: public clients only (`token_endpoint_auth_method: none`), 1–5 redirect URIs, https or http on `localhost`/`127.0.0.1`/`[::1]`, no fragment. The client id is the sealed metadata (`rnxmcp_…`); nothing is stored.
3. `GET /oauth/authorize` needs a signed-in dashboard session in the browser (`__Host-renox_session`). Without one it shows a sign-in page. An unknown client or a redirect URI the client did not register gets an error page, never a redirect. PKCE S256 is required, and `resource`, if sent, must be `<origin>/mcp`. The page lists the scopes the user's role allows, out of those asked for. It runs no script and cannot be framed.
4. `POST /oauth/authorize` (Allow/Deny). The form carries the sealed request, which is bound to the session that saw the page and expires after 10 minutes. On Allow, a tenant token named `mcp: <client name>` is created for the user, so it holds at most their role. That token is not usable until its code is exchanged: its `expires_at` is set 60 s ahead. The code (`rnxcode_…`) seals the token and the PKCE challenge.
5. `POST /oauth/token` checks the client, `redirect_uri`, the PKCE verifier and `resource`. It then extends the token to one hour with a compare-and-set on `expires_at`, so a code works once. A second exchange revokes the token (OAuth 2.1, 4.1.3). There are no refresh tokens: the client signs in again after an hour.

The access token is an ordinary `renox_pat_` row, so `renox tokens list` and the dashboard show it and can revoke it. `/mcp` accepts only tokens named `mcp: …`. The token API cannot create such a name, because `CreateTokenRequest.name` has no `:`. Other deploy-API tokens get 401 on `/mcp`.

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
| `get_usage` | `apps:read` | — | `GET …/usage` |

Each tool runs as an internal request to the deploy API with the agent's token. The token's scopes, the user's current role, the tenant scoping and IDOR rules of #113, and the deploy API's own audit row all apply unchanged. `tools/list` shows only the tools the token's scopes allow. A call to any other tool gets `insufficient_scope`.

**Confirmation.** The first call to a mutating tool does nothing. It returns `confirmation_required`, a plan in words, and a `confirmation_token` (`rnxconf_…`). The token is bound to the access token, the tool and its exact arguments, and expires after 5 minutes. A second call with the token runs the tool, once: the spent set is per API process, and the token expires anyway. The plan is meant for the human, and the server's `instructions` tell the agent to show it.

**Audit.** Every `tools/call` writes one row: actor `agent:token:<id>`, action `mcp.<tool>`, target `{ tool, client, app?, hash?, outcome }`, and the status. Outcomes are `ok`, `error`, `invalid_input`, `insufficient_scope`, `confirmation_required`, `confirmation_invalid`, `confirmation_reused` and `unknown_tool`. Consent decisions (`mcpAuthorize`) and code exchanges (`mcpToken`, including `code_reused`) are audited too. No row holds a token, a code or a value.

**Transport.** `POST /mcp` takes one JSON-RPC message and answers JSON. Notifications get 202. `GET` and `DELETE` get 405, because there is no server stream and no session. A request with an `Origin` other than the API's own gets 403 (DNS rebinding). Supported protocol versions are `2025-11-25`, `2025-06-18` and `2025-03-26`.

Not in F3: `deploy` from an agent (an upload needs the artifact; agents call `renox deploy` through the local MCP or CLI), refresh tokens, `db_*` and module tools (F4), and elicitation-based confirmation.

Open: the issuer and resource come from the request's origin (`c.req.url`). That is correct when clients reach the API directly, as `control/api` is today (`src/auth/ip.ts`). Behind a TLS terminator that rewrites the scheme or the host, the public origin needs a configuration value (`src/config.ts`, not part of #62).
