// The technician's visit (F7-123): check in, photos before and after, parts,
// notes, the customer's drawn signature, check out, and the visit report PDF
// with the AI summary. Runs on the local worker with the seed's users (password
// below). The AI is off on the worker (no provider), so the summary fields stay
// empty there; the draft itself is tested with a fake `ai`.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { fakeAi } from "@renoxium/sdk/fakes";
import { snapshot, app } from "@renoxium/sdk/test";

import { base64Of, solidPng } from "../lib/placeholder-png";
import { draftSummary, parseSummary } from "../lib/summary";
import { MAX_PHOTO_BYTES, photoLimitMessage } from "../lib/visit-data";

const t = await app();
const PASSWORD = "correct horse battery";

async function signIn(jar: string, email: string, next = "/me") {
  const u = t.as(jar);
  const res = await u.action("/auth/login", "default", { email, password: PASSWORD, next });
  expect(res.status).toBe(303);
  return u;
}

const ali = await signIn("ali", "ali.dubai@fixit.example");
const bilal = await signIn("bilal", "bilal.dubai@fixit.example");
const dina = await signIn("dina", "dispatcher.dubai@fixit.example");
const mona = await signIn("mona", "manager.dubai@fixit.example");
const sami = await signIn("sami", "dispatcher.sharjah@fixit.example");
const accountant = await signIn("accountant", "accountant.dubai@fixit.example");

const rows = (sql: string, params: (string | number | null)[] = []) => t.db.query<Record<string, unknown>>(sql, params);
const jobOf = (id: string) => rows("select * from app__jobs where id = ?", [id])[0] as Record<string, unknown>;
const visitOf = (jobId: string) => rows("select * from app__visits where job_id = ?", [jobId])[0] as Record<string, unknown> | undefined;
/** The language of the job's customer: the one the stored report (report_key) is in. */
const ownLang = (jobId: string): string => String(rows("select c.language as l from app__jobs j join app__customers c on c.id = j.customer_id where j.id = ?", [jobId])[0]?.l);
const located = (res: { headers: Headers }) => res.headers.get("location") ?? "";
/** A time of day is not part of what the snapshots pin: the seed is relative to the day they run. */
const steady = (html: string) => html.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/gu, "<when>");

/**
 * The browser's PUT of binary bytes. The harness sends strings, so a binary body is a latin-1 string with the
 * header `x-test-binary`, turned back into bytes on the way out (the same fetch the harness uses).
 */
/** A data URL, as the signature pad posts it. */
const PNG = (rgb: [number, number, number], size = 16) => `data:image/png;base64,${base64Of(solidPng(rgb, size).bytes)}`;

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const headers = init?.headers as Record<string, string> | undefined;
  if (headers?.["x-test-binary"] !== undefined && typeof init?.body === "string") {
    const { "x-test-binary": _binary, ...rest } = headers;
    return realFetch(input, { ...init, headers: rest, body: Uint8Array.from(init.body, (c) => c.charCodeAt(0)) });
  }
  return realFetch(input, init);
}) as typeof fetch;
const latin1 = (bytes: Uint8Array): string => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

/** Step one and the PUT of a photo, as `public/upload.js` does them: the action signs, the browser PUTs; answers the stored key. */
async function uploadPhoto(u: typeof ali, jobId: string, name: string, rgb: [number, number, number]): Promise<string> {
  const png = solidPng(rgb, 16).bytes;
  const signed = await u.action(`/me/visits/${jobId}`, "photo_url", { name, type: "image/png", size: String(png.length) });
  expect(signed.status).toBe(200);
  const target = signed.json<{ url: string; max_bytes: number }>();
  expect(target.max_bytes).toBe(MAX_PHOTO_BYTES);
  expect(target.url).toStartWith("/_files/storage/vs_");
  const put = await u.request("PUT", target.url, { body: latin1(png), headers: { "content-type": "image/png", "x-test-binary": "1" } });
  expect(put.status).toBe(201);
  return put.json<{ key: string }>().key;
}

const FLOW = "jb_seed_06"; // Ali's scheduled job in Dubai
const NOPHOTOS = "jb_seed_05"; // Ali's scheduled job today

describe("the seed", () => {
  test("visits for the done and invoiced jobs, two photos each", () => {
    expect(rows("select job_id from app__visits order by job_id").map((r) => r.job_id)).toEqual(["jb_seed_11", "jb_seed_12", "jb_seed_13", "jb_seed_19"]);
    expect(rows("select visit_id, count(*) as n from app__visit_photos group by visit_id order by visit_id").map((r) => r.n)).toEqual([2, 2, 2, 2]);
    expect(rows("select count(*) as n from app__visit_parts")[0]?.n).toBe(4);
  });
});

describe("the technician's day", () => {
  test("normal case: /me lists Ali's visits and no one else's", async () => {
    const res = await ali.page("/me");
    expect(res.status).toBe(200);
    expect(res.html).toContain("J-000005");
    expect(res.html).toContain("J-000010");
    expect(res.html).not.toContain("J-000007");
    expect(res.html).not.toContain("J-000009");
  });

  test("a dispatcher has no visits of their own: /me is 403", async () => {
    expect((await dina.page("/me")).status).toBe(403);
    expect((await dina.page(`/me/visits/${FLOW}`)).status).toBe(403);
  });

  test("the check-in state of a visit, on a phone, in English", async () => {
    const res = await ali.page("/me/visits/jb_seed_10");
    expect(res.status).toBe(200);
    expect(res.html).toContain('id="checkin-form"');
    expect(res.html).not.toContain('id="photos"');
    snapshot(steady(res.html), { role: "visit, check-in, technician, phone, en" });
  });
});

describe("the technician's flow from scheduled to done", () => {
  let visitId = "";

  test("error case: another technician, a manager and a dispatcher of the branch are refused; another branch's job is not found", async () => {
    expect((await bilal.page(`/me/visits/${FLOW}`)).status).toBe(403);
    expect((await mona.page(`/me/visits/${FLOW}`)).status).toBe(403);
    expect((await bilal.action(`/me/visits/${FLOW}`, "checkin", {})).status).toBe(403);
    expect((await mona.action(`/me/visits/${FLOW}`, "checkin", {})).status).toBe(403);
    expect((await sami.page(`/me/visits/${FLOW}`)).status).toBe(403);
    expect(visitOf(FLOW)).toBeUndefined();
    expect(jobOf(FLOW).status).toBe("scheduled");
  });

  test("a photo, a part or a check-out before the check-in is a 409", async () => {
    expect((await ali.action(`/me/visits/${FLOW}`, "photo", { phase: "before", key: "storage/vs_0000000000000000/a.png" })).status).toBe(409);
    expect((await ali.action(`/me/visits/${FLOW}`, "photo_url", { name: "a.png", type: "image/png", size: "10" })).status).toBe(409);
    expect((await ali.action(`/me/visits/${FLOW}`, "part", { description: "Hose", qty: "1", price: "10" })).status).toBe(409);
    expect((await ali.action(`/me/visits/${FLOW}`, "checkout", {})).status).toBe(409);
    expect(jobOf(FLOW).status).toBe("scheduled");
  });

  test("check-in records the position, moves the job to in progress and writes the event", async () => {
    const res = await ali.action(`/me/visits/${FLOW}`, "checkin", { lat: "25.1412", lng: "55.2253" });
    expect(res.status).toBe(303);
    expect(located(res)).toBe(`/me/visits/${FLOW}`);
    const visit = visitOf(FLOW);
    expect(visit).toMatchObject({ job_id: FLOW, technician_user_id: "u_dxb_ali", branch_id: "br_dubai", checkin_lat: 25.1412, checkin_lng: 55.2253, checkout_at: null });
    visitId = String(visit?.id);
    expect(visitId).toMatch(/^vs_[0-9a-f]{16}$/u);
    expect(jobOf(FLOW).status).toBe("in_progress");
    const event = rows("select from_status, to_status, note, by_user_id from app__job_events where job_id = ? order by id desc limit 1", [FLOW])[0];
    expect(event).toMatchObject({ from_status: "scheduled", to_status: "in_progress", note: "checked in", by_user_id: "u_dxb_ali" });
  });

  test("error case: checking in twice is a 409 and changes nothing", async () => {
    const again = await ali.action(`/me/visits/${FLOW}`, "checkin", {});
    expect(again.status).toBe(409);
    expect(again.html).toContain("already checked in");
    expect(rows("select count(*) as n from app__visits where job_id = ?", [FLOW])[0]?.n).toBe(1);
  });

  test("a position that is not one is a 422 naming the field, and nothing is stored", async () => {
    const res = await ali.action(`/me/visits/${NOPHOTOS}`, "checkin", { lat: "95", lng: "10" });
    expect(res.status).toBe(422);
    expect(res.html).toContain('id="err-lat"');
    expect(visitOf(NOPHOTOS)).toBeUndefined();
  });

  test("two photos, before and after: a signed upload, the PUT, then the key; stored under storage/<visit>/ and shown through <x-image>", async () => {
    const keyBefore = await uploadPhoto(ali, FLOW, "Pipe leak.png", [0x8a, 0x5c, 0x3c]);
    expect(keyBefore).toMatch(new RegExp(`^storage/${visitId}/[a-z0-9]+-[a-z0-9]{6}-pipe-leak\\.png$`, "u"));
    // Until the form posts the key, the file is in the store and no photo is recorded.
    expect(rows("select count(*) as n from app__visit_photos where visit_id = ?", [visitId])[0]?.n).toBe(0);
    const before = await ali.action(`/me/visits/${FLOW}`, "photo", { phase: "before", caption: "The leaking pipe", key: keyBefore });
    expect(before.status).toBe(303);
    const keyAfter = await uploadPhoto(ali, FLOW, "joint.png", [0x1f, 0x6f, 0x5c]);
    const after = await ali.action(`/me/visits/${FLOW}`, "photo", { phase: "after", caption: "The new joint", key: keyAfter });
    expect(after.status).toBe(303);
    const photos = rows("select phase, file_key, caption, width, height from app__visit_photos where visit_id = ? order by id", [visitId]);
    expect(photos.map((p) => p.phase)).toEqual(["before", "after"]);
    expect(photos.map((p) => p.file_key)).toEqual([keyBefore, keyAfter]);
    // The dimensions are the stored file's (the platform reads them from the image).
    expect(photos[0]).toMatchObject({ caption: "The leaking pipe", width: 16, height: 16 });
    const page = await ali.page(`/me/visits/${FLOW}`);
    expect(page.html).toMatch(/<img src="\/_img\/storage\/vs_[0-9a-f]{16}\/[^"]*\?w=160&amp;exp=\d+&amp;sig=[0-9a-f]+"[^>]* srcset="/u);
    expect(page.html).toContain("The new joint");
    // The dispatcher sees the same photos on the job page.
    expect((await dina.page(`/jobs/${FLOW}`)).html).toMatch(/<img src="\/_img\/storage\/vs_[0-9a-f]{16}\//u);
    // The stored file is the one that was sent, and the same key twice is the same photo.
    expect(rows("select count(*) as n from renox__files where key = ?", [keyBefore])[0]?.n).toBe(1);
    expect((await ali.action(`/me/visits/${FLOW}`, "photo", { phase: "before", caption: "Again", key: keyBefore })).status).toBe(303);
    expect(rows("select count(*) as n from app__visit_photos where visit_id = ?", [visitId])[0]?.n).toBe(2);
  });

  test("error case: a size over 10 MiB is refused at signing naming the limit, and a PUT past the signed limit is a 413; neither is recorded", async () => {
    const big = await ali.action(`/me/visits/${FLOW}`, "photo_url", { name: "big.png", type: "image/png", size: String(MAX_PHOTO_BYTES + 1) });
    expect(big.status).toBe(413);
    const message = big.json<{ message: string }>().message;
    expect(message).toContain("10 MiB");
    expect(message).toContain(String(MAX_PHOTO_BYTES));
    // The browser's own size is only a hint: the URL signs 10 MiB, and the cell stops a larger body.
    const small = await ali.action(`/me/visits/${FLOW}`, "photo_url", { name: "big.png", type: "image/png", size: "10" });
    expect(small.status).toBe(200);
    const put = await ali.request("PUT", small.json<{ url: string }>().url, { body: "x".repeat(MAX_PHOTO_BYTES + 1), headers: { "content-type": "image/png" } });
    expect(put.status).toBe(413);
    expect(rows("select count(*) as n from app__visit_photos where visit_id = ?", [visitId])[0]?.n).toBe(2);
  });

  test("the action's own limit names 10 MiB and its size in bytes", () => {
    expect(photoLimitMessage(MAX_PHOTO_BYTES)).toBeNull();
    const message = photoLimitMessage(MAX_PHOTO_BYTES + 1) as string;
    expect(message).toContain("10 MiB");
    expect(message).toContain("10485760");
    expect(message).toContain("10485761");
  });

  test("a type that is not JPEG, PNG or WebP is a 422 naming it; another technician's request is a 403", async () => {
    for (const type of ["text/plain", "image/svg+xml", "image/gif", ""]) {
      const res = await ali.action(`/me/visits/${FLOW}`, "photo_url", { name: "notes.txt", type, size: "5" });
      expect(res.status).toBe(422);
      expect(res.json<{ message: string }>().message).toContain(type === "" ? "no type" : type);
    }
    expect((await bilal.action(`/me/visits/${FLOW}`, "photo_url", { name: "a.png", type: "image/png", size: "5" })).status).toBe(403);
    expect((await bilal.action(`/me/visits/${FLOW}`, "photo", { phase: "after", key: `storage/${visitId}/a.png` })).status).toBe(403);
    expect(rows("select count(*) as n from app__visit_photos where visit_id = ?", [visitId])[0]?.n).toBe(2);
  });

  test("a key of another owner, outside the folder, or of no stored file is a 422 and nothing is recorded", async () => {
    // A real upload by Ali into another visit's folder cannot be done (the folder is the visit's), so the keys are made up.
    const stranger = await ali.action(`/me/visits/${FLOW}`, "photo", { phase: "after", key: "storage/vs_0123456789abcdef/x.png" });
    expect(stranger.status).toBe(422);
    expect((await ali.action(`/me/visits/${FLOW}`, "photo", { phase: "after", key: "storage/u_dxb_ali/x.png" })).status).toBe(422);
    expect((await ali.action(`/me/visits/${FLOW}`, "photo", { phase: "after", key: "app/visits/x/after/y.png" })).status).toBe(422);
    expect((await ali.action(`/me/visits/${FLOW}`, "photo", { phase: "after", key: `storage/${visitId}/../u_dxb_bilal/x.png` })).status).toBe(422);
    const missing = await ali.action(`/me/visits/${FLOW}`, "photo", { phase: "after", key: `storage/${visitId}/never-uploaded.png` });
    expect(missing.status).toBe(422);
    expect(missing.html).toContain("not stored");
    expect((await ali.action(`/me/visits/${FLOW}`, "photo", { phase: "after" })).status).toBe(422);
    expect(rows("select count(*) as n from app__visit_photos where visit_id = ?", [visitId])[0]?.n).toBe(2);
  });

  test("one part, with its price, and an invalid one named by field", async () => {
    const ok = await ali.action(`/me/visits/${FLOW}`, "part", { description: "Copper joint 15 mm", qty: "2", price: "12.50" });
    expect(ok.status).toBe(303);
    expect(rows("select description, qty, unit_price_fils, branch_id from app__visit_parts where visit_id = ?", [visitId])).toEqual([{ description: "Copper joint 15 mm", qty: 2, unit_price_fils: 1250, branch_id: "br_dubai" }]);
    const bad = await ali.action(`/me/visits/${FLOW}`, "part", { description: "", qty: "0", price: "ten" });
    expect(bad.status).toBe(422);
    for (const f of ["description", "qty", "price"]) expect(bad.html).toContain(`id="err-${f}"`);
    expect(rows("select count(*) as n from app__visit_parts where visit_id = ?", [visitId])[0]?.n).toBe(1);
    expect((await ali.page(`/me/visits/${FLOW}`)).html).toContain("25.00");
  });

  test("notes, and the drawn signature with the name of whoever signed (twice: the second replaces the first)", async () => {
    expect((await ali.action(`/me/visits/${FLOW}`, "notes", { notes: "Replaced the leaking joint under the sink." })).status).toBe(303);
    expect(visitOf(FLOW)?.notes).toBe("Replaced the leaking joint under the sink.");
    const none = await ali.action(`/me/visits/${FLOW}`, "signature", { signed_by: "Layla", signature: "" });
    expect(none.status).toBe(422);
    expect(none.html).toContain('id="err-signature"');
    expect((await ali.action(`/me/visits/${FLOW}`, "signature", { signed_by: "Layla", signature: PNG([0, 0, 0], 12) })).status).toBe(303);
    const first = String(visitOf(FLOW)?.signature_key);
    expect(first).toMatch(new RegExp(`^app/visits/${visitId}/signature-[a-z0-9]+\\.png$`, "u"));
    expect((await ali.action(`/me/visits/${FLOW}`, "signature", { signed_by: "Layla Hassan", signature: PNG([9, 9, 9], 12) })).status).toBe(303);
    const second = visitOf(FLOW);
    expect(second).toMatchObject({ signed_by_name: "Layla Hassan" });
    expect(second?.signature_key).not.toBe(first);
    expect(rows("select count(*) as n from renox__files where key = ?", [first])[0]?.n).toBe(0);
    expect(rows("select count(*) as n from renox__files where key = ?", [second?.signature_key as string])[0]?.n).toBe(1);
  });

  test("check-out moves the job to done, leaves the summary empty with the AI off, and stores the report PDF", async () => {
    const res = await ali.action(`/me/visits/${FLOW}`, "checkout", {});
    expect(res.status).toBe(303);
    expect(jobOf(FLOW).status).toBe("done");
    const visit = visitOf(FLOW);
    expect(visit?.checkout_at).not.toBeNull();
    expect(visit).toMatchObject({ summary_en: "", summary_ar: "" });
    const key = String(visit?.report_key);
    expect(key).toBe(`app/visits/${visitId}/report-${ownLang(FLOW)}.pdf`);
    expect(rows("select content_type, bytes from renox__files where key = ?", [key])[0]).toMatchObject({ content_type: "application/pdf" });
    const events = rows("select to_status, note from app__job_events where job_id = ? order by id desc limit 2", [FLOW]);
    expect(events[0]).toMatchObject({ to_status: "done", note: "checked out" });
    // A closed visit takes no more photos, parts or check-outs.
    expect((await ali.action(`/me/visits/${FLOW}`, "photo", { phase: "after", key: `storage/${visitId}/late.png` })).status).toBe(409);
    expect((await ali.action(`/me/visits/${FLOW}`, "photo_url", { name: "late.png", type: "image/png", size: "10" })).status).toBe(409);
    expect((await ali.action(`/me/visits/${FLOW}`, "checkout", {})).status).toBe(409);
    expect((await ali.page(`/me/visits/${FLOW}`)).html).toContain('id="visit-closed"');
  });

  test("the report is a PDF in both languages, for the technician and the dispatcher; the data names the photos, the part and the signer", async () => {
    for (const lang of ["en", "ar"]) {
      const pdf = await ali.page(`/visits/${visitId}/report?lang=${lang}`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
      expect(pdf.html.startsWith("%PDF")).toBe(true);
    }
    expect((await dina.page(`/visits/${visitId}/report`)).html.startsWith("%PDF")).toBe(true);
    expect((await accountant.page(`/visits/${visitId}/report`)).status).toBe(200);
    const data = (await dina.page(`/visits/${visitId}/report?format=json&lang=ar`)).json<Record<string, unknown>>();
    expect(data).toMatchObject({ job_number: "J-000006", no_photos: false, has_parts: true, signed_by: "Layla Hassan", parts_total: "25.00" });
    expect((data.before as unknown[]).length).toBe(1);
    expect((data.after as unknown[]).length).toBe(1);
    // No pictures reach the PDF: each photo is printed by phase, caption and file key; the signature by the signer and the time.
    const before = data.before as { phase: string; caption: string; file_key: string }[];
    const after = data.after as { phase: string; caption: string; file_key: string }[];
    expect(before[0]).toMatchObject({ phase: "before", caption: "The leaking pipe" });
    expect(after[0]).toMatchObject({ phase: "after", caption: "The new joint" });
    expect(before[0]?.file_key).toMatch(new RegExp(`^storage/${visitId}/[a-z0-9-]+\\.png$`, "u"));
    expect(data.signed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
    expect(data).not.toHaveProperty("signature");
    expect(String(data.technician)).toContain("Ali");
  });

  test("the report templates print the caption list, the file key and the signer, and carry no <img>", () => {
    for (const lang of ["en", "ar"]) {
      const html = readFileSync(new URL(`../partials/pdf/visit-report.${lang}.html`, import.meta.url), "utf8");
      expect(html).not.toContain("<img");
      expect(html).toContain("{{ p.caption }}");
      expect(html).toContain("{{ p.file_key }}");
      expect(html).toContain("{{ signed_by }}");
      expect(html).toContain("{{ signed_at }}");
    }
    expect(readFileSync(new URL("../partials/pdf/visit-report.en.html", import.meta.url), "utf8")).toContain("Signed by {{ signed_by }} at {{ signed_at }}");
  });

  test("error case: the report is not for another technician (403) nor another branch (404), and not before check-out (409)", async () => {
    expect((await bilal.page(`/visits/${visitId}/report`)).status).toBe(403);
    expect((await sami.page(`/visits/${visitId}/report`)).status).toBe(404);
    expect((await ali.page("/visits/vs_nothing/report")).status).toBe(404);
  });

  test("the technician edits the summary and the report is rebuilt with it", async () => {
    const res = await ali.action(`/me/visits/${FLOW}`, "summary", { summary_en: "We replaced the leaking joint.", summary_ar: "استبدلنا الوصلة المتسرّبة." });
    expect(res.status).toBe(303);
    expect(visitOf(FLOW)).toMatchObject({ summary_en: "We replaced the leaking joint.", summary_ar: "استبدلنا الوصلة المتسرّبة." });
    const data = (await ali.page(`/visits/${visitId}/report?format=json&lang=en`)).json<{ summary: string }>();
    expect(data.summary).toBe("We replaced the leaking joint.");
    const tooLong = await ali.action(`/me/visits/${FLOW}`, "summary", { summary_en: "x".repeat(401), summary_ar: "" });
    expect(tooLong.status).toBe(422);
    expect(tooLong.html).toContain('id="err-summary_en"');
  });
});

describe("a visit without photos", () => {
  test("edge case: check-out is allowed and the report says there are none", async () => {
    expect((await ali.action(`/me/visits/${NOPHOTOS}`, "checkin", {})).status).toBe(303);
    expect(visitOf(NOPHOTOS)).toMatchObject({ checkin_lat: null, checkin_lng: null });
    expect((await ali.action(`/me/visits/${NOPHOTOS}`, "checkout", {})).status).toBe(303);
    expect(jobOf(NOPHOTOS).status).toBe("done");
    const visit = visitOf(NOPHOTOS);
    const data = (await ali.page(`/visits/${visit?.id}/report?format=json&lang=en`)).json<Record<string, unknown>>();
    expect(data).toMatchObject({ no_photos: true, has_parts: false, signed_by: "" });
    expect((await ali.page(`/visits/${visit?.id}/report`)).html.startsWith("%PDF")).toBe(true);
    expect(visit?.report_key).toBe(`app/visits/${visit?.id}/report-${ownLang(NOPHOTOS)}.pdf`);
  });

  test("a job that is already in progress is checked in without a second transition", async () => {
    expect((await ali.action("/me/visits/jb_seed_10", "checkin", {})).status).toBe(303);
    expect(jobOf("jb_seed_10").status).toBe("in_progress");
    // The two events of the seed (created, in progress): no third one.
    expect(rows("select count(*) as n from app__job_events where job_id = 'jb_seed_10'")[0]?.n).toBe(2);
    expect(visitOf("jb_seed_10")).toBeDefined();
  });

  test("a job that is not scheduled cannot be visited (409), and a closed one is not checked in again", async () => {
    expect((await ali.action("/me/visits/jb_seed_12", "checkin", {})).status).toBe(409);
  });
});

describe("dispatchers read visits", () => {
  test("the job page shows the visit, its photos, parts and the report links, in the dispatcher's language", async () => {
    const res = await dina.page("/jobs/jb_seed_12");
    expect(res.status).toBe(200);
    expect(res.html).toContain('id="visit"');
    expect(res.html).toContain("Filter set");
    expect(res.html).toContain("/visits/vs_seed_12/report?lang=ar");
    expect(res.html).toContain('name="summary_en"');
    // The accountant reads it too, but has no job.write: no summary form.
    const read = await accountant.page("/jobs/jb_seed_12");
    expect(read.html).toContain('id="visit"');
    expect(read.html).not.toContain('name="summary_en"');
  });

  test("a dispatcher edits the summary; a technician and another branch's dispatcher cannot", async () => {
    const res = await dina.action("/jobs/jb_seed_12", "summary", { summary_en: "Both units serviced.", summary_ar: "تمت صيانة الوحدتين." });
    expect(res.status).toBe(303);
    expect(rows("select summary_en, summary_ar from app__visits where id = 'vs_seed_12'")[0]).toEqual({ summary_en: "Both units serviced.", summary_ar: "تمت صيانة الوحدتين." });
    expect((await ali.action("/jobs/jb_seed_12", "summary", { summary_en: "x", summary_ar: "y" })).status).toBe(403);
    expect((await sami.action("/jobs/jb_seed_12", "summary", { summary_en: "x", summary_ar: "y" })).status).toBe(404);
    expect((await accountant.action("/jobs/jb_seed_12", "summary", { summary_en: "x", summary_ar: "y" })).status).toBe(403);
    expect(rows("select summary_en from app__visits where id = 'vs_seed_12'")[0]?.summary_en).toBe("Both units serviced.");
  });

  test("the report of a seeded visit is built on demand, with the seeded photos named", async () => {
    const data = (await dina.page("/visits/vs_seed_12/report?format=json&lang=en")).json<Record<string, unknown>>();
    expect(data).toMatchObject({ job_number: "J-000012", summary: "Both units serviced.", parts_total: "50.00", no_photos: false });
    expect((await dina.page("/visits/vs_seed_12/report")).html.startsWith("%PDF")).toBe(true);
    expect(rows("select report_key from app__visits where id = 'vs_seed_12'")[0]?.report_key).toBe(`app/visits/vs_seed_12/report-${ownLang("jb_seed_12")}.pdf`);
  });
});

describe("the visit page on a phone", () => {
  test("a closed visit with its photos, part, summary and report links, in English and in Arabic", async () => {
    const en = await ali.page("/me/visits/jb_seed_12");
    expect(en.status).toBe(200);
    snapshot(steady(en.html), { role: "visit, done, technician, phone, en" });
    const ar = await ali.page("/me/visits/jb_seed_12?lang=ar");
    expect(ar.html).toContain('<html lang="ar" dir="rtl"');
    snapshot(steady(ar.html), { role: "visit, done, technician, phone, ar" });
  });

  test("the open visit has the signature canvas and its script, with the page's nonce", async () => {
    const res = await ali.page("/me/visits/jb_seed_10");
    expect(res.html).toContain('id="sig-canvas"');
    expect(res.html).toMatch(/<script nonce="[^"]+">\s*\(\(\) => \{/u);
    // The photo form: the file goes to a signed URL (public/upload.js, from the page's own origin), the form posts its key.
    expect(res.html).toMatch(/<script src="\/upload\.[0-9a-f]{16}\.js" defer nonce="[^"]+"><\/script>/u);
    expect(res.html).toContain('data-upload-action="/me/visits/jb_seed_10?/photo_url"');
    expect(res.html).toContain('data-key-field="key"');
    expect(res.html).toContain("data-upload-status");
    expect(res.html).toContain('capture="environment"');
    expect(res.html).not.toContain('name="photo"');
    expect(res.html).not.toContain("createImageBitmap");
  });
});

describe("the AI summary", () => {
  const parts = [{ description: "Copper joint 15 mm", qty: 2 }];
  const input = { service: "Plumbing", notes: "Replaced the leaking joint under the sink.", parts };

  test("normal case: two sentences in each language from the model's JSON", async () => {
    const ai = fakeAi([{ text: 'Here: {"en":"The joint under the sink was replaced. No leak remains.","ar":"تم استبدال الوصلة تحت الحوض. لا يوجد تسرّب."}' }]);
    expect(await draftSummary(ai, input)).toEqual({ en: "The joint under the sink was replaced. No leak remains.", ar: "تم استبدال الوصلة تحت الحوض. لا يوجد تسرّب.", ai: "on" });
  });

  test("edge case: nothing to summarise asks no model; an answer that is not JSON leaves the fields empty", async () => {
    expect(await draftSummary(fakeAi([]), { service: "Plumbing", notes: "  ", parts: [] })).toEqual({ en: "", ar: "", ai: "on" });
    expect(await draftSummary(fakeAi([{ text: "Sorry, I cannot." }]), input)).toEqual({ en: "", ar: "", ai: "on" });
    expect(parseSummary('{"en":"x".repeat}')).toEqual({ en: "", ar: "" });
    expect(parseSummary(`{"en":"${"a".repeat(500)}","ar":7}`).en).toHaveLength(400);
  });

  test("error case: AI off and over quota leave the fields empty and say why", async () => {
    const failing = (code: string) => ({ chat: async () => Promise.reject(Object.assign(new Error(code), { code })) }) as never;
    expect(await draftSummary(failing("RENOX_AI_UNAVAILABLE"), input)).toEqual({ en: "", ar: "", ai: "off" });
    expect(await draftSummary(failing("RENOX_AI_QUOTA"), input)).toEqual({ en: "", ar: "", ai: "quota" });
    await expect(draftSummary(failing("RENOX_AI_OTHER"), input)).rejects.toThrow("RENOX_AI_OTHER");
  });
});

describe("the ownership fence", () => {
  test("every visit row repeats its job's branch", () => {
    const db = new Database(t.dbFile, { readonly: true });
    db.exec("pragma busy_timeout = 5000");
    const stray = db.query("select count(*) as n from app__visits v join app__jobs j on j.id = v.job_id where v.branch_id != j.branch_id").get() as { n: number };
    const photos = db.query("select count(*) as n from app__visit_photos p join app__visits v on v.id = p.visit_id where p.branch_id != v.branch_id").get() as { n: number };
    const parts = db.query("select count(*) as n from app__visit_parts p join app__visits v on v.id = p.visit_id where p.branch_id != v.branch_id").get() as { n: number };
    db.close();
    expect([stray.n, photos.n, parts.n]).toEqual([0, 0, 0]);
  });
});
