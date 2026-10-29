# org

Organisations for any app (`docs/18-build-plan.md` M2): a user belongs to one or more organisations with a role, invites others by email, and switches the active organisation. The app gets the active organisation and the user's role from one service call, with no org code of its own.

It depends on `auth ^1.0` (users and sessions) and `i18n ^1.0` (the page locale). It has no network and no secrets.

## Install

```sh
renox add i18n
renox add auth
renox add org
```

```toml
[modules]
auth = { version = "^1.0" }
org = { version = "^1.0" }   # mounted at /org
```

| Config | Default | |
| --- | --- | --- |
| `base_path` | `/org` | Where the app mounts org's pages; the switcher posts there. Set it when you change the mount |
| `invite_days` | `7` | An invitation expires this many days after it was sent |

## Roles

`member` < `admin` < `owner`.

- Every member reads the members list and may leave.
- An admin also invites, withdraws invitations, changes roles, and removes members. An admin never changes or removes an owner, and never grants `owner`.
- An owner does all of that for every member, owners included.
- The last owner of an organisation cannot be removed, leave, or be demoted. Make someone else owner first.

## Services

Through `import { org } from "renox:modules"`. A call the signed-in user's membership does not allow throws, and the caller sees `RENOX_MODULE_SERVICE`.

| Service | |
| --- | --- |
| `createOrg({ name, slug? })` | A new organisation. The signed-in user becomes its owner and it becomes the active one. `slug` defaults to the name in lower case with dashes, and it is unique. Returns `{ org }` or `{ error }` |
| `listOrgs(user_id)` | The user's organisations, each `{ id, slug, name, role }` |
| `currentOrg()` | The active organisation of this session, `{ id, slug, name, role, scope }`, or `null` |
| `requireMember(role?)` | The active organisation, or throws when the user is signed out or holds less than `role` |
| `switchOrg(org_id)` | Make another of the user's organisations active |
| `members(org_id)` | `[{ user_id, display_name, email, role }]`. The caller must be a member of that organisation |
| `invite({ org, email, role })` | Admin or owner. The link goes out through `org.send_mail`. Returns `{ invite_id, expires_at }` or `{ error }` |
| `revokeInvite({ org, invite })` | Withdraw a pending invitation |
| `acceptInvite(token)` | Join as the signed-in user. The invitation works once, before it expires, and only for the email it was sent to |
| `setRole({ org, user, role })`, `removeMember({ org, user })` | See the roles above. `removeMember` with your own id means leaving |
| `switcher(next?)` | The data of the switcher partial, for a page's `load` |

`scope` is `{ org_id, role }`, the organisation part of the authz context of F5 (`docs/11-authorization.md`, `policies/org.cedar`).

**The fence between organisations is in these services.** The SQLite authorizer keeps other modules out of `org__*` tables, but it does not tell one organisation's rows from another's. Until F5 brings `db.scoped`, scope your own tables yourself: store `currentOrg().id` with a row and filter on it. The `shop` example does this for its orders.

## Active organisation

The active organisation is kept per auth session. It is stored in `org__active`, keyed by the session id from `auth.currentSession()`, so it ends when the session ends. Without a choice, or after the user leaves the chosen organisation, the active one is the first organisation the user joined.

## Language

Each organisation may have a default locale (`org__orgs.locale`), set by an admin or owner on the members page or with `setOrgLocale({ org, locale })`. org's pages pass it to `i18n.detectLocale` with the user. A member's own choice (`?lang=`) wins over it. The labels come from `i18n/en.json` and `i18n/ar.json`, keys `org.*`.

## Pages

| Path | |
| --- | --- |
| `/org` | Your organisations, switch, create one. `?/switch` takes `org` and `next`, then redirects to `next` (a path of the app only) |
| `/org/members` | The active organisation's members. Admins and owners also see invitations and manage members |
| `/org/accept/<token>` | The invitation link. A signed-out visitor goes through auth's login and comes back |

## The switcher

org fills the `app.header` slot with `partials/switcher.html`. The partial renders what the page's `load` returns as `org_switcher`:

```ts
import { auth, org } from "renox:modules";

export async function load({ url }) {
  return { auth_user: await auth.currentUser(), org_switcher: await org.switcher(url.pathname) };
}
```

A member sees a select of their organisations, labelled with their role in each. Admins and owners also get a link to the members page. A signed-in user with no organisation gets a link to create one. A signed-out visitor sees nothing.

`admin.sidebar` is reserved for the `admin` module (M5). org fills it with a link to the members page, shown only with `org.manage_members`.

## Events and hooks

| | Payload | |
| --- | --- | --- |
| `org.created` | `{ org_id, user_id, at }` | event |
| `org.member_added` | `{ org_id, user_id, role, at }` | event: at creation (the owner) and on every accepted invitation |
| `org.member_removed` | `{ org_id, user_id, by, at }` | event |
| `org.before_invite` | `{ org_id, email, role, invited_by }` | hook: a filler may halt (seat limits, a domain allowlist). Its response is the answer and no invitation is created |
| `org.send_mail` | `{ to, template: "org_invite", args: { url, org_name, role, expires_days, invited_by } }` | hook: fill it to deliver invitations until the email module (F7) |

## Tables and views

- `org__orgs`
- `org__members`, unique per organisation and user
- `org__invites`, which stores only the SHA-256 of the token
- `org__active`

Other modules read memberships through `org__public_members_v1` (`org_id`, `user_id`, `role`).

## Tests

`renox test` in this folder runs `tests/` against `tests/app`, which has auth, org, and a fixture that records mail and events. The tests cover:

- the fence between organisations;
- invitations: single use, expiry, withdrawal, the invited email, and the hook;
- the last owner;
- the events;
- snapshots of the switcher and the members page for an owner, an admin, a member and a non-member;
- install and upgrade into the shop.
