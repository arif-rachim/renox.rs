# ops/psl — `renox.rs` on the Public Suffix List

Why (`docs/24-threat-model.md` section C, "Shared-domain reputation"): every app is served at `<app>.renox.rs`, and preview hosts at `<app>-<hash>.renox.rs` (`docs/05-tenant-lifecycle.md`, "Custom domains and DNS"). Without a Public Suffix List entry, browsers and reputation services treat all of them as one site, `renox.rs`:

- a tenant page can set a cookie with `Domain=renox.rs` that every other tenant's pages receive (cookie tossing, session fixation);
- Safe Browsing and similar lists can flag the whole domain for one tenant's phishing page, so every tenant goes down with it;
- per-site browser limits (storage quotas, rate limits, `SameSite`'s notion of "same site") lump all tenants together.

With `renox.rs` in the PRIVATE section of the list, each `<app>.renox.rs` is its own registrable domain: browsers refuse `Domain=renox.rs` cookies, and reputation is scoped per subdomain.

`renox.rs` serves tenant apps only. The platform's own services (the site, `dashboard.`, `api.`, `mcp.`, `docs.`) and its mail live on `renoxium.com` (`docs/contracts/README.md`, "Domains"), so a tenant's phishing page can cost `renox.rs` its reputation at worst, never the dashboard's cookies or the company's mail deliverability. The entry is still needed: without it one tenant's page can take every other tenant down with it.

The submission is an owner's task: it needs control of the `renox.rs` DNS zone and a GitHub account that speaks for Renoxium. Track it on #114. Start it as early as possible: the list's review and the browsers' release cycles take months.

## Checklist

1. **Requirements of the list** (<https://github.com/publicsuffix/list/wiki/Guidelines>):
   - [ ] `renox.rs` is registered for more than two years ahead. `.rs` registrars sell multi-year terms; renew it first if not. The list maintainers check, and they remove entries whose domain lapses.
   - [ ] The reason is the security boundary between tenants, not cookies for our own convenience and not getting around Let's Encrypt rate limits. Rate limits are an explicitly rejected reason.
   - [ ] One entry covers both app and preview hosts, because previews live under `renox.rs` too. If previews ever move to their own domain, that domain needs its own entry in the same PR.
   - [ ] Nothing of the platform's own is served under `renox.rs` except the apex's `/.well-known/security.txt` and the CNAME target `edge.renox.rs`, which sets no cookies.
2. **The DNS record.** Create `TXT _psl.renox.rs` = `https://github.com/publicsuffix/list/pull/<number>` as soon as the PR has a number. It must stay in place as long as the entry exists.
3. **The pull request** to `publicsuffix/list`, against `public_suffix_list.dat`, in the PRIVATE section, in alphabetical order of the organisation name:

   ```
   // Renoxium : https://renoxium.com
   // Submitted by <name> <security@renoxium.com>
   renox.rs
   ```

   The PR body uses the list's template: organisation (Renoxium), website (`https://renoxium.com`), a one-paragraph description ("multi-tenant hosting platform; every customer app is served at `<app>.renox.rs`; customers must not be able to set cookies for, or share reputation with, other customers; the platform's own services are on renoxium.com"), the number of subdomains (one per customer app), and the `_psl` record from step 2.
4. **After the PR is opened:** link it in a comment on #114 and in the table below.
5. **After it is merged:** browsers pick it up in their next releases (weeks to months). Keep the interim rules below until the browsers in the support matrix ship it.

## Until the entry is in browsers

The platform behaves as if `renox.rs` were on the list:

| Where | Rule | Proof |
| --- | --- | --- |
| Control API and dashboard | On `renoxium.com`, not under the tenant domain at all. Session cookie `__Host-renox_session`: host-only, `Path=/`, `Secure`, never `Domain` | `control/api/tests/domains-ownership.test.ts`, "the session cookie is host-only" |
| Tenant pages (renox-cell) | Session and CSRF cookies are host-only (no `Domain`) | `crates/renox-cell/src/pages/session.rs` |
| Gateway | Every tenant `Set-Cookie` is rewritten before it reaches the browser (#207): a `Domain=` equal to the request host (leading dot ignored, any case) is kept; any other `Domain=` (the platform apex `renox.rs`, a parent of the host, another tenant's host, a subdomain, an empty value) is removed, so the cookie becomes host-only; a malformed `Set-Cookie` is dropped. The log names the cookie and the removed domain, never the value | `crates/renox-gateway/src/security/cookies.rs`; `crates/renox-gateway/tests/cookies.rs`, `cookies_that_reach_other_tenants_become_host_only` and `custom_domain_may_scope_to_itself_not_its_parent` |
| App names | Reserved words (`www`, `api`, `admin`, `edge`, …) are never app names, and a deleted app's name is quarantined for 90 days for other tenants | `control/api/src/apps/slugs.ts` |

## Status

| Step | State |
| --- | --- |
| Registration more than two years ahead | to check |
| `_psl.renox.rs` TXT record | not created |
| Pull request to `publicsuffix/list` | not opened |
| Merged | — |
