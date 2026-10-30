# audit

An append-only audit trail for an app and its modules (`docs/18-build-plan.md` M8; `docs/11-authorization.md` "Cross-module context and audit"). Modules and the app record events through one service. Nothing can edit or delete them. The platform's authorization decisions on sensitive actions appear in the same trail.

## Install

```toml
[modules]
audit = { version = "^1.0", config = { retain_days = 365 } }
```

A module that records events adds `audit = "^1.0"` to its `[dependencies]` and `services = ["audit.record"]` to its `[imports]`. Depending on `audit` also lets that module read the platform view `renox__authz_audit_v1` directly.

## The event

`audit__events`, one row per event:

| Column | Meaning |
| --- | --- |
| `id` | Random, sortable by time |
| `at` | Unix ms (as in `renox__authz_audit`) |
| `actor_kind` | `user`, `agent` or `system` |
| `actor_id` | The user id (the agent's user for `agent`), or `system:<module>` |
| `client` | The agent's client name (`agent` only) |
| `action` | `<module>.<verb>`, such as `invoice.refund` or `auth.login` |
| `resource_type`, `resource_id` | What was acted on (`billing:Invoice`, `inv_1`), optional |
| `result` | `ok`, `denied` or `failed` |
| `details` | A JSON object, redacted (below), at most 16 KB |
| `request_id` | Optional, to tie a row to logs |
| `source` | `record`, or the name of the event a listener recorded |

### Actor kinds

- `user`: a person, acting in a browser.
- `agent`: a person's agent through the app's `/mcp`, with the agent's client name in `client`. It can do only what its user can (`docs/20-ai-agents-mcp.md` section 5, "Attribution").
- `system`: the platform or a module acting on its own (an event handler, a job), as `system:<module>`.

### Redaction

The redaction rule applies to `details` at any depth. Each key is split into words (`apiKey`, `api_key` and `API-KEY` all become `api key`). The key's value becomes `"[redacted]"` when either:

- one of the words is `password`, `pass`, `secret`, `token`, `authorization`, `cookie`, `credential`, `otp`, `pin`, `cvv`, `iban`, `signature`, `salt`, `hash` (and a few spellings of these); or
- the words run together into `apikey`, `privatekey`, `accesskey`, `cardnumber`, `sessionid` or `clientsecret`.

Values are never inspected, so a secret stored under an innocent key stays: name keys for what they hold.

## Services

| Service | Result |
| --- | --- |
| `record(event)` | `{ id }`. `event` is `{ action, actor: { kind, id, client? }, resource?: { type, id? }, result?, details?, request_id? }`. A malformed event throws |
| `query(filter?)` | `{ events, next }`, newest first. The events are this module's rows merged with the platform's decisions from `renox__authz_audit_v1` (`kind: "authz"`, `result` `allow`/`deny`). Filter: `actor`, `action` (or a prefix ending in `.`), `since`, `until`, `platform` (default `true`), `limit` (1 to 200, default 50), `cursor` (the previous page's `next`). Requires `audit.read` |
| `exportEvents(filter?, purpose?)` | Runs the hook `audit.export` once per page of 200 (`{ events, page, last, purpose }`); returns `{ events, pages }`. For F7's reports and the F6 erasure task (#120). Requires `audit.read` |
| `prune()` | Deletes rows older than `retain_days`, never fewer than 30 days; returns `{ deleted }`. Until the jobs of #297 run it on a schedule, the app calls it |

## Who may read

`audit.read` is the module's action, and it is `sensitive`: every read, allowed or denied, writes its own row in `renox__authz_audit`. `policies/audit.cedar` allows it to the role `auditor`. The app grants that role (`ctx.authz.roles.assign(userId, "auditor")`); the module never grants it.

## Listeners

These events become rows with no code in the app (`hooks.ts`, `on`):

| Event | Actor |
| --- | --- |
| `auth.login`, `auth.password_changed`, `auth.agent_token_revoked` | The user |
| `authz.roles_changed` | `system:authz`; `details` names the user, the role and `op` |
| `org.created`, `org.member_added` | The user |
| `org.member_removed` | `by`, the user who removed the member |

## Append-only

- **Updates are refused.** `audit__events` has triggers that `RAISE(ABORT)` on every `UPDATE`.
- **Young rows cannot be deleted.** The same triggers refuse a `DELETE` of any row younger than 30 days.
- **This covers every connection.** It holds for the module's own code, other modules, the app, and a tool that opens the file.
- **Other modules cannot write the table at all.** The SQLite authorizer refuses them `audit__*`.
- **The platform table is the authorizer's job.** `renox__authz_audit` (#277) is refused `UPDATE`, `DELETE`, `DROP` and `ALTER` for everyone.

The manifest has no `append_only` permission (#272 did not add one), so the triggers are the module's rule. To make them possible, the migration runner lets a module create triggers on its own tables. Their bodies may only `select raise(...)`, with no subquery.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `retain_days` | 365 | `prune` deletes rows older than this, from 30 to 3650 days |

## Tests

`renox test` in this folder runs `tests/audit.test.ts` against `tests/app`. That app has auth, org, audit, and the fixture `tamper`: a module that depends on audit, tries to edit its rows, and fills `audit.export`. The tests cover:

- the redaction rule;
- the listeners;
- `record` from another module;
- append-only, against module code, app code and the file itself (the `docs/24-threat-model.md` row "Audit library append-only; tenant cannot edit or delete audit rows");
- `query` refused without the role and allowed with it, with the platform decisions joined and paged;
- export;
- prune.

The policy cases are in `policies/tests/audit.json`.
