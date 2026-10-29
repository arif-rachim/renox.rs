# ops/psl — `renox.app` on the Public Suffix List

Why (`docs/24-threat-model.md` section C, "Shared-domain reputation"): every app is served at `<app>.renox.app`, and preview hosts at `<app>-<hash>.renox.app` (`docs/05-tenant-lifecycle.md`, "Custom domains and DNS"). Without a Public Suffix List entry, browsers and reputation services treat all of them as one site, `renox.app`:

- a tenant page can set a cookie with `Domain=renox.app` that every other tenant's pages receive (cookie tossing, session fixation);
- Safe Browsing and similar lists can flag the whole domain for one tenant's phishing page, so every tenant goes down with it;
- per-site browser limits (storage quotas, rate limits, `SameSite`'s notion of "same site") lump all tenants together.

With `renox.app` in the PRIVATE section of the list, each `<app>.renox.app` is its own registrable domain: browsers refuse `Domain=renox.app` cookies, and reputation is scoped per subdomain.

The submission is an owner's task: it needs control of the `renox.app` DNS zone and a GitHub account that speaks for Renox. Track it on #114.

## Checklist

1. **Requirements of the list** (<https://github.com/publicsuffix/list/wiki/Guidelines>):
   - [ ] `renox.app` has more than two years left on its registration. Renew it first if not; the list maintainers check, and they remove entries whose domain lapses.
   - [ ] The reason is the security boundary between tenants, not cookies for our own convenience and not getting around Let's Encrypt rate limits. Rate limits are an explicitly rejected reason.
   - [ ] One entry covers both app and preview hosts, because previews live under `renox.app` too. If previews ever move to their own domain (for example `renox-preview.app`), that domain needs its own entry in the same PR.
2. **The DNS record.** Create `TXT _psl.renox.app` = `https://github.com/publicsuffix/list/pull/<number>` as soon as the PR has a number. It must stay in place as long as the entry exists.
3. **The pull request** to `publicsuffix/list`, against `public_suffix_list.dat`, in the PRIVATE section, in alphabetical order of the organisation name:

   ```
   // Renox : https://renox.app
   // Submitted by <name> <security contact address at renox.app>
   renox.app
   ```

   The PR body uses the list's template: organisation (Renox), website, a one-paragraph description ("multi-tenant hosting platform; every customer app is served at `<app>.renox.app`; customers must not be able to set cookies for, or share reputation with, other customers"), the number of subdomains (one per customer app), and the `_psl` record from step 2.
4. **After the PR is opened:** link it in a comment on #114 and in the table below.
5. **After it is merged:** browsers pick it up in their next releases (weeks to months). Keep the interim rules below until the browsers in the support matrix ship it.

## Until the entry is in browsers

The platform behaves as if `renox.app` were on the list:

| Where | Rule | Proof |
| --- | --- | --- |
| Control API and dashboard | Session cookie `__Host-renox_session`: host-only, `Path=/`, `Secure`, never `Domain` | `control/api/tests/domains-ownership.test.ts`, "the session cookie is host-only" |
| Tenant pages (renox-cell) | Session and CSRF cookies are host-only (no `Domain`) | `crates/renox-cell/src/pages/session.rs` |
| Gateway | Not yet: a tenant's own `Set-Cookie` with `Domain=renox.app` (or the bare apex) passes through. The rule to add: drop the `Domain` attribute, or the whole header, when the domain is the platform domain itself | Open on #114 (not in the files of that issue) |
| App names | Reserved words (`www`, `api`, `admin`, …) are never app names, and a deleted app's name is quarantined for 90 days for other tenants | `control/api/src/apps/slugs.ts` |

## Status

| Step | State |
| --- | --- |
| Registration more than two years ahead | to check |
| `_psl.renox.app` TXT record | not created |
| Pull request to `publicsuffix/list` | not opened |
| Merged | — |
