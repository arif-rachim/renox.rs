// The pure part of the technician's offline action queue (#808): the rules, with no DOM, no IndexedDB and no
// network, so `tests/offline-queue.test.ts` runs them as they are. public/offline-queue.js is the part that
// touches the page and the device and calls these.
//
// A queued action is `{ seq, action_id, user_id, job_id, url, action, fields, performed_at, state, attempts,
// refused_reason?, refused_message?, refused_errors? }`, `state` being "pending", "sent" or "refused".
//
// - Order: the actions of one user go to the server strictly in `seq` order, one at a time.
// - A job that has an action the server refused sends nothing more: the later actions of that job depend on
//   it. The actions of other jobs go on.
// - A network error or a 5xx stops the run; the next try waits 30 s, then 1, 2 and 5 minutes.
// - At most 200 actions wait on a device; an action older than 72 hours is still sent and says so.
//
// A classic script (loaded with `defer`) that sets `hsQueueCore` on the page; `require`d or imported, it
// exports the same object.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.hsQueueCore = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  /** The most actions that wait on one device. */
  const LIMIT = 200;
  /** Older than this at the time of sending, an action is marked so (the server adjusts its time, #806). */
  const OLD_MS = 72 * 3600 * 1000;
  /** The wait before the next try after 1, 2, 3 and 4 or more failed sends. */
  const BACKOFF_MS = [30000, 60000, 120000, 300000];
  /** How often a page with waiting actions looks for a connection. */
  const POLL_MS = 30000;

  /** The actions the queue takes and the page each one belongs to: a visit page of the technician. */
  const ACTIONS = ["checkin", "part", "notes", "signature", "summary", "checkout"];
  const VISIT_URL = /^\/me\/visits\/([A-Za-z0-9_-]{1,64})$/u;
  const ACTION_ID = /^[A-Za-z0-9_-]{16,64}$/u;

  /** An `action_id` from a UUID: its 32 hex digits, no dashes (the server wants 16 to 64 of A-Z a-z 0-9 _ -). */
  const actionIdOf = (uuid) => String(uuid).replace(/-/gu, "");

  /** Waits (ms) before the next try after `attempts` failed sends in a row: 0 for none, then 30 s, 1, 2 and 5 minutes. */
  const backoffMs = (attempts) => (attempts <= 0 ? 0 : BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]);

  /** Whether a device holding `pending` actions takes one more. */
  const canQueue = (pending) => pending < LIMIT;

  /** Whether an action made at `performedAt` (unix ms) is older than 72 hours at `now`. */
  const isOld = (performedAt, now) => now - performedAt > OLD_MS;

  /** The job and the action a stored record names, when both are what the queue takes; null otherwise. */
  const targetOf = (record) => {
    if (!record || typeof record.url !== "string" || typeof record.action !== "string") return null;
    const m = VISIT_URL.exec(record.url);
    if (m === null || !ACTIONS.includes(record.action) || !ACTION_ID.test(String(record.action_id))) return null;
    return { job_id: m[1], action: record.action };
  };

  const bySeq = (a, b) => a.seq - b.seq;

  /** The records of one state, in `seq` order. */
  const inState = (records, state) => records.filter((r) => r.state === state).sort(bySeq);

  /**
   * What the device holds, seen from the signed-in user: their waiting actions (pending, in order), how many
   * pending actions belong to other accounts (never sent under this session), and the actions the server refused.
   */
  const split = (records, userId) => {
    const pending = inState(records, "pending");
    return {
      mine: pending.filter((r) => r.user_id === userId),
      other: pending.filter((r) => r.user_id !== userId).length,
      refused: inState(records, "refused").filter((r) => r.user_id === userId),
    };
  };

  /** The jobs that send nothing more: a job of the user with an action the server refused. */
  const blockedJobs = (records, userId) => new Set(inState(records, "refused").filter((r) => r.user_id === userId).map((r) => r.job_id));

  /**
   * The action to send next: the first pending action of `userId` in `seq` order whose job is not blocked
   * (it has no refused action, and none was refused during this run: `also`). Null when there is none.
   */
  const nextAction = (records, userId, also) => {
    const blocked = blockedJobs(records, userId);
    for (const j of also || []) blocked.add(j);
    return split(records, userId).mine.find((r) => !blocked.has(r.job_id)) || null;
  };

  /** The pending actions of `userId` that wait behind a refused action of their job: they stay, unsent. */
  const behindRefused = (records, userId) => {
    const blocked = blockedJobs(records, userId);
    return split(records, userId).mine.filter((r) => blocked.has(r.job_id));
  };

  /**
   * What the server's answer means for the action. `answer` is `{ status, body }` (`body` the parsed JSON or
   * null), or `null` for a request that got no answer (a network error, a timeout).
   *  - ok:      sent.
   *  - refused: the server looked at it and said no (409, 422, other 4xx); `stop` is "job": send nothing more of this job.
   *  - auth:    401 or 403: the user must sign in again; stop everything, keep the queue.
   *  - retry:   no answer, 5xx, 408, 429: stop everything and try again later.
   */
  const outcomeOf = (answer) => {
    if (answer === null || answer === undefined) return { kind: "retry" };
    const { status } = answer;
    const body = answer.body && typeof answer.body === "object" ? answer.body : {};
    const errors = body.errors && typeof body.errors === "object" ? body.errors : undefined;
    const first = errors ? errors.form || Object.values(errors).find((v) => typeof v === "string") : undefined;
    const message = typeof first === "string" ? first : "";
    if (status === 200 && body.ok === true) return { kind: "ok", adjusted: body.time_adjusted === true };
    if (status === 401 || status === 403) return { kind: "auth" };
    if (status >= 500 || status === 408 || status === 429) return { kind: "retry" };
    if (status === 409) return { kind: "refused", stop: "job", reason: typeof body.conflict === "string" ? body.conflict : "conflict", message, errors };
    if (status === 422) return { kind: "refused", stop: "job", reason: "invalid", message, errors };
    // Any other answer is not "sent": keep it as refused rather than send it again and again.
    return { kind: "refused", stop: "job", reason: `http_${status}`, message, errors };
  };

  /**
   * The record after an answer: the changes to store on it, and what the run does next.
   * `stop` is "none" (go on with the next action), "job" (that job sends nothing more) or "all" (stop the run).
   */
  const settle = (record, outcome) => {
    switch (outcome.kind) {
      case "ok":
        return { patch: { state: "sent" }, stop: "none" };
      case "refused": {
        const patch = { state: "refused", refused_reason: outcome.reason };
        if (outcome.message) patch.refused_message = outcome.message;
        if (outcome.errors) patch.refused_errors = outcome.errors;
        return { patch, stop: "job" };
      }
      case "auth":
        return { patch: {}, stop: "all" };
      default:
        return { patch: { attempts: (record.attempts || 0) + 1 }, stop: "all" };
    }
  };

  /** When (unix ms) to try again after a run that stopped on a failed send of `record`; `POLL_MS` when none failed. */
  const retryAt = (now, record) => now + (record ? Math.max(backoffMs(record.attempts || 0), POLL_MS) : POLL_MS);

  /**
   * The whole replay as a plan over the records in memory: given a function that sends one record and answers
   * `{ status, body }` or null, runs the rules above and returns the records' changes in the order they happen.
   * (The page's script does the same step by step, writing each change to the device; this is the reference the
   * tests hold it to.)
   */
  const replay = async (records, userId, send) => {
    const copy = records.map((r) => ({ ...r }));
    const log = [];
    const also = [];
    for (;;) {
      const next = nextAction(copy, userId, also);
      if (next === null) return { log, stopped: "done", records: copy };
      const outcome = outcomeOf(await send(next));
      const { patch, stop } = settle(next, outcome);
      Object.assign(next, patch);
      log.push({ seq: next.seq, outcome: outcome.kind, patch });
      if (stop === "all") return { log, stopped: outcome.kind, records: copy };
      if (stop === "job") also.push(next.job_id);
    }
  };

  /** "2026-11-14 10:42": the Dubai time of a unix ms, as the pages show a visit's times (Dubai is UTC+4 all year). */
  const dubai = (ms) => {
    const d = new Date(ms + 4 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };

  /** A text with `{name}` placeholders filled in. */
  const fill = (text, values) => String(text).replace(/\{(\w+)\}/gu, (all, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : all));

  return { LIMIT, OLD_MS, BACKOFF_MS, POLL_MS, ACTIONS, actionIdOf, backoffMs, canQueue, isOld, targetOf, split, blockedJobs, nextAction, behindRefused, outcomeOf, settle, retryAt, replay, dubai, fill };
});
