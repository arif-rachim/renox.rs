// GET /me/visits/:id (the id is the job's): the technician's visit from a phone.
// Check in (with the browser's position, if shared), photos before and after,
// parts, notes, the customer's drawn signature, check out. `visit.perform` on a
// job that is the signed-in technician's: anyone else's is a 403 (the policy),
// another branch's a 404. Check-in moves the job to `in_progress` and check-out
// to `done` (lib/visits.ts, through lib/jobs.ts); check-out also drafts the
// report's summary with the AI and builds the PDF.
//
// POST ?/checkin, ?/photo_url (the file's name, type and size: answers a signed
// upload URL as JSON, which public/upload.js PUTs the file to), ?/photo (the
// stored `key`, with `phase` and `caption`; lib/visits.ts), ?/part, ?/removePart, ?/notes, ?/signature,
// ?/checkout, ?/summary. A refusal answers with its status and the reason:
// 409 (twice, closed, check in first), 413 (a photo over 10 MiB, naming the
// limit), 415 (not an image), 422 (a form that is wrong, naming the field).
//
// Every action but `photo_url` goes through `withActionId` (lib/action-log.ts): with an `action_id` it runs
// once however often it is posted, answers a conflict with the job's state (cancelled, reassigned, already
// checked out, not checked in) as a 409 with its reason, and, on `Accept: application/json`, answers JSON;
// without one it is as it always was. `performed_at` (unix ms) is the time a queued action happened.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";
import { storage } from "renox:modules";

import { clock } from "../../../lib/booking-sync";
import { withActionId } from "../../../lib/action-log";
import { check } from "../../../lib/forms";
import { shell } from "../../../lib/page";
import { invalid } from "../../../lib/invalid";
import { day } from "../../../lib/quotes";
import { aed } from "../../../lib/money";
import { imageOf, partsOf, partTotal, photosOf, type VisitRow } from "../../../lib/visit-data";
import { checkinSchema, notesSchema, PHASES, partSchema, signatureSchema, summarySchema, type Phase } from "../../../lib/visit-forms";
import { addPart, addPhoto, photoUploadUrl, checkIn, checkOut, performerOf, removePart, saveNotes, saveSignature, setSummary, type Failure } from "../../../lib/visits";

export const guard = { action: "visit.perform" };

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const when = (seconds: number): string => `${day(seconds)} ${clock(seconds)}`;

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const got = await performerOf(ctx, ctx.params.id);
  if (!got.ok) return plain(got.status, got.message);
  const { sdb, job, visit } = got.value;
  const customer = await sdb.queryOne<{ id: string; name: string; phone: string }>("select id, name, phone from app__customers where id = ?", [job.customer_id]);
  const site = await sdb.queryOne<{ label: string; area: string; address: string; access_notes: string }>("select label, area, address, access_notes from app__sites where id = ?", [job.site_id]);
  const service = await ctx.db.queryOne<{ name_en: string; name_ar: string }>("select name_en, name_ar from app__services where id = ?", [job.service_id]);
  const canCheckIn = visit === null && (job.status === "scheduled" || job.status === "en_route" || job.status === "in_progress");
  const isOpen = visit !== null && visit.checkout_at === null;
  const photos = visit === null ? [] : await photosOf(sdb, visit.id);
  const view = async (phase: Phase) => {
    const out = [];
    for (const p of photos.filter((x) => x.phase === phase)) {
      out.push({ id: p.id, caption: p.caption, image: p.width !== null && p.height !== null ? await imageOf(ctx.storage, p, 3600, storage) : null });
    }
    return out;
  };
  const parts = visit === null ? [] : (await partsOf(sdb, visit.id)).map((p) => ({ id: p.id, description: p.description, qty: p.qty, price: aed(p.unit_price_fils), total: aed(partTotal(p)) }));
  const partsTotal = visit === null ? 0 : (await partsOf(sdb, visit.id)).reduce((n, p) => n + partTotal(p), 0);
  return {
    ...page,
    job: {
      id: job.id,
      number: job.number,
      status: job.status,
      description: job.description,
      start: job.scheduled_start === null ? "" : when(job.scheduled_start),
      service: service === null ? "" : page.locale === "ar" ? service.name_ar : service.name_en,
    },
    customer,
    site,
    can_checkin: canCheckIn,
    open: isOpen,
    closed: visit !== null && visit.checkout_at !== null,
    visit:
      visit === null
        ? null
        : {
            id: visit.id,
            checkin: when(visit.checkin_at),
            checkout: visit.checkout_at === null ? "" : when(visit.checkout_at),
            notes: visit.notes,
            summary_en: visit.summary_en,
            summary_ar: visit.summary_ar,
            signed_by: visit.signed_by_name,
            signature: visit.signature_key === null ? null : await imageOf(ctx.storage, { file_key: visit.signature_key, width: null, height: null }),
          },
    phases: PHASES.map((phase) => ({ phase })),
    before: await view("before"),
    after: await view("after"),
    parts,
    has_parts: parts.length > 0,
    parts_total: aed(partsTotal),
    report: visit !== null && visit.checkout_at !== null,
    values: {},
  };
}

const isPhase = (v: unknown): v is Phase => typeof v === "string" && (PHASES as readonly string[]).includes(v);

export const actions = {
  async checkin(ctx: ActionContext) {
    return withActionId(ctx, "checkin", ctx.params.id, async ({ page, at }) => {
      const input = await check(ctx.form, checkinSchema);
      if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
      return checkIn(ctx, ctx.params.id, input.value, at);
    });
  },

  /** Step one of a photo (`upload.js`): a signed URL for the browser's PUT, as JSON `{ url, max_bytes }`; a refusal is JSON `{ message }` with its status. Changes nothing, so it is not logged. */
  async photo_url(ctx: ActionContext) {
    const size = ctx.form.get("size");
    const r = await photoUploadUrl(storage, ctx, ctx.params.id, {
      name: String(ctx.form.get("name") ?? ""),
      type: String(ctx.form.get("type") ?? ""),
      size: typeof size === "string" && /^\d+$/u.test(size) ? Number(size) : null,
    });
    const headers = { "cache-control": "no-store" };
    return r.ok ? Response.json(r.value, { headers }) : Response.json({ message: (r as Failure).message }, { status: (r as Failure).status, headers });
  },

  /** Step two: the form posts the key the upload stored, with the phase and the caption. */
  async photo(ctx: ActionContext) {
    return withActionId(ctx, "photo", ctx.params.id, async ({ page }) => {
      const phase = ctx.form.get("phase");
      if (!isPhase(phase)) return invalid(page.locale, ctx.form, { phase: "visits.err.phase" });
      const caption = String(ctx.form.get("caption") ?? "").trim().slice(0, 200);
      return addPhoto(storage, ctx, ctx.params.id, phase, { key: ctx.form.get("key"), caption });
    });
  },

  async part(ctx: ActionContext) {
    return withActionId(ctx, "part", ctx.params.id, async ({ page }) => {
      const input = await check(ctx.form, partSchema);
      if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
      return addPart(ctx, ctx.params.id, input.value);
    });
  },

  async removePart(ctx: ActionContext) {
    return withActionId(ctx, "removePart", ctx.params.id, async () => {
      const id = Number(ctx.form.get("part"));
      if (!Number.isSafeInteger(id)) return { ok: false as const, status: 422 as const, message: "Choose a part." };
      return removePart(ctx, ctx.params.id, id);
    });
  },

  async notes(ctx: ActionContext) {
    return withActionId(ctx, "notes", ctx.params.id, async ({ page }) => {
      const input = await check(ctx.form, notesSchema);
      if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
      return saveNotes(ctx, ctx.params.id, input.value.notes);
    });
  },

  async signature(ctx: ActionContext) {
    return withActionId(ctx, "signature", ctx.params.id, async ({ page }) => {
      const input = await check(ctx.form, signatureSchema);
      if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
      return saveSignature(ctx, ctx.params.id, input.value);
    });
  },

  async checkout(ctx: ActionContext) {
    return withActionId(ctx, "checkout", ctx.params.id, async ({ at }) => checkOut(ctx, ctx.params.id, at));
  },

  /** The technician's edit of the summary, before or after the check-out (the report is rebuilt). */
  async summary(ctx: ActionContext) {
    return withActionId(ctx, "summary", ctx.params.id, async ({ page }) => {
      const input = await check(ctx.form, summarySchema);
      if ("errors" in input) return invalid(page.locale, ctx.form, input.errors);
      const got = await performerOf(ctx, ctx.params.id);
      if (!got.ok) return got;
      const visit: VisitRow | null = got.value.visit;
      if (visit === null) return { ok: false as const, status: 409 as const, message: "Check in first." };
      await setSummary(ctx, got.value.sdb, visit, input.value);
      return { ok: true as const, value: true };
    });
  },
};
