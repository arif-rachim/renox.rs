// The visit report: a PDF of the visit (who, where, when, the summary, the
// parts, the photos, the customer's signature) rendered by `ctx.pdf` from
// partials/pdf/visit-report.<lang>.html and kept in the platform store at
// `app/visits/<visit id>/report-<lang>.pdf`.
//
// No images in the PDF: `ctx.pdf` renders none (ops.md section 24: an `<img>`
// is dropped; a template that needs a picture prints its caption or key). Each
// photo is therefore listed by its phase, caption and file key, and the
// signature by the signer's name and the time. See the README, "Visit report".
import type { DbStatements, Pdf, Storage } from "@renoxium/sdk";

import { aed } from "./money";
import { getSettings, pdfBrand } from "./settings";
import { type Branch, branchDb, type Scopable } from "./scope";
import { memberName } from "./technicians";
import { partName, photosOf, partsOf, partTotal, visitById } from "./visit-data";

interface ReportCtx {
  readonly db: Scopable;
  readonly storage: Pick<Storage, "put">;
  readonly pdf: Pick<Pdf, "render">;
}

export type ReportLang = "en" | "ar";

const stamp = (seconds: number): string => {
  const d = new Date((seconds + 4 * 3600) * 1000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
};

/**
 * What the report's template is given, in the customer's language unless
 * `lang` says otherwise. `visitId` must be one the caller has already found
 * through the branch-scoped database: it is read here by id alone. Null when
 * there is no such visit. `publicView` is for the customer's link (no signed-in
 * user): the technician's name is the one kept on the visit, because the org
 * module answers its members only to a member.
 */
export async function reportData(ctx: ReportCtx, visitId: string, lang?: ReportLang, publicView = false) {
  const visit = await visitById(ctx.db, visitId);
  if (visit === null) return null;
  // Everything else is read through the visit's own branch.
  const sdb = branchDb(ctx.db, visit.branch_id);
  const job = await sdb.queryOne<{ number: string; customer_id: string; site_id: string; service_id: number; description: string; branch_id: string }>(
    "select number, customer_id, site_id, service_id, description, branch_id from app__jobs where id = ?",
    [visit.job_id],
  );
  if (job === null) return null;
  const customer = await sdb.queryOne<{ name: string; phone: string; language: string }>("select name, phone, language from app__customers where id = ?", [job.customer_id]);
  const site = await sdb.queryOne<{ label: string; area: string; address: string }>("select label, area, address from app__sites where id = ?", [job.site_id]);
  const service = await sdb.queryOne<{ name_en: string; name_ar: string }>("select name_en, name_ar from app__services where id = ?", [job.service_id]);
  const branch = await sdb.queryOne<{ name_en: string; name_ar: string; org_id: string }>("select name_en, name_ar, org_id from app__branches where id = ?", [job.branch_id]);
  const technician = publicView
    ? ((await ctx.db.queryOne<{ technician_name: string }>("select technician_name from app__visits where id = ?", [visit.id]))?.technician_name ?? "")
    : branch === null
      ? visit.technician_user_id
      : await memberName(ctx.db, branch, visit.technician_user_id);
  const own: ReportLang = customer?.language === "ar" ? "ar" : "en";
  const language: ReportLang = lang ?? own;
  const settings = await getSettings(sdb);
  const parts = (await partsOf(sdb, visit.id)).map((p) => ({ description: p.sku === null ? p.description : `${p.sku} · ${partName(p, language)}`, qty: p.qty, unit_price: p.unit_price_fils / 100, total: partTotal(p) / 100 }));
  const photos = (await photosOf(sdb, visit.id)).map((p) => ({ phase: p.phase, caption: p.caption, file_key: p.file_key }));
  const data = {
    job_number: job.number,
    service: (language === "ar" ? service?.name_ar : service?.name_en) ?? "",
    description: job.description,
    customer: { name: customer?.name ?? "", phone: customer?.phone ?? "" },
    site,
    branch: { name: (language === "ar" ? branch?.name_ar : branch?.name_en) ?? "" },
    technician,
    checkin: stamp(visit.checkin_at),
    checkout: visit.checkout_at === null ? "" : stamp(visit.checkout_at),
    notes: visit.notes,
    summary: language === "ar" ? visit.summary_ar : visit.summary_en,
    parts,
    parts_total: aed(parts.reduce((n, p) => n + Math.round(p.total * 100), 0)),
    has_parts: parts.length > 0,
    before: photos.filter((p) => p.phase === "before"),
    after: photos.filter((p) => p.phase === "after"),
    no_photos: photos.length === 0,
    signed_by: visit.signed_by_name,
    // The visit keeps no separate signing time: the signature is taken at check-out.
    signed_at: stamp(visit.checkout_at ?? visit.checkin_at),
    brand: pdfBrand(settings, language),
  };
  return { visit, data, language, own };
}

/**
 * Renders the visit's report, stores the PDF and, for the customer's
 * language, saves its key as the visit's `report_key`. Null when there is no
 * such visit (see `reportData`).
 */
export async function buildReport(ctx: ReportCtx, visitId: string, lang?: ReportLang, publicView = false): Promise<{ key: string; bytes: Uint8Array; lang: ReportLang } | null> {
  const r = await reportData(ctx, visitId, lang, publicView);
  if (r === null) return null;
  const bytes = await ctx.pdf.render(`partials/pdf/visit-report.${r.language}`, r.data, { page: "A4" });
  const key = `app/visits/${r.visit.id}/report-${r.language}.pdf`;
  await ctx.storage.put(key, bytes, { contentType: "application/pdf" });
  if (r.language === r.own) await branchDb(ctx.db, r.visit.branch_id).execute("update app__visits set report_key = ? where id = ?", [key, r.visit.id]);
  return { key, bytes, lang: r.language };
}
