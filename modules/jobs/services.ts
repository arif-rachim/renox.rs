// The jobs module's services (#297; ops.md 1.6.0 section 20): the dashboard
// view of the app's jobs and its dead letters. Every call checks the app's
// policy first (jobs.read to list, jobs.manage to retry or cancel), then
// goes through the platform op that only this module may call.

import * as core from "./lib/core.ts";

export async function list(ctx: core.JobsCtx, state: unknown, options: { limit?: number; cursor?: string | null } = {}): Promise<core.JobPage> {
  return core.list(ctx, core.state(state), options);
}

export async function retry(ctx: core.JobsCtx, id: unknown): Promise<{ ok: true }> {
  await core.retry(ctx, core.id(id));
  return { ok: true };
}

export async function cancel(ctx: core.JobsCtx, id: unknown): Promise<{ ok: true }> {
  await core.cancel(ctx, core.id(id));
  return { ok: true };
}
