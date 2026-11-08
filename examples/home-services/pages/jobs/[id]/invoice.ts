// POST /jobs/:id/invoice: issues the tax invoice of a done job (lib/invoices.ts).
// `invoice.issue` is a sensitive action: the accountant or the owner, with a
// recent second factor; anyone else, or the same person without it, is a 403
// (and the platform audits the decision). A job that already has its invoice,
// or is not done, is a 409; a job with nothing to invoice a 422. On success the
// answer is a redirect to the invoice. A GET goes back to the job.
import type { ActionContext } from "@renoxium/sdk";
import { twofa } from "renox:modules";

import { issueInvoice } from "../../../lib/invoices";

const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });

export const guard = { action: "job.read" };

export function load(ctx: { readonly params: Record<string, string> }): Response {
  return redirect(`/jobs/${ctx.params.id}`);
}

export const actions = {
  async default(ctx: ActionContext) {
    try {
      await ctx.authz.require("invoice.issue");
    } catch (e) {
      if ((e as { code?: string }).code === "RENOX_FORBIDDEN") return plain(403, "Forbidden");
      throw e;
    }
    await twofa.requireRecent({ next: `/jobs/${ctx.params.id}` });
    const r = await issueInvoice(ctx, ctx.params.id);
    return r.ok ? redirect(`/invoices/${r.value.number}`) : plain(r.status, r.message);
  },
};
