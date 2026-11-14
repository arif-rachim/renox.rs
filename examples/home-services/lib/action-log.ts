// The visit page's actions, idempotent by `action_id` (#806, wave C: the server half of the technician's
// offline queue). A phone that was offline posts its queued actions late, and a retry or a double tap posts
// one twice: an action that carries an `action_id` runs once. The action's own transaction (ops.md section
// 14) holds the log row and the change, so both commit or neither does.
//
// With an `action_id` (16 to 64 characters of A-Z a-z 0-9 _ -): a row of the same user answers its stored
// status and result without running anything; a row of another user is a 409 `action_id_taken`; otherwise
// the job's state is checked first (`conflictOf` of lib/visits.ts: cancelled, reassigned, checked out, not
// checked in; a second check-in is a success), the action runs, and its answer is stored. Only a success is
// stored: a conflict (409), a form that is wrong (422) or another refusal (403, 404, 413, 415) is checked and
// answered again each time, so a device may send the action again under the same id once the job allows it
// ("Try again" of #810 after a reassignment is undone), and an accepted action is never run twice. Without an
// `action_id` nothing is logged or checked and the action runs as before.
//
// `Accept: application/json` gets `{ ok, status, redirect?, errors?, conflict?, time_adjusted? }` with that
// status (200 for a success); a plain form post keeps the 303 to the page, the 422 re-render and the plain
// text of a refusal, and a conflict re-renders the page with its message (`visits.conflict.<code>`; as plain
// text when the page is no longer the user's: reassigned, or another user's id), so the page works without scripts.
// A conflict answered to a request that carries `x-hs-queued: 1` (the phone's queue sets it on replays only) is also
// recorded as a job event `offline_action_refused` and told to the branch's dispatchers (`noteOfflineRefusal` of
// lib/visits.ts, #810); the event is written in this same transaction, which commits because the action answers
// the 409 instead of throwing. `performed_at` (unix ms) says when the action happened: lib/visits.ts keeps it
// only when it is plausible, else the server's time is used and the result says `time_adjusted: true`.
import type { ActionContext } from "@renoxium/sdk";

import { invalid } from "./invalid";
import { shell } from "./page";
import { conflictOf, noteOfflineRefusal, performedAt, type Conflict, type Failure, type Result } from "./visits";

/** What an action's body hands over: its result, a refusal, or the 422 of a form that is wrong. */
export type Step = Result<unknown> | ReturnType<typeof invalid>;

/** What the body needs: the page (its locale) and the time the action happened, in unix seconds. */
export interface Run {
  page: Awaited<ReturnType<typeof shell>>;
  at: number;
}

/** The JSON a device is answered, and the log keeps. `errors.form` is a refusal's reason. */
export interface Answer {
  ok: boolean;
  status: number;
  redirect?: string;
  errors?: Record<string, string>;
  conflict?: Conflict | "action_id_taken";
  time_adjusted?: true;
}

const ID = /^[A-Za-z0-9_-]{16,64}$/u;
/** The most the log keeps of an answer. */
const MAX_RESULT_BYTES = 4096;

const now = (): number => Math.floor(Date.now() / 1000);
const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
/** The page of a form that is wrong (422), or the same page with a conflict's message (409). */
type Rendered = Omit<ReturnType<typeof invalid>, "status"> & { status: 409 | 422 };
const isInvalid = (s: Step): s is ReturnType<typeof invalid> => "errors" in s;

/** An answer that fits the log: a reason is cut before the whole is dropped to its status. */
function fitted(a: Answer): string {
  const text = JSON.stringify(a);
  if (new TextEncoder().encode(text).length <= MAX_RESULT_BYTES) return text;
  const { errors: _errors, ...rest } = a;
  return JSON.stringify(rest);
}

export async function withActionId(ctx: ActionContext, action: string, jobId: unknown, fn: (run: Run) => Promise<Step>): Promise<Response | Rendered> {
  const page = await shell(ctx);
  const json = (ctx.headers.get("accept") ?? "").includes("application/json");
  const to = `/me/visits/${String(jobId)}`;
  const performed = performedAt(ctx.form.get("performed_at"));
  const run: Run = { page, at: performed.at };

  /** The step as the device sees it. */
  const answerOf = (step: Step): Answer => {
    if (isInvalid(step)) return { ok: false, status: 422, errors: step.errors };
    if (step.ok) return { ok: true, status: 200, redirect: to, ...(performed.adjusted ? { time_adjusted: true as const } : {}) };
    return { ok: false, status: (step as Failure).status, errors: { form: (step as Failure).message } };
  };
  /** An answer as a response: JSON on request, else what the page always did. */
  const respond = (a: Answer, step?: Step): Response | Rendered => {
    if (json) return Response.json(a, { status: a.status, headers: { "cache-control": "no-store" } });
    if (a.ok) return new Response(null, { status: 303, headers: { location: a.redirect ?? to, "cache-control": "no-store" } });
    if (step !== undefined && isInvalid(step)) return step;
    // Another technician's page is not rendered for them (its loader refuses): their refusal is the text.
    if (a.conflict === "job_reassigned" || a.conflict === "action_id_taken") return plain(409, a.errors?.form ?? "");
    if (a.conflict !== undefined) return { ...invalid(page.locale, ctx.form, { form: `visits.conflict.${a.conflict}` }), status: 409 as const };
    return plain(a.status, a.errors?.form ?? "");
  };

  /** A 409 for a conflict, with its reason in the page's language. */
  const refused = (code: NonNullable<Answer["conflict"]>): Answer => ({ ok: false, status: 409, conflict: code, errors: { form: invalid(page.locale, ctx.form, { form: `visits.conflict.${code}` }).errors.form as string } });

  const raw = ctx.form.get("action_id");
  const given = raw === null || raw === "" ? null : raw;
  const userId = ctx.principal?.id;
  if (given === null || userId === undefined) {
    const step = await fn(run);
    return respond(answerOf(step), step);
  }
  if (typeof given !== "string" || !ID.test(given)) {
    const step = invalid(page.locale, ctx.form, { form: "visits.err.action_id" });
    return respond(answerOf(step), step);
  }

  const known = await ctx.db.queryOne<{ user_id: string; result: string }>("select user_id, result from app__action_log where action_id = ?", [given]);
  if (known !== null) {
    if (known.user_id !== userId) return respond(refused("action_id_taken"));
    return respond(JSON.parse(known.result) as Answer);
  }

  let answer: Answer;
  const found = await conflictOf(ctx, jobId, action);
  if (found !== null && "conflict" in found) {
    // Not stored: the same id is checked again on its next post.
    // A request the phone's queue replays (`x-hs-queued: 1`, set on replays only) that is refused tells the office (#810).
    if (ctx.headers.get("x-hs-queued") === "1") await noteOfflineRefusal(ctx, jobId, action, found.conflict, run.at);
    return respond(refused(found.conflict));
  } else if (found !== null) {
    answer = { ok: true, status: 200, redirect: to };
  } else {
    const step = await fn(run);
    answer = answerOf(step);
    if (answer.status !== 200) return respond(answer, step);
  }
  const text = fitted(answer);
  await ctx.db.execute("insert into app__action_log (action_id, user_id, visit_job_id, action, status, result, created_at) values (?, ?, ?, ?, ?, ?, ?)", [given, userId, String(jobId), action, answer.status, text, now()]);
  return respond(JSON.parse(text) as Answer);
}
