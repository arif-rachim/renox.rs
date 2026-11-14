// The technician's offline action queue (#808): the rules of public/offline-queue-core.js (a script with no
// DOM, imported here as it is), the way the three scripts that open the device database agree, and the
// pages that carry the queue (marked forms, the status line, the scripts, the Arabic texts). The part that
// touches IndexedDB and the page is tests/browser/offline-queue.test.ts, run by `make journey`.
import { describe, expect, test } from "bun:test";
import { app } from "@renoxium/sdk/test";

import {
  ACTIONS,
  BACKOFF_MS,
  LIMIT,
  POLL_MS,
  actionIdOf,
  backoffMs,
  behindRefused,
  blockedJobs,
  canQueue,
  dubai,
  fill,
  isOld,
  nextAction,
  outcomeOf,
  replay,
  retryAt,
  settle,
  split,
  targetOf,
  type Answer,
  type QueuedAction,
} from "../public/offline-queue-core.js";

const ME = "u_dxb_ali";
const HOUR = 3600 * 1000;

let n = 0;
/** A waiting action of `job` for `user`; `seq` is the order it was made in. */
const act = (seq: number, job: string, action = "part", extra: Partial<QueuedAction> = {}): QueuedAction => ({
  seq,
  action_id: `a${String(seq).padStart(15, "0")}`,
  user_id: ME,
  job_id: job,
  url: `/me/visits/${job}`,
  action,
  fields: { description: `part ${++n}` },
  performed_at: 1_700_000_000_000 + seq,
  state: "pending",
  attempts: 0,
  ...extra,
});

const ok: Answer = { status: 200, body: { ok: true, status: 200, redirect: "/me/visits/x" } };
const conflict = (code: string): Answer => ({ status: 409, body: { ok: false, status: 409, conflict: code, errors: { form: `refused: ${code}` } } });

describe("the rules: order", () => {
  test("normal case: the next action is the lowest seq of the user's pending ones, however the records come", () => {
    const records = [act(5, "jb_a"), act(2, "jb_b"), act(9, "jb_a"), act(1, "jb_a", "checkin", { state: "sent" })];
    expect(nextAction(records, ME)?.seq).toBe(2);
    expect(split(records, ME).mine.map((r) => r.seq)).toEqual([2, 5, 9]);
  });

  test("the replay sends strictly in seq order, one at a time, each once", async () => {
    const records = [act(4, "jb_a", "notes"), act(2, "jb_a", "part"), act(3, "jb_b", "checkin"), act(1, "jb_a", "checkin")];
    const sent: number[] = [];
    let inFlight = 0;
    let most = 0;
    const result = await replay(records, ME, async (r) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      sent.push(r.seq);
      inFlight -= 1;
      return ok;
    });
    expect(sent).toEqual([1, 2, 3, 4]);
    expect(most).toBe(1);
    expect(result.stopped).toBe("done");
    expect(result.records.every((r) => r.state === "sent")).toBe(true);
    // Replaying what is left sends nothing.
    expect((await replay(result.records, ME, () => Promise.reject(new Error("nothing is pending")))).log).toEqual([]);
  });

  test("an action id is 32 hex digits, no dashes: what the server's 16 to 64 characters of [A-Za-z0-9_-] takes", () => {
    const id = actionIdOf("3f2b8c1e-9d4a-4e6b-8a57-1c0d2e3f4a5b");
    expect(id).toBe("3f2b8c1e9d4a4e6b8a571c0d2e3f4a5b");
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/u);
  });
});

describe("the rules: a refused action stops its job, not the others", () => {
  test("normal case: a 409 on a job's action sends nothing more of that job and goes on with the others", async () => {
    const records = [act(1, "jb_a", "checkin"), act(2, "jb_b", "checkin"), act(3, "jb_a", "part"), act(4, "jb_b", "part"), act(5, "jb_a", "checkout")];
    const sent: number[] = [];
    const result = await replay(records, ME, async (r) => {
      sent.push(r.seq);
      return r.seq === 1 ? conflict("job_cancelled") : ok;
    });
    expect(sent).toEqual([1, 2, 4]);
    const by = Object.fromEntries(result.records.map((r) => [r.seq, r]));
    expect(by[1]?.state).toBe("refused");
    expect(by[1]?.refused_reason).toBe("job_cancelled");
    expect(by[1]?.refused_message).toBe("refused: job_cancelled");
    expect([by[2]?.state, by[4]?.state]).toEqual(["sent", "sent"]);
    // The two behind the refused one stay pending, unsent.
    expect([by[3]?.state, by[5]?.state]).toEqual(["pending", "pending"]);
    expect(behindRefused(result.records, ME).map((r) => r.seq)).toEqual([3, 5]);
    expect([...blockedJobs(result.records, ME)]).toEqual(["jb_a"]);
  });

  test("the block outlives the run: a later run still sends nothing of that job", async () => {
    const records = [act(1, "jb_a", "part", { state: "refused", refused_reason: "job_reassigned" }), act(2, "jb_a", "notes"), act(3, "jb_b", "notes")];
    expect(nextAction(records, ME)?.seq).toBe(3);
    const sent: number[] = [];
    await replay(records, ME, (r) => {
      sent.push(r.seq);
      return ok;
    });
    expect(sent).toEqual([3]);
  });

  test("a 422 is refused with the field errors and stops its job too", async () => {
    const records = [act(1, "jb_a", "part"), act(2, "jb_a", "notes"), act(3, "jb_b", "notes")];
    const result = await replay(records, ME, (r) => (r.seq === 1 ? { status: 422, body: { ok: false, status: 422, errors: { qty: "Quantity is not valid." } } } : ok));
    const first = result.records[0];
    expect(first?.state).toBe("refused");
    expect(first?.refused_reason).toBe("invalid");
    expect(first?.refused_errors).toEqual({ qty: "Quantity is not valid." });
    expect(first?.refused_message).toBe("Quantity is not valid.");
    expect(result.records.map((r) => r.state)).toEqual(["refused", "pending", "sent"]);
  });

  test("another 4xx (a job that is not found, a file too big) is refused, never sent again and again", () => {
    expect(outcomeOf({ status: 404, body: null })).toMatchObject({ kind: "refused", stop: "job", reason: "http_404" });
    expect(outcomeOf({ status: 413, body: { errors: { form: "Too big." } } })).toMatchObject({ kind: "refused", reason: "http_413", message: "Too big." });
  });
});

describe("the rules: sign-in and the network stop the whole run", () => {
  test("401 and 403 stop at once and keep the queue as it was", async () => {
    for (const status of [401, 403]) {
      const records = [act(1, "jb_a"), act(2, "jb_b")];
      const sent: number[] = [];
      const result = await replay(records, ME, (r) => {
        sent.push(r.seq);
        return { status, body: null };
      });
      expect(sent, String(status)).toEqual([1]);
      expect(result.stopped).toBe("auth");
      expect(result.records.map((r) => [r.state, r.attempts])).toEqual([
        ["pending", 0],
        ["pending", 0],
      ]);
    }
  });

  test("no answer or a 5xx stops the run, counts the attempt and sends nothing later", async () => {
    for (const answer of [null, { status: 502, body: null }, { status: 503, body: { ok: false } }, { status: 429, body: null }] as Answer[]) {
      const records = [act(1, "jb_a"), act(2, "jb_b")];
      const sent: number[] = [];
      const result = await replay(records, ME, (r) => {
        sent.push(r.seq);
        return answer;
      });
      expect(sent).toEqual([1]);
      expect(result.stopped).toBe("retry");
      expect(result.records.map((r) => [r.state, r.attempts])).toEqual([
        ["pending", 1],
        ["pending", 0],
      ]);
    }
  });

  test("the wait before the next try is 30 s, 1, 2 and 5 minutes, and stays at 5", () => {
    expect(BACKOFF_MS).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect([0, 1, 2, 3, 4, 5, 40].map(backoffMs)).toEqual([0, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000]);
    expect(retryAt(1000, { attempts: 3 })).toBe(1000 + 120_000);
    // The 30 s look for a connection is the floor, and the rule when nothing failed.
    expect(POLL_MS).toBe(30_000);
    expect(retryAt(1000, { attempts: 0 })).toBe(1000 + POLL_MS);
    expect(retryAt(1000, null)).toBe(1000 + POLL_MS);
  });

  test("an action that failed and is sent again later carries its count on", async () => {
    let records = [act(1, "jb_a")];
    for (let i = 1; i <= 3; i++) records = (await replay(records, ME, () => null)).records;
    expect(records[0]?.attempts).toBe(3);
    const done = await replay(records, ME, () => ok);
    expect(done.records[0]?.state).toBe("sent");
  });
});

describe("the rules: whose actions, how many, how old", () => {
  test("the actions of another account are never sent under this session, and are counted", async () => {
    const records = [act(1, "jb_a", "part", { user_id: "u_dxb_bilal" }), act(2, "jb_b"), act(3, "jb_a", "notes", { user_id: "u_dxb_bilal" })];
    const parts = split(records, ME);
    expect(parts.mine.map((r) => r.seq)).toEqual([2]);
    expect(parts.other).toBe(2);
    const sent: number[] = [];
    const result = await replay(records, ME, (r) => {
      sent.push(r.seq);
      return ok;
    });
    expect(sent).toEqual([2]);
    expect(result.records.filter((r) => r.state === "pending").map((r) => r.seq)).toEqual([1, 3]);
    // A refused action of another user blocks nothing of this one.
    const mixed = [act(1, "jb_a", "part", { user_id: "u_dxb_bilal", state: "refused" }), act(2, "jb_a")];
    expect(nextAction(mixed, ME)?.seq).toBe(2);
    expect(split(mixed, ME).refused).toEqual([]);
  });

  test("at most 200 actions wait on a device", () => {
    expect(LIMIT).toBe(200);
    expect(canQueue(0)).toBe(true);
    expect(canQueue(199)).toBe(true);
    expect(canQueue(200)).toBe(false);
    expect(canQueue(500)).toBe(false);
  });

  test("an action older than 72 hours is marked old and is still sent", async () => {
    const now = 1_800_000_000_000;
    expect(isOld(now - 72 * HOUR, now)).toBe(false);
    expect(isOld(now - 72 * HOUR - 1, now)).toBe(true);
    const old = act(1, "jb_a", "part", { performed_at: now - 100 * HOUR });
    expect(isOld(old.performed_at, now)).toBe(true);
    const sent: number[] = [];
    await replay([old], ME, (r) => {
      sent.push(r.seq);
      return { status: 200, body: { ok: true, status: 200, time_adjusted: true } };
    });
    expect(sent).toEqual([1]);
    expect(outcomeOf({ status: 200, body: { ok: true, status: 200, time_adjusted: true } })).toEqual({ kind: "ok", adjusted: true });
  });
});

describe("the rules: reading an answer, a record, a time", () => {
  test("the answers of the server's JSON (#806) and what each does", () => {
    expect(outcomeOf(ok)).toEqual({ kind: "ok", adjusted: false });
    expect(outcomeOf(conflict("already_checked_out"))).toMatchObject({ kind: "refused", stop: "job", reason: "already_checked_out", message: "refused: already_checked_out" });
    // A 409 without a code (a refusal's reason as text) is still a refusal.
    expect(outcomeOf({ status: 409, body: { ok: false, status: 409, errors: { form: "Check in first." } } })).toMatchObject({ kind: "refused", reason: "conflict", message: "Check in first." });
    expect(outcomeOf({ status: 200, body: "not json" })).toMatchObject({ kind: "refused" });
    expect(outcomeOf(undefined)).toEqual({ kind: "retry" });
    expect(settle(act(1, "jb_a"), outcomeOf(ok))).toEqual({ patch: { state: "sent" }, stop: "none" });
    expect(settle(act(1, "jb_a"), { kind: "auth" })).toEqual({ patch: {}, stop: "all" });
  });

  test("a record names a visit page of the app and one of its actions, or it is not sent", () => {
    for (const action of ACTIONS) expect(targetOf(act(1, "jb_a", action))).toEqual({ job_id: "jb_a", action });
    expect(targetOf(act(1, "jb_a", "photo"))).toBeNull();
    expect(targetOf(act(1, "jb_a", "removePart"))).toBeNull();
    expect(targetOf({ ...act(1, "jb_a"), url: "/jobs/jb_a" })).toBeNull();
    expect(targetOf({ ...act(1, "jb_a"), url: "https://evil.example/me/visits/jb_a" })).toBeNull();
    expect(targetOf({ ...act(1, "jb_a"), url: "/me/visits/jb_a?x=1" })).toBeNull();
    expect(targetOf({ ...act(1, "jb_a"), action_id: "short" })).toBeNull();
    expect(targetOf(null)).toBeNull();
  });

  test("Dubai time as the pages print it, and the texts' placeholders", () => {
    // 2026-11-14 06:42 UTC is 10:42 in Dubai.
    expect(dubai(Date.UTC(2026, 10, 14, 6, 42, 59))).toBe("2026-11-14 10:42");
    expect(dubai(Date.UTC(2026, 10, 14, 21, 5))).toBe("2026-11-15 01:05");
    expect(fill("{n} actions of {who}", { n: 3 })).toBe("3 actions of {who}");
    expect(fill("{n} actions", { n: 3 })).toBe("3 actions");
  });
});

describe("the scripts that open the device database agree", () => {
  const read = (file: string) => Bun.file(new URL(`../public/${file}`, import.meta.url)).text();

  test("me.js and sw.js open hs-offline at one version and create the same stores; the queue opens it through me.js", async () => {
    const [meJs, swJs, queueJs] = await Promise.all([read("me.js"), read("sw.js"), read("offline-queue.js")]);
    const version = /const DB_VERSION = (\d+);/u.exec(meJs)?.[1];
    expect(version).toBe("2");
    expect(swJs).toContain(`indexedDB.open("hs-offline", ${version})`);
    expect(meJs).toContain('const KV = "kv";');
    expect(meJs).toContain("db.createObjectStore(KV)");
    expect(swJs).toContain('db.createObjectStore("kv")');
    for (const source of [meJs, swJs]) {
      expect(source).toContain('db.createObjectStore("actions", { keyPath: "seq", autoIncrement: true })');
      expect(source).toContain("objectStoreNames.contains");
    }
    expect(queueJs).toContain("me.openDb()");
    expect(queueJs).not.toContain("indexedDB.open");
    expect(queueJs).toContain("me.ping()");
    expect(queueJs).not.toMatch(/fetch\(\s*["'`]\/me\/ping/u);
  });

  test("what the queue keeps is text fields only: no token, no file, no photo", async () => {
    const queueJs = await read("offline-queue.js");
    // The token is read when a send starts and never put in a record.
    expect(queueJs).toContain('k !== "_csrf"');
    expect(queueJs).toContain('typeof v === "string"');
    expect(queueJs).not.toMatch(/localStorage|document\.cookie\s*=/u);
  });
});

const t = await app();
const PASSWORD = "correct horse battery";
const ali = t.as("ali");
expect((await ali.action("/auth/login", "default", { email: "ali.dubai@fixit.example", password: PASSWORD, next: "/me" })).status).toBe(303);

describe("the pages that carry the queue", () => {
  const scripts = (html: string): string[] => [...html.matchAll(/<script src="\/([a-z-]+)\.[0-9a-f]{16}\.js" defer nonce="[^"]+"><\/script>/gu)].map((m) => m[1] as string);
  const marked = (html: string): string[] => [...html.matchAll(/<form [^>]*data-offline-action="" data-offline-effect="(\w+)"/gu)].map((m) => m[1] as string);

  test("the check-in state: the six forms are marked, the visit's other sections wait hidden, the scripts load after visit.js", async () => {
    const res = await ali.page("/me/visits/jb_seed_10");
    expect(res.status).toBe(200);
    expect(marked(res.html)).toEqual(["checkin", "part", "notes", "signature", "summary", "checkout"]);
    // Each marked form posts to the action its effect is named after.
    for (const [, action, effect] of res.html.matchAll(/<form [^>]*action="\?\/(\w+)"[^>]*data-offline-effect="(\w+)"/gu)) expect(effect).toBe(action);
    expect(res.html).toMatch(/<section id="visit" hidden>/u);
    expect(res.html).not.toContain('id="photos"');
    expect(scripts(res.html)).toEqual(["me", "visit", "offline-queue-core", "offline-queue"]);
    expect(res.html).not.toMatch(/<script(?![^>]*\bsrc=)/u);
    expect(res.html).toMatch(/<div id="queue-status" role="status" data-waiting="\{n\} actions waiting to be sent" data-waiting-one="1 action waiting to be sent" data-sending="Sending…" data-all-sent="All sent" data-sign-in="Sign in again to send \{n\} saved actions"/u);
    expect(res.html).toContain('data-other="{n} actions of another account are waiting; sign in as that user to send them"');
    expect(res.html).toContain('data-not-sent="not sent yet"');
    expect(res.html).toContain('data-too-many="Too many saved actions, please get a connection"');
  });

  test("an open visit: its forms are marked, shown, and the photo and remove-part forms are not queued", async () => {
    // jb_seed_06 is a scheduled job of Ali's: checking in makes it an open visit.
    expect((await ali.action("/me/visits/jb_seed_06", "checkin", {})).status).toBe(303);
    const open = await ali.page("/me/visits/jb_seed_06");
    expect(open.status).toBe(200);
    expect(open.html).not.toContain('id="visit-closed"');
    expect(open.html).not.toMatch(/<section id="visit" hidden>/u);
    expect(marked(open.html)).toEqual(["part", "notes", "signature", "summary", "checkout"]);
    expect(open.html).toContain('id="photo-form-before"');
    expect(open.html).not.toMatch(/id="photo-form-before"[^>]*data-offline/u);
  });

  test("a closed visit and /me: the status line and the scripts, no marked form", async () => {
    const closed = await ali.page("/me/visits/jb_seed_12");
    expect(marked(closed.html)).toEqual(["summary"]);
    expect(closed.html).not.toMatch(/<section id="visit" hidden>/u);
    expect(scripts(closed.html)).toEqual(["me", "offline-queue-core", "offline-queue"]);
    const list = await ali.page("/me");
    expect(list.html).toContain('<div id="queue-status" role="status"');
    expect(scripts(list.html)).toEqual(["me", "offline-queue-core", "offline-queue"]);
    expect(marked(list.html)).toEqual([]);
  });

  test("the scripts are on the technician's two pages only", async () => {
    const dina = t.as("dina");
    await dina.action("/auth/login", "default", { email: "dispatcher.dubai@fixit.example", password: PASSWORD, next: "/" });
    for (const path of ["/jobs", "/"]) {
      const res = await dina.page(path);
      expect(res.html, path).not.toContain("offline-queue");
      expect(res.html, path).not.toContain('id="queue-status"');
    }
  });

  test("the texts are in Arabic too", async () => {
    const res = await ali.page("/me/visits/jb_seed_10?lang=ar");
    await ali.page("/me?lang=en");
    expect(res.html).toContain('data-not-sent="لم يُرسل بعد"');
    expect(res.html).toContain('data-sending="جارٍ الإرسال…"');
    expect(res.html).toContain('data-all-sent="تم إرسال كل شيء"');
    expect(res.html).toContain('data-too-many="عدد الإجراءات المحفوظة كبير جدًا، يرجى الاتصال بالإنترنت"');
  });

  test("the script files are served, and /me/ping gives a technician what the queue asks for: 204 and the user id", async () => {
    for (const name of ["offline-queue-core", "offline-queue"]) {
      const src = new RegExp(`<script src="(/${name}\\.[0-9a-f]{16}\\.js)"`, "u").exec((await ali.page("/me")).html)?.[1] ?? "";
      expect(src).not.toBe("");
      const file = await ali.request("GET", src);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type") ?? "").toContain("javascript");
    }
    const ping = await ali.request("GET", "/me/ping");
    expect(ping.status).toBe(204);
    expect(ping.headers.get("x-hs-user")).toBe("u_dxb_ali");
  });
});
