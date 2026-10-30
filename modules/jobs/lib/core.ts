// What the jobs module's services and pages share (ops.md 1.6.0 section 20):
// the platform keeps the runs, the module only reads and changes them
// through ctx.jobs, and only after the app's policy allows the action.

export type JobState = "scheduled" | "queued" | "running" | "dead";
export const STATES: readonly JobState[] = ["scheduled", "queued", "running", "dead"];

export interface JobRow {
  id: string | null;
  name: string;
  module: string;
  tick: number | null;
  next_at: number | null;
  run_at: number | null;
  attempts: number;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
}

export interface JobPage {
  items: JobRow[];
  next_cursor: string | null;
}

export interface JobsCtx {
  jobs: {
    list(state: JobState, options?: { limit?: number; cursor?: string | null }): Promise<JobPage>;
    retry(id: string): Promise<void>;
    cancel(id: string): Promise<void>;
  };
  authz: { require(action: string, resource?: unknown): Promise<void> };
  /** A service's ctx.db opens a transaction; a page action's ctx.db is already the action's. */
  db: { transaction?<T>(fn: () => Promise<T>): Promise<T> };
  config: { base_path?: string };
  principal?: { id: string; kind?: string } | null;
}

export class JobsInputError extends Error {
  readonly code = "JOBS_INPUT";
}

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export function state(v: unknown): JobState {
  if (typeof v === "string" && (STATES as readonly string[]).includes(v)) return v as JobState;
  throw new JobsInputError("state is scheduled, queued, running or dead");
}

export function id(v: unknown): string {
  if (typeof v === "string" && ID.test(v)) return v;
  throw new JobsInputError("a job run id is a ULID");
}

export async function list(ctx: JobsCtx, s: JobState, options: { limit?: number; cursor?: string | null } = {}): Promise<JobPage> {
  await ctx.authz.require("jobs.read");
  return ctx.jobs.list(s, { limit: Math.min(Math.max(options.limit ?? 50, 1), 100), cursor: options.cursor ?? null });
}

/** Runs `fn` in a transaction: the caller's when there is one (a page action), else a new one. */
const inTx = (ctx: JobsCtx, fn: () => Promise<void>): Promise<void> => (typeof ctx.db.transaction === "function" ? ctx.db.transaction(fn) : fn());

export async function retry(ctx: JobsCtx, run: string): Promise<void> {
  await ctx.authz.require("jobs.manage");
  await inTx(ctx, () => ctx.jobs.retry(run));
}

export async function cancel(ctx: JobsCtx, run: string): Promise<void> {
  await ctx.authz.require("jobs.manage");
  await inTx(ctx, () => ctx.jobs.cancel(run));
}

export const basePath = (ctx: JobsCtx): string => (ctx.config.base_path ?? "/jobs").replace(/\/$/u, "") || "/jobs";

/** A row as the page shows it: times as ISO strings in UTC, a short job label. */
export function shown(r: JobRow) {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z"));
  return {
    id: r.id,
    job: r.module === "app" ? r.name : `${r.module}.${r.name}`,
    next: iso(r.next_at ?? r.run_at),
    last: iso(r.finished_at),
    started: iso(r.started_at),
    attempts: r.attempts,
    error: r.last_error,
  };
}
