# admin (#335)

The app's back office. It provides:
- a layout with the `admin.sidebar` slot;
- a dashboard with the `admin.dashboard` slot, which the installed modules fill;
- the users page, where the admin role is granted and revoked;
- the audit viewer.

## Install

```sh
bunx renox add admin          # needs auth, i18n and audit
```

```toml
admin = { version = "^1.0", mount = "/admin", config = { title = "Back office" } }
```

The app grants the first admin with `ctx.authz.roles.assign(user_id, "admin")` from its own code, for example a one-off setup route. After that, admins grant each other from the users page.

## Pages

| Page | Needs | What it shows |
| --- | --- | --- |
| `<mount>` | `admin.access` | The user count, the latest audit events (with `audit.read`), and the cards of `admin.dashboard` |
| `<mount>/users?q=` | `admin.access` | The users from auth's public view and whether each holds the admin role |
| Grant and revoke buttons on the users page | `admin.users` (sensitive) | Shown under `r-can`. An admin cannot revoke their own role |
| `<mount>/audit?actor=&action=` | `admin.access` | The audit module's trail. It also needs `audit.read`, the auditor role; without it the page says so and shows no rows |

The default policy grants both admin actions to the `admin` role.

## Slots other modules fill

| Module | `admin.sidebar` link | Shown when the user holds |
| --- | --- | --- |
| billing | All invoices | `billing.manage` |
| storage | Files | `storage.manage` |
| jobs | Jobs | `jobs.read` |
| notifications | Notification preferences | (everyone) |

A filler renders only when its module is installed and the user holds its `requires` action.

## Not built

- **CRUD scaffolding from `[admin.tables]`.** A module may read and write only its own `<name>__*` tables (the authorizer, `ops.md` section 3), so a back office module cannot edit the app's `app__*` tables. Scaffolding needs a contract change: either an app-granted table permission for one module, or a scaffold that `renox` generates into the app's own pages.
- **The organisations page.**
- **Settings beyond `admin__settings`.**

## Tests

With `RENOX_WORKER_PATH`, `tests/app.test.ts` runs in an app with auth, audit and jobs on the worker:
- the back office is refused without `admin.access`;
- the sidebar renders jobs' link and not billing's, which is not installed;
- the admin role is granted and revoked, but not an admin's own;
- the audit viewer is refused without the auditor role and shows the role decisions to an auditor;
- the users table header is snapshotted in `ltr` and `rtl`.
