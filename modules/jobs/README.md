# jobs

The app's scheduled and queued jobs as a page (#297; `docs/contracts/ops.md` 1.6.0 section 20, `docs/18-build-plan.md` M10). The platform keeps the runs: a job file exports `schedule` and `run`, the cell's scheduler writes one durable run per tick, the outbox worker runs it with retries and dead letters. This module only shows them and lets an admin retry or cancel a run.

## Install

```toml
[modules]
jobs = { version = "^1.0", mount = "/jobs" }
```

It needs `auth` (the login hop) and `i18n` (EN and AR).

## Page

`GET /jobs` (the mount): four lists.

| List | What it shows |
| --- | --- |
| Scheduled | Every `job` route of the active deployment, its next tick and when it last finished |
| Queued | Runs waiting for their time or a retry, with their attempts |
| Running | Runs in flight and when they started |
| Failed (dead letters) | Runs that used all their attempts, with the redacted last error (an error code or `threw`, at most 512 characters) |

A payload is never shown or returned. `POST ?/retry` puts a dead run back in the queue with its attempts reset; `POST ?/cancel` deletes a queued or dead run (a running run is refused until it ends; a scheduled job is not cancelled: it follows its `schedule`).

## Permissions

| Action | Default role | What |
| --- | --- | --- |
| `jobs.read` | `admin`, `operator` | The page and `list` |
| `jobs.manage` | `admin` | `retry` and `cancel`; sensitive, so every decision is a row of `renox__authz_audit`, besides the op's own row (`jobs.retry`, `jobs.cancel`) |

The app grants the roles (`ctx.authz.roles.assign(user, "admin")`); the module never grants them. The page has `guard = { action: "jobs.read" }`: a user without it gets 403.

## Services

| Service | What |
| --- | --- |
| `list(state, { limit?, cursor? })` | `{ items, next_cursor }` of `scheduled`, `queued`, `running` or `dead` (`JobRow`: `id`, `name`, `module`, `tick`, `next_at`, `run_at`, `attempts`, `started_at`, `finished_at`, `last_error`) |
| `retry(id)` | A dead run back in the queue |
| `cancel(id)` | A queued or dead run deleted |

Each checks the app's policy first, then calls `ctx.jobs.list`, `retry` or `cancel`: the platform answers those ops only to this module (`RENOX_FORBIDDEN` for the app and any other module). Errors: `RENOX_JOB_NOT_FOUND`, `RENOX_JOB_STATE` (retry of a run that is not dead, cancel of a running run).

## Config

| Key | Default | What |
| --- | --- | --- |
| `base_path` | `/jobs` | Where the app mounts the pages |

## Writing a job

```ts
// jobs/nightly-report.ts (the app) or modules/<name>/jobs/<name>.ts (a module)
export const schedule = "0 3 * * *";   // minute hour day-of-month month day-of-week
export const tz = "Asia/Dubai";         // optional; UTC when absent
export async function run(ctx) {
  // ctx.job: { id, name, tick, attempt, payload }; ctx.db is this attempt's transaction
}
```

`ctx.jobs.enqueue("nightly-report", { day: "2026-10-30" }, { runAt })` queues a run of one of the caller's own jobs, in the current transaction. Under `renox dev`, scheduled jobs run with `--jobs`, and `renox jobs list|run|retry` works on the dev database.

## Tests

`tests/jobs.test.ts` through `renox test` (or `bun test` with `RENOX_WORKER_PATH`): the four lists without a payload (snapshot of the failed list), retry and cancel with their audit rows, an operator reading but not retrying, a user without a role and the app's own broker call refused. `policies/tests/jobs.json`: the default policies per role.
