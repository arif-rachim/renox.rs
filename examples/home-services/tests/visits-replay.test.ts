// The visit page's actions are idempotent by `action_id` and answer a conflict with its reason (#806, wave C,
// the server half of the technician's offline queue): each action posted twice with one id changes the
// database once and answers the same body; another technician's id is a 409; the job's state (cancelled,
// reassigned, checked out, not checked in) refuses a late action with its code and changes nothing; a second
// check-in is a success; `performed_at` counts only when plausible; a post without an id is as it was
// (tests/visits.test.ts); the daily sweep drops the rows older than 30 days.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

import ar from "../i18n/ar.json";
import en from "../i18n/en.json";
import { base64Of, solidPng } from "../lib/placeholder-png";
import { OFFLINE_REFUSED, refusalOf } from "../lib/refusal";

/** "HH:MM" in Dubai (UTC+4) of unix seconds, as lib/booking-sync.ts `clock` prints it. */
const clock = (seconds: number): string => new Date(seconds * 1000 + 4 * 3_600_000).toISOString().slice(11, 16);

const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string) {
  const u = t.as(jar);
  expect((await u.action("/auth/login", "default", { email, password: PASSWORD, next: "/me" })).status).toBe(303);
  return u;
}

const ali = await signIn("ali", "ali.dubai@fixit.example");
const bilal = await signIn("bilal", "bilal.dubai@fixit.example");
type User = typeof ali;

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);
const count = (sql: string, params: (string | number | null)[] = []): number => Number(rows(sql, params)[0]?.n);
const rw = <T>(f: (db: Database) => T): T => {
  const db = new Database(t.dbFile);
  db.exec("pragma busy_timeout = 5000");
  try {
    return f(db);
  } finally {
    db.close();
  }
};
const visitOf = (jobId: string) => rows("select * from app__visits where job_id = ?", [jobId])[0] as Record<string, unknown> | undefined;
const jobOf = (id: string) => rows("select * from app__jobs where id = ?", [id])[0] as Record<string, unknown>;

let serial = 0;
/** A scheduled job of Ali's in Dubai of its own (a copy of the seed's jb_seed_10), so a test never meets another's state. */
function newJob(technician = "u_dxb_ali"): string {
  serial += 1;
  const id = `jb_replay_${serial}`;
  rw((db) =>
    db.run(
      "insert into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at, source) select ?, branch_id, customer_id, site_id, null, ?, 'scheduled', priority, service_id, description, scheduled_start, scheduled_end, ?, null, created_by, created_at, updated_at, source from app__jobs where id = 'jb_seed_10'",
      [id, `J-9${String(serial).padStart(5, "0")}`, technician],
    ),
  );
  return id;
}

const ids = (n: number): string => `replay-${String(n).padStart(4, "0")}-abcdefghij`;
let nextId = 0;
const fresh = (): string => ids(++nextId);

type Body = { ok: boolean; status: number; redirect?: string; errors?: Record<string, string>; conflict?: string; time_adjusted?: boolean };
type Posted = { status: number; body: Body; raw: string };

/** A JSON post of a visit action, as the offline queue sends it. */
async function post(u: User, jobId: string, action: string, form: Record<string, string>, accept = "application/json"): Promise<Posted> {
  const res = await u.request("POST", `/me/visits/${jobId}?/${action}`, {
    headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": u.cookie("__Host-renox_csrf") ?? "", accept },
    body: new URLSearchParams(form).toString(),
  });
  return { status: res.status, body: accept === "application/json" ? res.json<Body>() : ({} as Body), raw: res.html };
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const headers = init?.headers as Record<string, string> | undefined;
  if (headers?.["x-test-binary"] !== undefined && typeof init?.body === "string") {
    const { "x-test-binary": _binary, ...rest } = headers;
    return realFetch(input, { ...init, headers: rest, body: Uint8Array.from(init.body, (c) => c.charCodeAt(0)) });
  }
  return realFetch(input, init);
}) as typeof fetch;

/** Step one and the PUT of a photo, as `public/upload.js` does them; answers the stored key. */
async function uploadPhoto(u: User, jobId: string, rgb: [number, number, number]): Promise<string> {
  const png = solidPng(rgb, 16).bytes;
  const signed = await u.action(`/me/visits/${jobId}`, "photo_url", { name: "leak.png", type: "image/png", size: String(png.length) });
  expect(signed.status).toBe(200);
  const put = await u.request("PUT", signed.json<{ url: string }>().url, { body: Array.from(png, (b) => String.fromCharCode(b)).join(""), headers: { "content-type": "image/png", "x-test-binary": "1" } });
  expect(put.status).toBe(201);
  return put.json<{ key: string }>().key;
}
const PNG = (rgb: [number, number, number]) => `data:image/png;base64,${base64Of(solidPng(rgb, 12).bytes)}`;

/** The rows a visit action may change, for "nothing changed". */
const state = (jobId: string) => ({
  visits: count("select count(*) as n from app__visits"),
  photos: count("select count(*) as n from app__visit_photos"),
  parts: count("select count(*) as n from app__visit_parts"),
  events: count("select count(*) as n from app__job_events"),
  job: jobOf(jobId).status,
  visit: visitOf(jobId) ?? null,
});

describe("one action_id, one change", () => {
  const job = newJob();
  const action = { checkin: fresh(), photo: fresh(), part: fresh(), removePart: fresh(), notes: fresh(), signature: fresh(), checkout: fresh(), summary: fresh() };

  /** Posts twice: the second changes nothing and answers the same body. */
  async function twice(name: keyof typeof action, form: Record<string, string>, changes: () => unknown): Promise<Body> {
    const first = await post(ali, job, name, { ...form, action_id: action[name] });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, status: 200, redirect: `/me/visits/${job}` });
    const after = changes();
    const second = await post(ali, job, name, { ...form, action_id: action[name] });
    expect(second.raw).toBe(first.raw);
    expect(second.status).toBe(200);
    expect(changes()).toEqual(after);
    expect(rows("select action, user_id, visit_job_id, status from app__action_log where action_id = ?", [action[name]])).toEqual([{ action: name, user_id: "u_dxb_ali", visit_job_id: job, status: 200 }]);
    return second.body;
  }

  test("checkin", async () => {
    await twice("checkin", { lat: "25.1", lng: "55.2" }, () => [count("select count(*) as n from app__visits where job_id = ?", [job]), count("select count(*) as n from app__job_events where job_id = ?", [job])]);
    expect(count("select count(*) as n from app__visits where job_id = ?", [job])).toBe(1);
    expect(count("select count(*) as n from app__job_events where job_id = ?", [job])).toBe(1);
    expect(jobOf(job).status).toBe("in_progress");
  });

  test("photo", async () => {
    const key = await uploadPhoto(ali, job, [9, 90, 190]);
    await twice("photo", { phase: "before", key, caption: "Leak" }, () => count("select count(*) as n from app__visit_photos"));
    expect(rows("select phase, caption, file_key from app__visit_photos where visit_id = ?", [String(visitOf(job)?.id)])).toEqual([{ phase: "before", caption: "Leak", file_key: key }]);
  });

  test("photo_url with the id of a photo that was accepted answers done, and no URL, to its own technician only (#810)", async () => {
    const key = await uploadPhoto(ali, job, [90, 9, 190]);
    const id = fresh();
    expect((await post(ali, job, "photo", { phase: "after", key, caption: "Dry", action_id: id })).status).toBe(200);
    const ask = (u: User, action_id: string) => u.action(`/me/visits/${job}`, "photo_url", { name: "x.png", type: "image/png", size: "10", action_id });
    const mine = await ask(ali, id);
    expect(mine.status).toBe(200);
    expect(mine.json()).toEqual({ done: true });
    // An id that was never accepted, an id of another action, and another technician's ask are the ordinary step one.
    expect(typeof (await ask(ali, fresh())).json<{ url?: string }>().url).toBe("string");
    expect((await ask(bilal, id)).status).toBe(403);
  });

  test("part, then removePart", async () => {
    await twice("part", { description: "Hose", qty: "2", price: "12.50" }, () => count("select count(*) as n from app__visit_parts"));
    const mine = () => count("select count(*) as n from app__visit_parts where visit_id = ?", [String(visitOf(job)?.id)]);
    expect(mine()).toBe(1);
    const part = String(rows("select id from app__visit_parts where visit_id = ?", [String(visitOf(job)?.id)])[0]?.id);
    await twice("removePart", { part }, mine);
    expect(mine()).toBe(0);
  });

  test("notes and signature", async () => {
    await twice("notes", { notes: "Replaced the joint." }, () => visitOf(job)?.notes);
    expect(visitOf(job)?.notes).toBe("Replaced the joint.");
    await twice("signature", { signed_by: "Layla", signature: PNG([0, 0, 0]) }, () => [visitOf(job)?.signature_key, count("select count(*) as n from renox__files where key like ?", [`app/visits/${String(visitOf(job)?.id)}/%`])]);
    expect(visitOf(job)?.signed_by_name).toBe("Layla");
  });

  test("checkout, then the summary (the one action that is still allowed afterwards)", async () => {
    await twice("checkout", {}, () => [visitOf(job)?.checkout_at, count("select count(*) as n from app__job_events where job_id = ?", [job]), jobOf(job).status]);
    expect(jobOf(job).status).toBe("done");
    expect(count("select count(*) as n from app__job_events where job_id = ?", [job])).toBe(2);
    await twice("summary", { summary_en: "Fixed.", summary_ar: "تم." }, () => [visitOf(job)?.summary_en, visitOf(job)?.summary_ar]);
    expect(visitOf(job)).toMatchObject({ summary_en: "Fixed.", summary_ar: "تم." });
  });

  test("another technician's post with the same id is a 409 action_id_taken and changes nothing", async () => {
    const before = state(job);
    const taken = await post(bilal, job, "notes", { notes: "Mine now.", action_id: action.notes });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ ok: false, status: 409, conflict: "action_id_taken" });
    expect(taken.body.errors?.form).toBe(en.visits.conflict.action_id_taken);
    expect(state(job)).toEqual(before);
    expect(rows("select user_id from app__action_log where action_id = ?", [action.notes])).toEqual([{ user_id: "u_dxb_ali" }]);
    // The form post is the text of the refusal (the page is not Bilal's to see).
    const form = await post(bilal, job, "notes", { notes: "Mine now.", action_id: action.notes }, "text/html");
    expect(form.status).toBe(409);
    expect(form.raw).toBe(en.visits.conflict.action_id_taken);
  });

  test("an action id that is not 16 to 64 of A-Z a-z 0-9 _ - is a 422", async () => {
    const before = state(job);
    for (const bad of ["short", "has space has space!!", "x".repeat(65)]) {
      const r = await post(ali, job, "notes", { notes: "x", action_id: bad });
      expect(r.status).toBe(422);
      expect(r.body.ok).toBe(false);
      expect(r.body.errors?.form).toBe(en.visits.err.action_id);
    }
    expect(state(job)).toEqual(before);
  });
});

describe("a conflict is refused with its reason, in the same transaction, and nothing changes", () => {
  const refused = async (u: User, job: string, action: string, form: Record<string, string>, code: string) => {
    const before = { ...state(job), log: count("select count(*) as n from app__action_log where action_id = ?", [""]) };
    const id = fresh();
    const r = await post(u, job, action, { ...form, action_id: id });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, status: 409, conflict: code });
    expect(r.body.errors?.form).toBe((en.visits.conflict as Record<string, string>)[code]);
    expect({ ...state(job), log: before.log }).toEqual(before);
    // A refusal is not stored: the same id posted again is checked again, and refused the same way.
    expect((await post(u, job, action, { ...form, action_id: id })).raw).toBe(r.raw);
    expect(count("select count(*) as n from app__action_log where action_id = ?", [id])).toBe(0);
    return id;
  };

  test("job_cancelled: the office cancelled the job meanwhile", async () => {
    const job = newJob();
    expect((await post(ali, job, "checkin", { action_id: fresh() })).status).toBe(200);
    rw((db) => db.run("update app__jobs set status = 'cancelled' where id = ?", [job]));
    await refused(ali, job, "part", { description: "Hose", qty: "1", price: "5" }, "job_cancelled");
    await refused(ali, job, "checkout", {}, "job_cancelled");
    expect(count("select count(*) as n from app__visit_parts where visit_id = ?", [String(visitOf(job)?.id)])).toBe(0);
  });

  test("job_cancelled before the check-in too", async () => {
    const job = newJob();
    rw((db) => db.run("update app__jobs set status = 'cancelled' where id = ?", [job]));
    await refused(ali, job, "checkin", {}, "job_cancelled");
    expect(visitOf(job)).toBeUndefined();
  });

  test("job_reassigned: the job is another technician's now", async () => {
    const job = newJob();
    expect((await post(ali, job, "checkin", { action_id: fresh() })).status).toBe(200);
    rw((db) => db.run("update app__jobs set technician_user_id = 'u_dxb_bilal' where id = ?", [job]));
    await refused(ali, job, "notes", { notes: "late" }, "job_reassigned");
    expect(visitOf(job)?.notes).toBe("");
    const other = newJob("u_dxb_bilal");
    await refused(ali, other, "checkin", {}, "job_reassigned");
    expect(visitOf(other)).toBeUndefined();
    const form = await post(ali, other, "checkin", { action_id: fresh() }, "text/html");
    expect(form.status).toBe(409);
    expect(form.raw).toBe(en.visits.conflict.job_reassigned);
  });

  test("a refused id is accepted once the job allows it again (Try again after the reassignment is undone)", async () => {
    const job = newJob();
    expect((await post(ali, job, "checkin", { action_id: fresh() })).status).toBe(200);
    rw((db) => db.run("update app__jobs set technician_user_id = 'u_dxb_bilal' where id = ?", [job]));
    const id = await refused(ali, job, "notes", { notes: "from the van" }, "job_reassigned");
    rw((db) => db.run("update app__jobs set technician_user_id = 'u_dxb_ali' where id = ?", [job]));
    const again = await post(ali, job, "notes", { notes: "from the van", action_id: id });
    expect(again.status).toBe(200);
    expect(visitOf(job)?.notes).toBe("from the van");
    expect((await post(ali, job, "notes", { notes: "from the van", action_id: id })).raw).toBe(again.raw);
  });

  test("already_checked_out: anything but the summary after the check-out", async () => {
    const job = newJob();
    expect((await post(ali, job, "checkin", { action_id: fresh() })).status).toBe(200);
    expect((await post(ali, job, "checkout", { action_id: fresh() })).status).toBe(200);
    await refused(ali, job, "photo", { phase: "before", key: "storage/vs_0000000000000000/a.png" }, "already_checked_out");
    await refused(ali, job, "part", { description: "Hose", qty: "1", price: "5" }, "already_checked_out");
    await refused(ali, job, "notes", { notes: "late" }, "already_checked_out");
    await refused(ali, job, "checkout", {}, "already_checked_out");
    await refused(ali, job, "checkin", {}, "already_checked_out");
    const summary = await post(ali, job, "summary", { summary_en: "Done.", summary_ar: "تم.", action_id: fresh() });
    expect(summary.status).toBe(200);
  });

  test("not_checked_in: an action before the visit row exists", async () => {
    const job = newJob();
    for (const [action, form] of [
      ["part", { description: "Hose", qty: "1", price: "5" }],
      ["notes", { notes: "early" }],
      ["checkout", {}],
      ["summary", { summary_en: "x", summary_ar: "y" }],
    ] as const) await refused(ali, job, action, form, "not_checked_in");
    expect(visitOf(job)).toBeUndefined();
    expect(jobOf(job).status).toBe("scheduled");
  });

  test("the page without scripts: the conflict is the page again with its message, and the Arabic texts exist for every code", async () => {
    const job = newJob();
    rw((db) => db.run("update app__jobs set status = 'cancelled' where id = ?", [job]));
    const res = await post(ali, job, "checkin", { action_id: fresh() }, "text/html");
    expect(res.status).toBe(409);
    expect(res.raw).toContain(en.visits.conflict.job_cancelled);
    expect(res.raw).toContain('id="form-errors"');
    expect(Object.keys(ar.visits.conflict).sort()).toEqual(Object.keys(en.visits.conflict).sort());
    expect(ar.visits.err.action_id).toBeString();
  });

  test("a job of another day is no conflict (a late sync of yesterday's visit)", async () => {
    const job = newJob();
    rw((db) => db.run("update app__jobs set scheduled_start = scheduled_start - 86400 * 3, scheduled_end = scheduled_end - 86400 * 3 where id = ?", [job]));
    expect((await post(ali, job, "checkin", { action_id: fresh() })).status).toBe(200);
    expect(visitOf(job)).toBeDefined();
  });
});

describe("a second check-in is a success", () => {
  test("two check-ins with different ids make one visit, and the second answers ok", async () => {
    const job = newJob();
    const first = await post(ali, job, "checkin", { action_id: fresh() });
    const visit = visitOf(job);
    const events = count("select count(*) as n from app__job_events where job_id = ?", [job]);
    const second = await post(ali, job, "checkin", { action_id: fresh() });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, redirect: `/me/visits/${job}` });
    expect(count("select count(*) as n from app__visits where job_id = ?", [job])).toBe(1);
    expect(visitOf(job)).toEqual(visit);
    expect(count("select count(*) as n from app__job_events where job_id = ?", [job])).toBe(events);
  });
});

describe("performed_at", () => {
  const near = (seconds: unknown, expected: number, within = 30): boolean => Math.abs(Number(seconds) - expected) <= within;

  test("in range it is the check-in's and the check-out's time, and the job events'", async () => {
    const job = newJob();
    const inAnHour = Date.now() - 3_600_000;
    const checkin = await post(ali, job, "checkin", { action_id: fresh(), performed_at: String(inAnHour) });
    expect(checkin.body.time_adjusted).toBeUndefined();
    expect(visitOf(job)?.checkin_at).toBe(Math.floor(inAnHour / 1000));
    expect(rows("select at from app__job_events where job_id = ? order by id", [job]).map((r) => r.at)).toEqual([Math.floor(inAnHour / 1000)]);
    const later = Date.now() - 60_000;
    const checkout = await post(ali, job, "checkout", { action_id: fresh(), performed_at: String(later) });
    expect(checkout.body.time_adjusted).toBeUndefined();
    expect(visitOf(job)?.checkout_at).toBe(Math.floor(later / 1000));
    expect(rows("select at from app__job_events where job_id = ? order by id desc limit 1", [job])[0]?.at).toBe(Math.floor(later / 1000));
  });

  test("a clock a minute ahead is within the skew", async () => {
    const job = newJob();
    const ahead = Date.now() + 60_000;
    const r = await post(ali, job, "checkin", { action_id: fresh(), performed_at: String(ahead) });
    expect(r.body.time_adjusted).toBeUndefined();
    expect(visitOf(job)?.checkin_at).toBe(Math.floor(ahead / 1000));
  });

  test("in the future (an hour) or four days old is replaced by the server's time, and the result says so", async () => {
    for (const [name, at] of [["future", Date.now() + 3_600_000], ["old", Date.now() - 4 * 86_400_000], ["not a number", "yesterday"]] as const) {
      const job = newJob();
      const inId = fresh();
      const r = await post(ali, job, "checkin", { action_id: inId, performed_at: String(at) });
      expect(r.status).toBe(200);
      expect(r.body.time_adjusted, name).toBe(true);
      expect(near(visitOf(job)?.checkin_at, Math.floor(Date.now() / 1000)), name).toBe(true);
      const out = await post(ali, job, "checkout", { action_id: fresh(), performed_at: String(at) });
      expect(out.body.time_adjusted, name).toBe(true);
      expect(near(visitOf(job)?.checkout_at, Math.floor(Date.now() / 1000)), name).toBe(true);
      // The replay says it too: it is the stored result.
      expect(rows("select result from app__action_log where action_id = ?", [inId])[0]?.result).toContain('"time_adjusted":true');
      expect((await post(ali, job, "checkin", { action_id: inId })).body.time_adjusted).toBe(true);
    }
  });

  test("the server's receive time is kept in the log", async () => {
    const job = newJob();
    const id = fresh();
    await post(ali, job, "checkin", { action_id: id, performed_at: String(Date.now() - 3_600_000) });
    expect(near(rows("select created_at from app__action_log where action_id = ?", [id])[0]?.created_at, Math.floor(Date.now() / 1000))).toBe(true);
  });
});

describe("without an action_id the page is as it was", () => {
  test("a form post is a 303, nothing is logged, and a conflict is not checked", async () => {
    const job = newJob();
    const logged = count("select count(*) as n from app__action_log");
    const res = await ali.action(`/me/visits/${job}`, "checkin", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/me/visits/${job}`);
    expect((await ali.action(`/me/visits/${job}`, "checkin", {})).status).toBe(409);
    expect(count("select count(*) as n from app__action_log")).toBe(logged);
    expect(count("select count(*) as n from app__visits where job_id = ?", [job])).toBe(1);
  });

  test("a refusal that is not a conflict, or a form that is wrong, is not stored: the id can be sent again", async () => {
    const job = newJob();
    const id = fresh();
    expect((await post(ali, job, "checkin", { action_id: fresh(), lat: "25", lng: "55" })).status).toBe(200);
    const bad = await post(ali, job, "part", { description: "", qty: "1", price: "5", action_id: id });
    expect(bad.status).toBe(422);
    expect(bad.body.errors?.description).toBeString();
    expect(count("select count(*) as n from app__action_log where action_id = ?", [id])).toBe(0);
    const good = await post(ali, job, "part", { description: "Hose", qty: "1", price: "5", action_id: id });
    expect(good.status).toBe(200);
    expect(count("select count(*) as n from app__visit_parts where visit_id = ?", [String(visitOf(job)?.id)])).toBe(1);
  });
});

describe("the result is at most 4 KiB", () => {
  test("every stored result fits", () => {
    for (const r of rows("select result from app__action_log")) expect(new TextEncoder().encode(String(r.result)).length).toBeLessThanOrEqual(4096);
  });
});

describe("jobs/action-log-sweep", () => {
  test("deletes a row older than 30 days and keeps a recent one", async () => {
    const day = 86_400;
    const now = Math.floor(Date.now() / 1000);
    rw((db) => {
      const put = db.prepare("insert into app__action_log (action_id, user_id, visit_job_id, action, status, result, created_at) values (?, 'u_dxb_ali', 'jb_seed_10', 'notes', 200, '{}', ?)");
      put.run("sweep-old-0000000001", now - 31 * day);
      put.run("sweep-new-0000000001", now - 29 * day);
    });
    await t.job("action-log-sweep");
    expect(count("select count(*) as n from app__action_log where action_id = 'sweep-old-0000000001'")).toBe(0);
    expect(count("select count(*) as n from app__action_log where action_id = 'sweep-new-0000000001'")).toBe(1);
  });
});

// -- #810: the office learns that a queued action was refused ---------------------------------------------------------

describe("a refused action the phone's queue replays tells the office (x-hs-queued: 1)", () => {
  /** A replay of the queue: the same post with the header the queue sets on replays only. */
  async function queued(u: User, jobId: string, action: string, form: Record<string, string>, performed = Date.now() - 90_000): Promise<Posted> {
    const res = await u.request("POST", `/me/visits/${jobId}?/${action}`, {
      headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": u.cookie("__Host-renox_csrf") ?? "", accept: "application/json", "x-hs-queued": "1" },
      body: new URLSearchParams({ ...form, action_id: fresh(), performed_at: String(performed) }).toString(),
    });
    return { status: res.status, body: res.json<Body>(), raw: res.html };
  }
  const events = (job: string) => rows("select by_user_id, from_status, to_status, note, at from app__job_events where job_id = ? and note like ? order by id", [job, `${OFFLINE_REFUSED}%`]);
  const notes = (job: string) => rows("select user_id, category, title, link from notifications__items where link = ? and title like '%was refused%' order by id", [`/jobs/${job}`]);

  test("a conflict: one job event with the action, reason, technician and the time on the phone, and one in-app notification for the branch's dispatchers", async () => {
    const job = newJob();
    const number = String(jobOf(job).number);
    expect((await post(ali, job, "checkin", { action_id: fresh() })).status).toBe(200);
    rw((db) => db.run("update app__jobs set status = 'cancelled' where id = ?", [job]));
    const done = Date.now() - 125_000;
    const r = await queued(ali, job, "checkout", {}, done);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, conflict: "job_cancelled" });

    const [event, ...more] = events(job);
    expect(more).toEqual([]);
    expect(event).toMatchObject({ by_user_id: "u_dxb_ali", from_status: null, to_status: null });
    expect(refusalOf(String(event?.note))).toEqual({ action: "checkout", reason: "job_cancelled", technician: "u_dxb_ali", performed_at: Math.floor(done / 1000) });

    const told = notes(job);
    expect(told.map((n) => [n.user_id, n.category, n.link])).toEqual([["u_dxb_dispatcher", "jobs", `/jobs/${job}`]]);
    expect(told[0]?.title).toBe(`Ali Hassan's check-out for ${number}, done offline at ${clock(Math.floor(done / 1000))}, was refused: the job was cancelled`);
    // Nobody of another branch is told.
    expect(count("select count(*) as n from notifications__items where user_id = 'u_shj_dispatcher' and title like '%was refused%'")).toBe(0);
  });

  test("one notification for each job and reason, not for each action; a new reason is told again; the same refusal again adds nothing", async () => {
    const job = newJob();
    rw((db) => db.run("update app__jobs set status = 'cancelled' where id = ?", [job]));
    const first = await queued(ali, job, "checkin", {}, Date.now() - 300_000);
    const second = await queued(ali, job, "notes", { notes: "x" }, Date.now() - 200_000);
    expect([first.status, second.status]).toEqual([409, 409]);
    expect(events(job).map((e) => refusalOf(String(e.note))?.action)).toEqual(["checkin", "notes"]);
    expect(notes(job).length).toBe(1);

    // The very same refusal (same action, reason, technician and time on the phone) is posted again: no new event.
    const when = Date.now() - 100_000;
    await queued(ali, job, "part", { description: "Hose", qty: "1", price: "5" }, when);
    const once = events(job).length;
    const body = new URLSearchParams({ description: "Hose", qty: "1", price: "5", action_id: fresh(), performed_at: String(when) }).toString();
    const again = await ali.request("POST", `/me/visits/${job}?/part`, { headers: { "content-type": "application/x-www-form-urlencoded", "x-renox-csrf": ali.cookie("__Host-renox_csrf") ?? "", accept: "application/json", "x-hs-queued": "1" }, body });
    expect(again.status).toBe(409);
    expect(events(job).length).toBe(once);
    expect(notes(job).length).toBe(1);

    // Another reason on the same job is another notification.
    rw((db) => db.run("update app__jobs set status = 'scheduled', technician_user_id = 'u_dxb_bilal' where id = ?", [job]));
    expect((await queued(ali, job, "checkin", {})).body.conflict).toBe("job_reassigned");
    expect(notes(job).length).toBe(2);
    expect(String(notes(job)[1]?.title)).toContain("was refused: the job was given to another technician");
  });

  test("a post without the header, and one that is accepted, tell nobody", async () => {
    const job = newJob();
    expect((await queued(ali, job, "checkin", {})).status).toBe(200);
    rw((db) => db.run("update app__jobs set status = 'cancelled' where id = ?", [job]));
    expect((await post(ali, job, "notes", { notes: "x", action_id: fresh() })).status).toBe(409);
    expect(events(job)).toEqual([]);
    expect(notes(job)).toEqual([]);
  });

  test("the job page's timeline shows the event, in English and in Arabic", async () => {
    const job = newJob();
    rw((db) => db.run("update app__jobs set status = 'cancelled' where id = ?", [job]));
    const done = Date.now() - 60_000;
    await queued(ali, job, "checkin", {}, done);
    const dispatcher = await signIn("dispatcher-timeline", "dispatcher.dubai@fixit.example");
    const time = clock(Math.floor(done / 1000));
    const en = await dispatcher.page(`/jobs/${job}?lang=en`);
    expect(en.html).toContain(`Offline check-in refused: the job was cancelled (done on the phone at ${time})`);
    expect(en.html).not.toContain(OFFLINE_REFUSED);
    expect(en.html).toContain("Ali Hassan");
    const ar = await dispatcher.page(`/jobs/${job}?lang=ar`);
    expect(ar.html).toContain("رُفض \u2068تسجيل الدخول\u2069 تم دون اتصال");
    expect(ar.html).not.toContain(OFFLINE_REFUSED);
  });

  test("the sentences exist for every action and reason, in both languages", () => {
    for (const lang of [en, ar]) {
      for (const k of ["checkin", "part", "notes", "summary", "signature", "checkout", "photo"]) expect((lang.visits.refused.action as Record<string, string>)[k]).toBeTruthy();
      for (const k of ["job_cancelled", "job_reassigned", "already_checked_out", "not_checked_in"]) expect((lang.visits.refused.reason as Record<string, string>)[k]).toBeTruthy();
      expect(lang.visits.refused.notice).toContain("{technician}");
      expect(lang.visits.refused.event).toContain("{reason}");
    }
  });
});
