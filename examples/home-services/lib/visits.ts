// The technician's visit: check-in, photos, parts, notes, the drawn signature
// and check-out. A visit belongs to one job and is opened by the check-in;
// check-in moves the job to `in_progress` and check-out to `done`, both through
// `transition` of lib/jobs.ts (the table, the job event, the audit record and
// the card on the dispatch board). `visit.perform` is the technician's, on a job
// that is theirs (policies/app/base.cedar forbids it on any other); every
// function here that changes a visit starts with that check.
//
// Photos and the signature are files of the platform store (`ctx.storage`)
// under `app/visits/<visit id>/` (the app's keys live under `app/`); the rows keep the keys. Photos stay private: the
// page shows them through short-lived signed URLs.
import type { Ai, Db, Storage } from "@renoxium/sdk";
import { type JobCtx, type JobRow, findJob, jobResource, transition } from "./jobs";
import { issueLink } from "./links";
import { notifyCustomer } from "./notify";
import { buildReport } from "./report";
import { branchOf, scopedDb, type Branch } from "./scope";
import { draftSummary } from "./summary";
import { memberName } from "./technicians";
import { type PartRow, type PhotoRow, type VisitRow, bytesOfDataUrl, partsOf, photoLimitMessage, visitOfJob } from "./visit-data";
import type { PartInput, Phase } from "./visit-forms";

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
/** The largest signature image (a canvas drawing is a few kilobytes). */
const MAX_SIGNATURE_BYTES = 200_000;
/** How long the customer's link to the report works: 30 days. */
const REPORT_LINK_SECONDS = 30 * 24 * 3600;

/** What the visit's actions need of the ctx. */
export interface VisitCtx extends JobCtx {
  readonly storage: Storage;
  readonly ai: Ai;
  readonly pdf: import("@renoxium/sdk").Pdf;
}

export type Failure = { ok: false; status: 403 | 404 | 409 | 413 | 415 | 422; message: string };
export type Result<T> = { ok: true; value: T } | Failure;
const fail = (status: Failure["status"], message: string): Failure => ({ ok: false, status, message });

const now = (): number => Math.floor(Date.now() / 1000);
const token = (): string => crypto.randomUUID().replace(/-/gu, "").slice(0, 16);

export interface Performer {
  branch: Branch;
  sdb: Db;
  job: JobRow;
  visit: VisitRow | null;
}

/**
 * The job (of the active branch) and its visit for the technician who may
 * perform it: 403 for anyone else (the policy: `visit.perform` on a job that is
 * not theirs), 404 for a job of another branch or none.
 */
export async function performerOf(ctx: VisitCtx, rawJobId: unknown): Promise<Result<Performer>> {
  const branch = await branchOf(ctx);
  if (branch === null) return fail(403, "No branch is active for this account.");
  const sdb = scopedDb(ctx.db, branch);
  const job = await findJob(sdb, rawJobId);
  if (job === null) return fail(404, "Job not found");
  try {
    await ctx.authz.require("visit.perform", jobResource(job, ctx.principal?.id ?? null));
  } catch (e) {
    if ((e as { code?: string }).code === "RENOX_FORBIDDEN") return fail(403, "Forbidden");
    throw e;
  }
  return { ok: true, value: { branch, sdb, job, visit: await visitOfJob(sdb, job.id) } };
}

/** The visit while it is open: 409 before the check-in and after the check-out. */
function open(p: Performer): Result<VisitRow> {
  if (p.visit === null) return fail(409, "Check in first.");
  if (p.visit.checkout_at !== null) return fail(409, "This visit is closed.");
  return { ok: true, value: p.visit };
}

/** Opens the visit and moves the job to `in_progress` (a job that already is stays so). Twice is a 409. */
export async function checkIn(ctx: VisitCtx, rawJobId: unknown, position: { lat: number | null; lng: number | null }): Promise<Result<VisitRow>> {
  const got = await performerOf(ctx, rawJobId);
  if (!got.ok) return got;
  const p = got.value;
  if (p.visit !== null) return fail(409, "You are already checked in to this visit.");
  if (p.job.status !== "scheduled" && p.job.status !== "en_route" && p.job.status !== "in_progress") return fail(409, `A ${p.job.status.replace("_", " ")} job cannot be visited.`);
  if (p.job.status !== "in_progress") {
    const moved = await transition(ctx, p.job.id, "in_progress", "checked in");
    if (!moved.ok) return fail(moved.status === 403 ? 403 : moved.status === 404 ? 404 : 409, moved.message);
  }
  const id = `vs_${token()}`;
  const who = ctx.principal?.id ?? p.job.technician_user_id ?? "";
  await p.sdb.execute("insert into app__visits (id, branch_id, job_id, technician_user_id, technician_name, checkin_at, checkin_lat, checkin_lng) values (?, ?, ?, ?, ?, ?, ?, ?)", [
    id,
    p.branch.id,
    p.job.id,
    who,
    await memberName(p.branch, who),
    now(),
    position.lat,
    position.lng,
  ]);
  return { ok: true, value: (await visitOfJob(p.sdb, p.job.id)) as VisitRow };
}

export interface PhotoUpload {
  type: string;
  bytes: Uint8Array;
  caption: string;
}

/**
 * Stores a photo of the phase under `app/visits/<visit id>/<phase>/`. Over
 * MAX_PHOTO_BYTES is a 413 naming the limit; a type that is not JPEG, PNG or
 * WebP is a 415.
 */
export async function addPhoto(ctx: VisitCtx, rawJobId: unknown, phase: Phase, upload: PhotoUpload): Promise<Result<PhotoRow>> {
  const got = await performerOf(ctx, rawJobId);
  if (!got.ok) return got;
  const visit = open(got.value);
  if (!visit.ok) return visit;
  const tooLarge = photoLimitMessage(upload.bytes.length);
  if (tooLarge !== null) return fail(413, tooLarge);
  if (upload.bytes.length === 0) return fail(422, "The photo is empty.");
  const ext = EXTENSION[upload.type];
  if (ext === undefined) return fail(415, "A photo is a JPEG, PNG or WebP image.");
  const path = `app/visits/${visit.value.id}/${phase}/${Date.now().toString(36)}-${token().slice(0, 6)}.${ext}`;
  let stored;
  try {
    stored = await ctx.storage.put(path, upload.bytes, { contentType: upload.type });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "RENOX_STORAGE_TOO_LARGE") return fail(413, "The storage refused the photo: it is too large.");
    if (code === "RENOX_STORAGE_TYPE") return fail(415, "The storage refused the photo: it is not an image it can read.");
    throw e;
  }
  const n = await got.value.sdb.execute("insert into app__visit_photos (branch_id, visit_id, phase, file_key, caption, width, height, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)", [
    got.value.branch.id,
    visit.value.id,
    phase,
    stored.key,
    upload.caption,
    stored.width,
    stored.height,
    now(),
  ]);
  const row = await got.value.sdb.queryOne<PhotoRow>("select id, visit_id, phase, file_key, caption, width, height from app__visit_photos where id = ?", [Number(n.lastInsertRowid)]);
  return { ok: true, value: row as PhotoRow };
}

export async function addPart(ctx: VisitCtx, rawJobId: unknown, part: PartInput): Promise<Result<PartRow>> {
  const got = await performerOf(ctx, rawJobId);
  if (!got.ok) return got;
  const visit = open(got.value);
  if (!visit.ok) return visit;
  const n = await got.value.sdb.execute("insert into app__visit_parts (branch_id, visit_id, description, qty, unit_price_fils) values (?, ?, ?, ?, ?)", [got.value.branch.id, visit.value.id, part.description, part.qty, part.unit_price_fils]);
  return { ok: true, value: { id: Number(n.lastInsertRowid), ...part } };
}

export async function removePart(ctx: VisitCtx, rawJobId: unknown, partId: number): Promise<Result<true>> {
  const got = await performerOf(ctx, rawJobId);
  if (!got.ok) return got;
  const visit = open(got.value);
  if (!visit.ok) return visit;
  await got.value.sdb.execute("delete from app__visit_parts where id = ? and visit_id = ?", [partId, visit.value.id]);
  return { ok: true, value: true };
}

export async function saveNotes(ctx: VisitCtx, rawJobId: unknown, notes: string): Promise<Result<true>> {
  const got = await performerOf(ctx, rawJobId);
  if (!got.ok) return got;
  const visit = open(got.value);
  if (!visit.ok) return visit;
  await got.value.sdb.execute("update app__visits set notes = ? where id = ?", [notes, visit.value.id]);
  return { ok: true, value: true };
}

/** Stores the drawn signature (a PNG) and the name of whoever signed; signing again replaces it. */
export async function saveSignature(ctx: VisitCtx, rawJobId: unknown, signature: { data: string; name: string }): Promise<Result<true>> {
  const got = await performerOf(ctx, rawJobId);
  if (!got.ok) return got;
  const visit = open(got.value);
  if (!visit.ok) return visit;
  const png = bytesOfDataUrl(signature.data);
  if (png === null || png.type !== "image/png" || png.bytes.length === 0 || png.bytes.length > MAX_SIGNATURE_BYTES) return fail(422, "The signature is not a PNG image of a drawing.");
  const path = `app/visits/${visit.value.id}/signature-${Date.now().toString(36)}.png`;
  await ctx.storage.put(path, png.bytes, { contentType: "image/png" });
  if (visit.value.signature_key !== null) await ctx.storage.delete(visit.value.signature_key);
  await got.value.sdb.execute("update app__visits set signature_key = ?, signed_by_name = ? where id = ?", [path, signature.name, visit.value.id]);
  return { ok: true, value: true };
}

/** Sets the report's summary (the technician's or a dispatcher's edit) and rebuilds the report. `sdb` is the active branch's. */
export async function setSummary(ctx: Pick<VisitCtx, "db" | "storage" | "pdf">, sdb: Db, visit: VisitRow, summary: { summary_en: string; summary_ar: string }): Promise<void> {
  await sdb.execute("update app__visits set summary_en = ?, summary_ar = ? where id = ?", [summary.summary_en, summary.summary_ar, visit.id]);
  if (visit.checkout_at !== null) await buildReport(ctx, visit.id);
}

export interface CheckedOut {
  visit: VisitRow;
  /** Whether the AI wrote the summary: `off` without a provider, `quota` when the allowance is used up, `on` otherwise. */
  ai: "on" | "off" | "quota";
}

/**
 * Closes the visit and moves the job to `done`. The summary fields the
 * technician left empty are drafted by `ctx.ai` from the notes and the parts
 * (they stay empty when the AI is off); then the report is built. Photos and a
 * signature are not required.
 */
export async function checkOut(ctx: VisitCtx, rawJobId: unknown): Promise<Result<CheckedOut>> {
  const got = await performerOf(ctx, rawJobId);
  if (!got.ok) return got;
  const p = got.value;
  const visit = open(p);
  if (!visit.ok) return visit;
  const moved = await transition(ctx, p.job.id, "done", "checked out");
  if (!moved.ok) return fail(moved.status === 403 ? 403 : moved.status === 404 ? 404 : 409, moved.message);
  const parts = await partsOf(p.sdb, visit.value.id);
  const service = await ctx.db.queryOne<{ name_en: string }>("select name_en from app__services where id = ?", [p.job.service_id]);
  let { summary_en: en, summary_ar: ar } = visit.value;
  let ai: CheckedOut["ai"] = "on";
  if (en === "" && ar === "") {
    const draft = await draftSummary(ctx.ai, { service: service?.name_en ?? "", notes: visit.value.notes, parts });
    en = draft.en;
    ar = draft.ar;
    ai = draft.ai;
  }
  await p.sdb.execute("update app__visits set checkout_at = ?, summary_en = ?, summary_ar = ? where id = ?", [now(), en, ar, visit.value.id]);
  await buildReport(ctx, visit.value.id);
  // The customer gets the link to the report; the dispatcher who made the job is told it is done (F7-124).
  const link = await issueLink(ctx, "report", visit.value.id, REPORT_LINK_SECONDS);
  await notifyCustomer(ctx, { id: p.job.customer_id }, "report_ready", {
    branch_id: p.branch.id,
    ref_id: visit.value.id,
    job_id: p.job.id,
    customer_link: link,
    vars: { job: p.job.number },
    staff_user: p.job.created_by,
    title: `Visit of job ${p.job.number} is done`,
    link: `/jobs/${p.job.id}`,
    staff_category: "jobs",
  });
  return { ok: true, value: { visit: (await visitOfJob(p.sdb, p.job.id)) as VisitRow, ai } };
}
