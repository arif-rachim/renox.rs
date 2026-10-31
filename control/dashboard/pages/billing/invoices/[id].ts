// GET /billing/invoices/:id: the tax invoice as a PDF (#325; deploy-api.md
// 0.5.1 section 20, "Invoice PDF"). The API answers the invoice as JSON with
// the owner's token; the dashboard renders `partials/invoice.html` (English
// and Arabic, bundled Noto fonts) with `ctx.pdf` in Rust. A member's token
// gets the API's 403 and the page says so; another tenant's id is 404.
import type { LoaderContext } from "renox";

import { problem, signedIn } from "../../../lib/guard.ts";
import { clock } from "../../../lib/view.ts";

const ID = /^INV-[0-9]{4}-[0-9]{6}$/u;

export async function load(ctx: LoaderContext) {
  const api = await signedIn(ctx);
  if (api instanceof Response) return api;
  const id = String(ctx.params.id ?? "");
  if (!ID.test(id)) return new Response("Not found", { status: 404 });
  const apps = await api.listApps();
  const tenant = apps.ok ? apps.value.apps[0]?.tenant_id : undefined;
  if (tenant === undefined) return new Response("Not found", { status: 404 });
  const [inv, b] = await Promise.all([api.getInvoice(tenant, id), api.getBilling(tenant)]);
  if (!inv.ok) {
    const p = await problem(ctx, inv);
    return new Response(p.message, { status: inv.status === 0 ? 502 : inv.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const i = inv.value;
  const buyer = b.ok ? b.value.profile : null;
  const pdf = await ctx.pdf.render("partials/invoice", {
    ...i,
    issued: clock(i.issued_at).slice(0, 10),
    period_text: `${clock(i.period.start).slice(0, 10)} – ${clock(i.period.end).slice(0, 10)}`,
    buyer_name: buyer?.legal_name ?? "",
    buyer_address: buyer?.address ?? "",
  });
  return new Response(pdf as Uint8Array<ArrayBuffer>, {
    headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${id}.pdf"`, "cache-control": "no-store" },
  });
}
