// What the contract page and the contract PDF are given: the contract, its
// items with the site and service named in the page's language, and the visits
// made for it.
import type { Db, DbStatements, Pdf } from "@renoxium/sdk";

import { type ContractRow, itemsOf, visitsOf } from "./contracts";
import { findCustomer } from "./customers";
import { brandOf, type Language } from "./invoice-view";
import { aed } from "./money";

interface PdfCtx {
  readonly db: DbStatements;
  readonly pdf: Pick<Pdf, "render">;
}

/** The yearly price, its 5 % VAT (rounded half up to the fil, as the module does) and the total, in AED. */
export function priceView(c: Pick<ContractRow, "price_fils" | "vat_rate">) {
  const vat = Math.floor((c.price_fils * c.vat_rate + 50) / 100);
  return { price: c.price_fils / 100, vat: vat / 100, total: (c.price_fils + vat) / 100, total_text: aed(c.price_fils + vat) };
}

export async function itemViews(ctx: { readonly db: DbStatements }, sdb: Db, contract: string, language: Language) {
  const items = await itemsOf(sdb, contract);
  const out = [];
  for (const i of items) {
    const site = await sdb.queryOne<{ label: string; area: string; address: string }>("select label, area, address from app__sites where id = ?", [i.site_id]);
    const service = await ctx.db.queryOne<{ name_en: string; name_ar: string }>("select name_en, name_ar from app__services where id = ?", [i.service_id]);
    out.push({
      id: i.id,
      site: site === null ? "" : site.label,
      address: site === null ? "" : `${site.area}, ${site.address}`,
      service: service === null ? "" : language === "ar" ? service.name_ar : service.name_en,
      visits_per_year: i.visits_per_year,
      next_visit_on: i.next_visit_on,
    });
  }
  return out;
}

export async function visitViews(ctx: { readonly db: DbStatements }, sdb: Db, contract: string, language: Language) {
  const visits = await visitsOf(sdb, contract);
  const out = [];
  for (const v of visits) {
    const service = await ctx.db.queryOne<{ name_en: string; name_ar: string }>("select name_en, name_ar from app__services where id = ?", [v.service_id]);
    const site = await sdb.queryOne<{ label: string }>("select label from app__sites where id = ?", [v.site_id]);
    out.push({ job_id: v.job_id, number: v.number, status: v.status, due_on: v.due_on, service: service === null ? "" : language === "ar" ? service.name_ar : service.name_en, site: site === null ? "" : site.label });
  }
  return out;
}

/** The contract as a PDF in `language`: the parties, the term, the services and sites with their visit counts, the yearly price. */
export async function contractPdf(ctx: PdfCtx, sdb: Db, contract: ContractRow, language: Language): Promise<Uint8Array> {
  const customer = await findCustomer(sdb, contract.customer_id);
  const items = await itemViews(ctx, sdb, contract.id, language);
  const data = {
    number: contract.number,
    status: contract.status,
    starts_on: contract.starts_on,
    ends_on: contract.ends_on,
    customer: { name: customer?.name ?? "", trn: customer?.trn ?? null, phone: customer?.phone ?? "" },
    items,
    total_visits: items.reduce((n, i) => n + i.visits_per_year, 0),
    notes: contract.notes,
    has_notes: contract.notes !== "",
    ...priceView(contract),
    brand: await brandOf(ctx.db, language),
  };
  return ctx.pdf.render(`partials/pdf/contract.${language}`, data, { page: "A4" });
}
