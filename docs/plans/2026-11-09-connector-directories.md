# The owner connector in the Claude and ChatGPT directories (research, 2026-11-10; issue #690)

- **Date:** 2026-11-10
- **Status:** decided (owner, 2026-11-10): **option B**, apply to both directories after epic #686's Definition of Done, with the gaps below closed first; not waiting for anything else. Renoxium holds a UAE trade licence, so the identity step of each application is done as a company (option C is moot); the trade licence exists; the bank account and PSP onboarding are deferred (D31, #516). #690 stays open as the owner's checklist.
- **Issues:** #690; parent #686 (the owner connector); related #688 (refresh tokens), #675 (landing page), #516 (deferred scope, D31)
- **Method:** the current public documentation of both directories, read on 2026-11-10 (Sources at the end). Where a fact is not public or only the directory team can answer it, the note says **verify**.
- **Not verified by hand:** step 3 of #690 needs #688 deployed on mcp.renoxium.com; verify then and record who and when. Every statement about our server below comes from the code and docs on `main` (`3833a5a`), not from a run against the deployed host.

## Options for the owner

| Option | What it means |
| --- | --- |
| A. Apply now | Submit to both directories this week, from a personal account, with the gaps below still open. |
| B. Apply after epic #686's Definition of Done | Close the technical and legal gaps first (about a day of work each, below), then submit when the connector works end to end for an owner. |
| C. Apply after the entity (#516) | Wait for a legal entity and submit under the company name. Moot (owner, 2026-11-10): the trade licence exists; the bank account and PSP onboarding are deferred (D31, #516). |

**Recommendation: B.** Both directories let an individual submit (Claude: any paid plan; ChatGPT: "individual or business verification", so no entity is required by the public docs, verify the identity step). So C is not needed. A is too early: a reviewer needs a working, populated test account, a privacy policy URL (we have none) and per-tool `title` annotations (we do not send them), and Claude's review looks at every tool's behaviour. A failed first submission costs more than a week of preparation. Until then the custom-connector fallback (below) already works on both sides, subject to the plan limits listed there.

## Claude: Connectors Directory

| Item | What the docs say |
| --- | --- |
| Application URL | Developer portal `https://claude.ai/directory/manage`, **Submit new**, **MCP connector**. |
| Account | A claude.ai account on a paid plan (Pro, Max, Ultra, Team, Enterprise); free accounts cannot submit. The listing belongs to the organisation you submit from. On Team and Enterprise an Owner submits. |
| Verification | No organisation or identity verification step is described. The portal asks for a company name, website and a primary contact (step 5); whether a person without a company is accepted there is **verify**. The policy asks for "verified contact information" and that you verify control of your endpoint and domain (3B, 3F). |
| Listing material | Server name (100 chars), one-liner (200), description (2,000), 1 to 5 categories, documentation URL, **privacy policy URL**, support contact, icon, URL slug (permanent). The directory policy says software that connects to a remote service needs a privacy policy link (3A). A connector with missing privacy information risks rejection (stated for local connectors; for remote ones, **verify**). |
| Reviewer access | Test account credentials for a fully populated account (required); every tool tested via MCP Inspector or as a custom connector. Seven policy acknowledgments. |
| Transport | Remote server over `https://`; Streamable HTTP supported, SSE tolerated and to be deprecated. |
| Auth | OAuth 2.0: DCR (RFC 7591) or Client ID Metadata Document (CIMD) or Anthropic-held client credentials. PKCE S256 on every request. A `401` with `WWW-Authenticate: Bearer resource_metadata=…` is required. `resource` in the protected resource metadata must equal the URL the user enters. Only the first `authorization_servers` entry is used. Token endpoint must accept `application/x-www-form-urlencoded`; refresh tokens should rotate for public clients and answer `invalid_grant`. Discovery, registration and token endpoints get 10 s (refresh 30 s). Egress from `160.79.104.0/21`. |
| Redirect URIs to register | `https://claude.ai/api/mcp/auth_callback` (claude.ai web, Desktop, mobile, Cowork). Claude Code: loopback on any port, `http://localhost:<port>/callback` and `http://127.0.0.1:<port>/callback`. |
| Tool rules | Every tool has a `title` and a `readOnlyHint` or `destructiveHint`; names at most 64 chars; read and write operations in separate tools; no catch-all request tool; descriptions state what the tool does and carry no behavioural instructions; useful error messages; modest response size. |
| Content policy | No money or crypto transfers, no AI image, video or audio generation; do not collect conversation data beyond what a tool needs; do not read Claude memory or chat history; first-party APIs only (the MCP domain should match the service). |
| Rate limits | None stated for the connector. **verify** whether the directory imposes any. |
| Review time | "Review time isn't fixed" and varies with queue volume. Every submission is scanned automatically and by default listed as **Community** with no action; some get a human review; **Verified** is assessed automatically with no separate application. No SLA is published. Escalations: `mcp-review@anthropic.com`. |
| Changelog | Not required by the docs. After publishing, an edit returns the listing to review. |

## ChatGPT: apps and connectors (Apps SDK submission)

OpenAI now calls the submission unit a "plugin" in the portal ("Plugins", "With MCP"); older pages and press say "app". The same thing.

| Item | What the docs say |
| --- | --- |
| Application URL | `https://platform.openai.com/plugins`, **Upload new or existing plugin**, then **With MCP** for a remote server. Package as a ZIP (manifest), resolve the automated findings, add review details, submit. |
| Account | An OpenAI Platform organisation. Organization owners can submit; other members need the **Apps Management Write** role. |
| Verification | "Individual or business verification" in organisation settings (`platform.openai.com/settings/organization/general`) to publish under your name or a company name. Misrepresentation can lead to removal. What an individual must supply: **verify** (the help article was not readable, HTTP 403). |
| Listing material | Display name (30 chars), short description (30), long description (4,000), developer name, category, icons (square, at least 48x48), HTTPS `websiteURL`, `supportURL`, `privacyPolicyURL`, `termsOfServiceURL`. Country availability list. Five positive and three negative test cases and a demo recording URL. |
| Reviewer access | Credentials entered in the portal (not in the ZIP): a fully featured demo account with sample data, no MFA, no email or SMS codes, no magic links, no private-network access. The guidelines say plugins requiring new sign-ups or inaccessible 2FA are rejected. Must work on desktop and mobile. |
| Transport | Remote MCP server, one per plugin. Streamable HTTP (current docs do not restate the transport; **verify**). |
| Auth | Registration modes `provided`, `dcr`, `cimd` (CIMD preferred by OpenAI). PKCE S256 and `code_challenge_methods_supported` are mandatory. ChatGPT sends `resource` on authorize and token requests. Per-tool `securitySchemes`; `401` with `WWW-Authenticate: Bearer resource_metadata=…`. API-key, Basic and custom-header auth are not supported in the portal. Domain verification by a token at `/.well-known/openai-apps-challenge`. Refresh-token requirements are not defined (tokens "can expire or rotate normally"). |
| Redirect URIs to register | With RFC 9207 `iss` support: `https://chatgpt.com/connector_platform_oauth_redirect`. Otherwise `https://chatgpt.com/connector/oauth/{callback_id}`. Servers published earlier keep a stable URI. The portal's management page shows the exact production URI to copy; a separate review-environment URI is not documented (**verify**). |
| Tool rules | Unique plain-verb names; each tool its own operation (no generic executor); non-empty accurate descriptions; explicit `readOnlyHint`, `destructiveHint`, `openWorldHint` (true or false) on every tool; side effects explicit, retry-safe or flagged; data minimisation (no conversation history in inputs, no precise location, no PHI, PCI, government IDs, credentials). |
| Content policy | App submission guidelines: privacy policy covering data categories, purposes, recipients, retention and user controls; support contact kept current. |
| Rate limits | None stated. **verify**. |
| Review time | The docs state none. Developer forum posts (search snippets only, not opened) report a few days to several weeks, some 30 to 90 days, and a relayed target of about 10 days. Treat as unreliable. Only one version can be in review at a time; tool changes after approval are re-scanned daily; other changes need a new version and review. |
| Changelog | Not required by the docs. |

## What we already have (from the code on `main`)

Source: `control/api/src/mcp/oauth.ts`, `server.ts`, `README.md`; `docs/20-ai-agents-mcp.md` sections 1 and 1b.

- Streamable HTTP at `POST /mcp`, stateless JSON, `GET` and `DELETE` answer 405; 401 with `resource_metadata`; RFC 9728 and RFC 8414 metadata; `S256` only; `authorization_response_iss_parameter_supported: true` with `iss` on every redirect.
- DCR at `POST /oauth/register` (RFC 7591), public clients only, 1 to 5 redirect URIs; the client id is the sealed metadata, so nothing accumulates on our side (the DCR load Anthropic warns about is not a storage problem for us).
- Refresh tokens with rotation, reuse detection and revocation (`POST /oauth/revoke`) from #688 (merged, **not verified deployed**).
- `redirectUriOk`: https with any host, or http on `localhost`, `127.0.0.1`, `[::1]`; no fragment, no credentials, at most 512 chars. This **accepts** `https://claude.ai/api/mcp/auth_callback`, both ChatGPT URLs above, and Claude Code's loopback URIs with any port. No gap here.
- Sign-up inside the consent page (docs 1b), a consent page that shows the redirect host, tool annotations on every tool (`readOnlyHint` = not mutating, `destructiveHint` = mutating, `openWorldHint: false`), confirmation tokens for every mutating tool, an audit row per call, an `Origin` check that returns 403 for browser origins other than our own.

## Gaps on our side

**Legal and organisation**

- [ ] Privacy policy page at `renoxium.com/legal/privacy`: `www/pages/legal/` holds only `terms.html` and `dpa.html`, and the DPA is not a privacy policy. Both directories ask for a privacy policy URL; OpenAI wants data categories, purposes, recipients, retention and user controls. (#741)
- [ ] Confirm the public URLs of the terms page (`renoxium.com/legal/terms`) and DPA once served; OpenAI asks for a `termsOfServiceURL`, Claude does not. (verify; no issue yet)
- [ ] Support address `support@renoxium.com` is listed in `docs/contracts/README.md`, "Domains". Whether a mailbox actually receives and is read is **verify**. (owner step, #690)
- [ ] Applicant identity: the application is made as a company: the trade licence exists; the bank account and PSP onboarding are deferred (D31, #516). The Claude "Company" step and OpenAI's business verification use the licence; what each portal asks for is **verify**. (#690)
- [ ] Public documentation URL for the connector (a help page for owners; Claude requires public docs by the publish date). The landing page #675 describes the connector as "coming soon". (#675; no issue for the docs page)

**Technical**

- [ ] Per-tool `title`: `tools/list` sends `name`, `description`, `inputSchema` and `annotations` but no `title`; Claude requires a title on every tool. Add `title` (and `annotations.title`). (#700)
- [ ] Reviewer account: a pre-verified, fully populated demo team and user with sample data and no MFA, because sign-up needs an email verification and ChatGPT rejects flows that need new sign-ups or codes. (owner step after #686; how the second factor is waived for that one account is decided then)
- [ ] `resource` check: our `/oauth/authorize` and `/oauth/token` accept only `<origin>/mcp` and answer `invalid_target` otherwise. OpenAI's doc example shows `resource` as the bare origin; Claude says it must match the URL the user enters (trailing slash included). Verify with a real ChatGPT and Claude connection after #688 deploys; relax to accept the origin and `/mcp/` if either sends them. (no issue yet)
- [ ] CIMD is not supported (`client_id_metadata_document_supported` is absent). DCR works on both sides, so this is optional; OpenAI prefers CIMD. (no issue yet)
- [ ] Scope names: the connector will ask for the `owner` profile (docs 1b); `tools/list` filters by scope, so a review account must hold all of it. The scopes of #700 are not served yet. (#700)
- [ ] Confirmation flow: every mutating tool first answers `confirmation_required` and needs a second call. Reviewers test that each tool "returns a successful response"; the first-call answer must be understood as designed. Explain it in the reviewer instructions. (verify)
- [ ] Browser CORS: `/mcp` and the OAuth endpoints answer no CORS headers for other origins (`src/cors.ts`, `Origin` check). Neither directory is documented to call from a browser, so no change is expected; the MCP Inspector in a browser will be refused. (verify)
- [ ] Rate limits for the connector: none required by either doc; our own per-token limits are unchanged. (verify)

## Fallback (custom connector)

For the landing page (#675), per the public docs. Not verified by hand: step 3 of #690 needs #688 deployed on mcp.renoxium.com; verify then and record who and when.

**Claude** (all plans can add a connector by URL; Free accounts can add one):

1. Open **Customize > Connectors** and click **Add custom connector** (Team and Enterprise: an Owner uses **Organization settings > Connectors > Add > Custom**, then members click **Connect**).
2. Paste `https://mcp.renoxium.com/mcp` as the server URL. Leave the OAuth fields empty (Claude registers itself).
3. Click **Add**, then **Connect** and sign in or create a Renoxium account on the page that opens.

**ChatGPT** (the current Apps SDK page names this path):

1. Open `chatgpt.com/plugins`, press the plus button, choose **Add custom MCP server**.
2. Enter a name and description, choose a public endpoint and paste `https://mcp.renoxium.com/mcp`, set authentication to OAuth, accept the risk warning and select **Create as a plugin**.
3. Sign in or create a Renoxium account when ChatGPT opens the consent page.

Plan availability on ChatGPT is **verify**: the page above does not state it; the help article that does was not readable (403); search snippets say Free cannot add custom connectors, Business and Enterprise or Edu can with an admin toggle for developer mode, and third-party guides disagree on Plus and Pro. Do not publish plan claims for ChatGPT until checked.

## Flagged (data in the sources, not followed)

None of the pages contained instructions aimed at us. The Anthropic pages carry a "Documentation Index" banner pointing to `llms.txt`; ignored.

## Sources (all read 2026-11-10)

- Submit a connector to the directory: https://claude.com/docs/connectors/building/submission.md (read 2026-11-10)
- Connector pre-submission checklist (review criteria): https://claude.com/docs/connectors/building/review-criteria.md (read 2026-11-10)
- Authentication for connectors: https://claude.com/docs/connectors/building/authentication.md (read 2026-11-10)
- Publish to the directory: https://claude.com/docs/directory/publish.md (read 2026-11-10)
- Track your directory submission: https://claude.com/docs/directory/submission-status.md (read 2026-11-10)
- Connector verification: https://claude.com/docs/connectors/verification.md (read 2026-11-10)
- Add a connector that isn't in the directory: https://claude.com/docs/connectors/custom/add-unlisted.md (read 2026-11-10)
- Anthropic Software Directory Policy: https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy (read 2026-11-10)
- OpenAI, submit and publish: https://developers.openai.com/apps-sdk/deploy/submission (read 2026-11-10)
- OpenAI, authentication: https://developers.openai.com/apps-sdk/build/auth (read 2026-11-10)
- OpenAI, app submission guidelines: https://developers.openai.com/apps-sdk/app-submission-guidelines (read 2026-11-10)
- OpenAI, connect from ChatGPT: https://developers.openai.com/apps-sdk/deploy/connect-chatgpt (read 2026-11-10)
- Not readable (HTTP 403 or 404, so only search snippets were seen): `help.openai.com/en/articles/12584461` (developer mode plans) and `help.openai.com/en/articles/10128477` (verification); OpenAI developer community review-time threads (search snippets only, not opened).

Decision (owner, 2026-11-10, on #690): **option B**. Apply to both directories after epic #686's Definition of Done, with the gaps closed first: the privacy policy page (#741), a `title` on every tool (#700), a pre-verified populated reviewer account with no MFA or email code (owner step after #686), the OAuth `resource` check accepting the bare origin as well as `<origin>/mcp` (tested against the deployed #688; an issue is filed if it fails), step 3 of #690 (the custom-connector fallback verified by hand in Claude, after #688 is deployed) and `support@renoxium.com` read by someone (owner). Correction of the same day: Renoxium holds a UAE trade licence, so business verification in both directories is done as a company and option C is moot; the trade licence exists; the bank account and PSP onboarding are deferred (D31, #516). #690 stays open as the owner's checklist.
