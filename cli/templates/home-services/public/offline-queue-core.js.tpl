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
// Photos (#809) wait in their own store, `photos`: `{ id, user_id, job_id, phase, caption, blob, type, size,
// taken_at, action_id, state, attempts, refused_reason?, refused_message? }`, `state` being "pending", "uploaded"
// or "refused". A photo is an action in its job's sequence: it is sent between the actions of its job where its
// `taken_at` puts it (`merge`), as three requests (`sendPhoto`: the signed URL, the PUT, the `photo` action).
// A photo the server refuses for what it is (too big, not an image, a form that is wrong) stays refused on the
// device until the technician removes it and does not stop its job; a refusal about the job (a conflict) stops the
// rest of the job, photos included. At most 20 photos wait on a device.
//
// "Needs attention" (#810, the list on /me): `attention` groups what the server refused, and what waits behind
// it, per job; `attentionHtml` is the markup of that list (a string with every value escaped, so a test can render
// it without a DOM). "Try again" is offered for a group whose refusals are `job_reassigned` or a 422 only
// (`RETRY_REASONS`); the same `action_id`s are sent again, never a force. `unsent` counts what the sign-out
// warning page says is saved on the phone.
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
  /** The most photos that wait on one device. */
  const PHOTO_LIMIT = 20;
  /** A phone with less free space than this (20 MiB) keeps no more photos. */
  const MIN_FREE_BYTES = 20 * 1024 * 1024;
  /** A photo is sent at most this many pixels on its long side, as a JPEG of this quality. */
  const MAX_SIDE = 1600;
  const JPEG_QUALITY = 0.8;
  /** The storage module's limit for a file of the app (renox.toml `max_upload_bytes`; lib/visit-data.ts MAX_PHOTO_BYTES). */
  const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
  /** The reasons that say something about the photo itself: they do not stop the other actions of its job. */
  const PHOTO_CONTENT = ["too_large", "unsupported_type", "invalid"];

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

  /**
   * The jobs that send nothing more: a job of the user with an action the server refused, or (when the photos are
   * given) with a photo the server refused for the job's sake, not for the photo's.
   */
  const blockedJobs = (records, userId, photos) => {
    const blocked = new Set(inState(records, "refused").filter((r) => r.user_id === userId).map((r) => r.job_id));
    for (const p of photos || []) if (p.state === "refused" && p.user_id === userId && !PHOTO_CONTENT.includes(p.refused_reason)) blocked.add(p.job_id);
    return blocked;
  };

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
  const behindRefused = (records, userId, photos) => {
    const blocked = blockedJobs(records, userId, photos);
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


  // ---- photos (#809) ----

  const byTaken = (a, b) => a.taken_at - b.taken_at || a.id - b.id;

  /** How many photos wait on the device (any account: the limit is the device's). */
  const pendingPhotos = (photos) => photos.filter((p) => p.state === "pending").length;

  /** Whether a device holding `pending` photos takes one more. */
  const canTakePhoto = (pending) => pending < PHOTO_LIMIT;

  /**
   * Whether the phone has room for a photo: `estimate` is what `navigator.storage.estimate()` answers
   * (`{ quota, usage }`); a browser that does not say is taken to have room.
   */
  const hasRoom = (estimate) => {
    if (!estimate || !Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)) return true;
    return estimate.quota - estimate.usage >= MIN_FREE_BYTES;
  };

  /** The size an image of `width` x `height` is sent at: its long side at most MAX_SIDE; `resize` says whether it changed. */
  const fitSize = (width, height) => {
    const long = Math.max(width, height);
    if (!(long > MAX_SIDE)) return { width, height, resize: false };
    const k = MAX_SIDE / long;
    return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), resize: true };
  };

  /** Whether a photo of `size` bytes is over what the server takes. */
  const tooLarge = (size) => size > MAX_PHOTO_BYTES;

  /** The photos of one state, in the order they were taken. */
  const shots = (photos, state) => photos.filter((p) => p.state === state).sort(byTaken);

  /** What the device holds of photos, seen from the signed-in user: theirs waiting (in order), how many wait for other accounts, theirs refused. */
  const splitPhotos = (photos, userId) => {
    const pending = shots(photos, "pending");
    return {
      mine: pending.filter((p) => p.user_id === userId),
      other: pending.filter((p) => p.user_id !== userId).length,
      refused: shots(photos, "refused").filter((p) => p.user_id === userId),
    };
  };

  /**
   * The user's waiting actions and photos in the order they go to the server: the actions strictly in `seq` order,
   * each photo right before the first action made after it (`taken_at` before `performed_at`; at the same
   * millisecond the action goes first), the photos among themselves by `taken_at`. `held` lists the ids of photos
   * the page still lets the technician caption: they wait.
   */
  const merge = (records, photos, userId, held) => {
    const keep = new Set(held || []);
    const actions = split(records, userId).mine;
    const waiting = splitPhotos(photos, userId).mine.filter((p) => !keep.has(p.id));
    const out = [];
    let i = 0;
    for (const a of actions) {
      while (i < waiting.length && waiting[i].taken_at < a.performed_at) out.push({ kind: "photo", record: waiting[i++] });
      out.push({ kind: "action", record: a });
    }
    while (i < waiting.length) out.push({ kind: "photo", record: waiting[i++] });
    return out;
  };

  /** What to send next, an action or a photo: the first of `merge` whose job is not blocked (`also`: jobs refused during this run). Null when none. */
  const nextItem = (records, photos, userId, also, held) => {
    const blocked = blockedJobs(records, userId, photos);
    for (const j of also || []) blocked.add(j);
    return merge(records, photos, userId, held).find((item) => !blocked.has(item.record.job_id)) || null;
  };

  /** The text a refusal carries: a `message` (the upload actions), else the form's reason, else the first error. */
  const messageOf = (body) => {
    if (typeof body.message === "string") return body.message;
    const errors = body.errors && typeof body.errors === "object" ? body.errors : {};
    const first = errors.form || Object.values(errors).find((v) => typeof v === "string");
    return typeof first === "string" ? first : "";
  };

  /**
   * What an answer means for one of the three requests of a photo. `step` is "url" (the page action `photo_url`),
   * "put" (the signed PUT, which answers 201 and `{ key }`) or "post" (the `photo` action). The "url" step may answer `{ done: true }`: the photo is on the server already. `answer` is
   * `{ status, body }` or null (no answer); for "url" it may carry `signedIn: true`: the page checked that the user
   * still is signed in, so a 403 is the job's (it is not the visit's technician any more), not a lost session.
   *  - continue: the step worked, go to the next one. ok: the photo is on the server.
   *  - refused: `reason`, `message`, and `stop`: "none" (a photo that is wrong) or "job" (the job's state).
   *  - auth: sign in again. retry: no answer, a 5xx, or a signed URL the store did not take: try again later.
   */
  const photoOutcomeOf = (step, answer) => {
    if (answer === null || answer === undefined) return { kind: "retry" };
    const { status } = answer;
    const body = answer.body && typeof answer.body === "object" ? answer.body : {};
    const done = step === "url" ? status === 200 && (typeof body.url === "string" || body.done === true) : step === "put" ? status === 201 && typeof body.key === "string" : status === 200 && body.ok === true;
    if (done) return step === "post" ? { kind: "ok", adjusted: body.time_adjusted === true } : { kind: "continue" };
    if (status >= 500 || status === 408 || status === 429 || status === 200 || status === 201) return { kind: "retry" };
    if (step === "put" && (status === 401 || status === 403)) return { kind: "retry" };
    const message = messageOf(body);
    if (status === 401) return { kind: "auth" };
    if (status === 403) return step === "url" && answer.signedIn === true ? { kind: "refused", reason: "forbidden", message, stop: "job" } : { kind: "auth" };
    if (status === 413) return { kind: "refused", reason: "too_large", message, stop: "none" };
    if (status === 415) return { kind: "refused", reason: "unsupported_type", message, stop: "none" };
    if (status === 422) return { kind: "refused", reason: "invalid", message, stop: "none" };
    if (status === 409) return { kind: "refused", reason: typeof body.conflict === "string" ? body.conflict : "conflict", message, stop: "job" };
    return { kind: "refused", reason: `http_${status}`, message, stop: "job" };
  };

  /**
   * One photo, as three requests in a row; stops at the first that is not a success. `io` does the requests:
   * `signed(photo)`, `put(photo, url)` and `post(photo, key)`, each answering `{ status, body }` or null.
   * Answers the outcome of the step that ended it (`ok` when all three worked).
   */
  const sendPhoto = async (photo, io) => {
    const signed = await io.signed(photo);
    const first = photoOutcomeOf("url", signed);
    if (first.kind !== "continue") return first;
    // The server has this photo already (a queue sent again, #810): no second upload, the `photo` action answers what it stored.
    if (signed.body && signed.body.done === true) return photoOutcomeOf("post", await io.post(photo, ""));
    // The signed URL is new for each try, so a repeated PUT (after a crash, or an answer that never arrived) stores
    // the file under a new key and leaves the first one unreferenced: the `photo` action is idempotent by action_id
    // (#806), the orphan object is the open issue #833 (no sweep of unreferenced storage/<visit>/ files exists yet).
    const stored = await io.put(photo, signed.body.url);
    const second = photoOutcomeOf("put", stored);
    if (second.kind !== "continue") return second;
    return photoOutcomeOf("post", await io.post(photo, stored.body.key));
  };

  /** The changes to store on a photo after its outcome, and what the run does next ("none", "job" or "all"), as `settle` does for an action. */
  const settlePhoto = (photo, outcome) => {
    switch (outcome.kind) {
      case "ok":
        return { patch: { state: "uploaded" }, stop: "none" };
      case "refused": {
        const patch = { state: "refused", refused_reason: outcome.reason };
        if (outcome.message) patch.refused_message = outcome.message;
        return { patch, stop: outcome.stop };
      }
      case "auth":
        return { patch: {}, stop: "all" };
      default:
        return { patch: { attempts: (photo.attempts || 0) + 1 }, stop: "all" };
    }
  };

  /**
   * `replay` for actions and photos: the plan over the records in memory. `send(action)` answers `{ status, body }`
   * or null as in `replay`; `sendOne(photo)` answers a photo's outcome (what `sendPhoto` answers). Returns what
   * changed, in the order it happened: `{ kind, id, outcome, patch }` (`id` is the `seq` of an action, the `id` of a photo).
   */
  const replayAll = async (records, photos, userId, send, sendOne) => {
    const copy = records.map((r) => ({ ...r }));
    const pics = photos.map((p) => ({ ...p }));
    const log = [];
    const also = [];
    for (;;) {
      const item = nextItem(copy, pics, userId, also);
      if (item === null) return { log, stopped: "done", records: copy, photos: pics };
      let outcome;
      let result;
      if (item.kind === "action") {
        outcome = outcomeOf(await send(item.record));
        result = settle(item.record, outcome);
      } else {
        outcome = await sendOne(item.record);
        result = settlePhoto(item.record, outcome);
      }
      Object.assign(item.record, result.patch);
      log.push({ kind: item.kind, id: item.kind === "action" ? item.record.seq : item.record.id, outcome: outcome.kind, patch: result.patch });
      if (result.stop === "all") return { log, stopped: outcome.kind, records: copy, photos: pics };
      if (result.stop === "job") also.push(item.record.job_id);
    }
  };

  // ---- "Needs attention" (#810) ----

  /** The refusals "Try again" is offered for: the job was given to another technician (an undone reassignment), or a form the server found wrong (422). */
  const RETRY_REASONS = ["job_reassigned", "invalid", "forbidden"];
  /** The conflict codes of the server (lib/visits.ts): each has its text in the page (`visits.conflict.<code>`). */
  const CONFLICTS = ["job_cancelled", "job_reassigned", "already_checked_out", "not_checked_in", "action_id_taken"];

  /** What the technician reads for one saved action or photo: the key of its name and the values that go into it. */
  const whatOf = (kind, record) => {
    if (kind === "photo") return { key: record.phase === "after" ? "whatPhotoAfter" : "whatPhotoBefore", values: {} };
    const fields = record.fields || {};
    const name = `what${String(record.action).charAt(0).toUpperCase()}${String(record.action).slice(1)}`;
    return { key: name, values: { description: fields.description || "", qty: fields.qty || "" } };
  };

  /** One line of the list for a record: what it was, when it was done on the phone, and why it is here. */
  const itemOf = (kind, record, state) => ({
    kind,
    id: kind === "photo" ? record.id : record.seq,
    key: `${kind}:${kind === "photo" ? record.id : record.seq}`,
    what: whatOf(kind, record),
    at: kind === "photo" ? record.taken_at : record.performed_at,
    state,
    reason: state === "refused" ? record.refused_reason || "conflict" : "",
    message: state === "refused" ? record.refused_message || "" : "",
  });

  /**
   * What "Needs attention" lists for the signed-in user, per job: the actions and photos the server refused
   * (`state: "refused"`), and the ones that wait behind a refusal of their job and were not sent (`state: "behind"`).
   * A group is `{ job_id, number, customer, items, blocked, later, retry }`: `later` says the queue stopped the
   * job with steps still unsent; `retry` says "Try again" is offered (every refusal is a `RETRY_REASONS`).
   * Jobs are in the order of their earliest item; the items of a job in the order they were done.
   */
  const attention = (records, photos, userId) => {
    const blocked = blockedJobs(records, userId, photos);
    const groups = new Map();
    const group = (record) => {
      let g = groups.get(record.job_id);
      if (!g) {
        g = { job_id: record.job_id, number: "", customer: "", items: [], blocked: blocked.has(record.job_id), later: false, retry: false };
        groups.set(record.job_id, g);
      }
      if (!g.number && record.job_number) g.number = String(record.job_number);
      if (!g.customer && record.customer) g.customer = String(record.customer);
      return g;
    };
    for (const r of inState(records, "refused").filter((x) => x.user_id === userId)) group(r).items.push(itemOf("action", r, "refused"));
    for (const p of shots(photos || [], "refused").filter((x) => x.user_id === userId)) group(p).items.push(itemOf("photo", p, "refused"));
    for (const r of split(records, userId).mine.filter((x) => blocked.has(x.job_id))) group(r).items.push(itemOf("action", r, "behind"));
    for (const p of splitPhotos(photos || [], userId).mine.filter((x) => blocked.has(x.job_id))) group(p).items.push(itemOf("photo", p, "behind"));
    const out = [...groups.values()];
    for (const g of out) {
      g.items.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
      const refused = g.items.filter((i) => i.state === "refused");
      g.later = g.blocked && g.items.some((i) => i.state === "behind");
      g.retry = refused.length > 0 && refused.every((i) => RETRY_REASONS.includes(i.reason));
    }
    return out.sort((a, b) => (a.items[0] ? a.items[0].at : 0) - (b.items[0] ? b.items[0].at : 0) || (a.job_id < b.job_id ? -1 : 1));
  };

  /** How many saved actions and photos of the user are not sent: waiting, refused, or behind a refusal (the sign-out warning's number). */
  const unsent = (records, photos, userId) => {
    const a = split(records, userId);
    const p = splitPhotos(photos || [], userId);
    return a.mine.length + a.refused.length + p.mine.length + p.refused.length;
  };

  /** A value in HTML text or in a quoted attribute. */
  const esc = (v) =>
    String(v)
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;")
      .replace(/"/gu, "&quot;")
      .replace(/'/gu, "&#39;");

  /** "reason_x" -> the key of the page's text for it. */
  const camel = (code) => String(code).replace(/_([a-z])/gu, (all, c) => c.toUpperCase());

  /** The reason of an item in plain words. `t(key, values)` gives the page's text for a key ("" when it has none). */
  const reasonText = (item, t) => {
    if (item.state === "behind") return t("behind");
    const message = item.message;
    const reason = item.reason === "forbidden" ? "job_reassigned" : item.reason;
    if (CONFLICTS.includes(reason)) return t(`reason${camel(`_${reason}`)}`) || message || reason;
    if (reason === "invalid_record") return t("reasonInvalidRecord");
    if (reason === "invalid") return message ? t("reasonInvalid", { message }) : t("reasonGeneric");
    return message ? t("reasonOther", { message }) : t("reasonGeneric");
  };

  /** The digits of a phone number for a `tel:` link (a leading + and digits only); "" when there are none. */
  const telOf = (phone) => {
    const m = /^\s*(\+?)([0-9 ()\-.]*)$/u.exec(String(phone || ""));
    if (m === null) return "";
    const digits = m[2].replace(/[^0-9]/gu, "");
    return digits === "" ? "" : `${m[1]}${digits}`;
  };

  /**
   * The markup of the "Needs attention" list for these groups. `t(key, values)` gives the page's text for a key.
   * `phone` is the office's number ("" hides "Call the office"); `confirming` is the job whose Discard waits for
   * its answer (an in-page question: browser dialogs are not used).
   */
  const attentionHtml = (groups, t, options) => {
    const phone = telOf(options && options.phone);
    const confirming = options && options.confirming;
    return groups
      .map((g) => {
        const id = esc(g.job_id);
        const name = g.number ? `<span dir="ltr">${esc(g.number)}</span>` : `<span>${esc(t("unknownJob", { job: g.job_id }))}</span>`;
        const who = g.customer ? ` · <bdi>${esc(g.customer)}</bdi>` : "";
        const items = g.items
          .map((i) => {
            const what = t(i.what.key, i.what.values);
            return `<li data-attention-item="${esc(i.key)}" data-attention-state="${i.state}"><strong dir="auto">${esc(what)}</strong> · <small>${esc(t("doneAt", { time: dubai(i.at) }))}</small><p class="attention-reason">${esc(reasonText(i, t))}</p></li>`;
          })
          .join("");
        const later = g.later ? `<p class="muted" data-attention-later>${esc(t("later"))}</p>` : "";
        const buttons =
          confirming === g.job_id
            ? `<div class="attention-actions" role="group" aria-labelledby="attention-${id}-ask" data-attention-confirm><p id="attention-${id}-ask">${esc(g.items.length === 1 ? t("discardConfirmOne") : t("discardConfirm", { n: g.items.length }))}</p><button type="button" data-attention="discard-yes" data-job="${id}">${esc(t("discardYes"))}</button><button type="button" data-attention="discard-no" data-job="${id}">${esc(t("discardNo"))}</button></div>`
            : `<div class="attention-actions"><button type="button" data-attention="discard" data-job="${id}">${esc(t("discard"))}</button>${g.retry ? `<button type="button" data-attention="retry" data-job="${id}">${esc(t("retry"))}</button>` : ""}${phone ? `<a href="tel:${esc(phone)}" data-attention="call">${esc(t("call"))}</a>` : ""}</div>`;
        return `<article class="attention-job" id="attention-${id}" data-attention-job="${id}" aria-labelledby="attention-${id}-h"><h3 id="attention-${id}-h">${name}${who}</h3>${later}<ul>${items}</ul>${buttons}</article>`;
      })
      .join("");
  };

  /** "2026-11-14 10:42": the Dubai time of a unix ms, as the pages show a visit's times (Dubai is UTC+4 all year). */
  const dubai = (ms) => {
    const d = new Date(ms + 4 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };

  /** A text with `{name}` placeholders filled in. */
  const fill = (text, values) => String(text).replace(/\{(\w+)\}/gu, (all, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : all));

  return { LIMIT, OLD_MS, BACKOFF_MS, POLL_MS, PHOTO_LIMIT, MIN_FREE_BYTES, MAX_SIDE, JPEG_QUALITY, MAX_PHOTO_BYTES, PHOTO_CONTENT, ACTIONS, actionIdOf, backoffMs, canQueue, isOld, targetOf, split, blockedJobs, nextAction, behindRefused, outcomeOf, settle, retryAt, replay, pendingPhotos, canTakePhoto, hasRoom, fitSize, tooLarge, splitPhotos, merge, nextItem, photoOutcomeOf, sendPhoto, settlePhoto, replayAll, RETRY_REASONS, attention, unsent, attentionHtml, reasonText, telOf, esc, dubai, fill };
});
