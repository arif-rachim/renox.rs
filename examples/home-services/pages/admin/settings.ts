// GET /admin/settings: the branding form. POST ?/save changes the company's
// settings (`settings.write`, sensitive: the owner with a recent second
// factor; every decision is audited): the names, the colour (#rrggbb; anything
// else is a 422), the footers, the sender name, the accounts email, and the logo (multipart `logo`: a PNG, JPEG or WebP up to
// 512 KB, stored public under app/brand/ and loaded through /_img). The layout,
// the PDFs, the mails and the WhatsApp texts read these settings (lib/settings.ts).
// The payment instructions in English and Arabic (#777, plain text up to 500
// characters each; over that is a 422 naming the field) are shown to a
// customer on an open invoice of /my/invoices; empty hides them.
// The "Customer portal" section (#779): whether an online booking (/book) is
// confirmed at once (`portal_auto_confirm`, off by default: the dispatcher
// confirms it), until how many hours before a visit a customer may change it
// on /my (`portal_cutoff_hours`, 0 to 168) and how often (`portal_max_reschedules`,
// 0 to 5), the payment instructions, and the public link of /book to share.
// A number out of range is a 422 naming the field; a change is in the same
// `settings.update` audit row as the rest of the form.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { brandingSchema, saveSettings, sensitive, storeLogo } from "../../lib/admin";
import { check, valuesOf } from "../../lib/forms";
import { bytesOfDataUrl } from "../../lib/visit-data";
import { shell } from "../../lib/page";
import { invalid } from "../../lib/invalid";
import { getSettings, logoSrc, paymentInstructionsOf, PORTAL_CUTOFF_HOURS, PORTAL_MAX_RESCHEDULES, portalChanges, portalNow, portalSettingsOf } from "../../lib/settings";

export const guard = { action: "settings.read" };

/** The ranges of the portal's numbers, and the public link of /book on this app's own host. */
const portalLimits = (url: URL) => ({ cutoff: PORTAL_CUTOFF_HOURS, reschedules: PORTAL_MAX_RESCHEDULES, book_link: `https://${url.host}/book` });

const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const s = await getSettings(ctx.db);
  const saved = ctx.url.searchParams.get("saved");
  const portal = portalNow(s);
  return {
    ...page,
    saved: saved === "1" || saved === "logo",
    logo_changed: saved === "logo",
    logo_src: logoSrc(s),
    f: {
      brand_name: s.brand_name ?? "",
      brand_name_ar: s.brand_name_ar ?? "",
      brand_color: s.brand_color ?? "",
      brand_footer_en: s.brand_footer_en ?? "",
      brand_footer_ar: s.brand_footer_ar ?? "",
      sender_name: s.sender_name ?? "",
      accounts_email: s.accounts_email ?? "",
      payment_instructions_en: s.payment_instructions_en ?? "",
      payment_instructions_ar: s.payment_instructions_ar ?? "",
      portal_auto_confirm: portal.portal_auto_confirm === "1",
      portal_cutoff_hours: portal.portal_cutoff_hours,
      portal_max_reschedules: portal.portal_max_reschedules,
    },
    ...portalLimits(ctx.url),
  };
}

/** The 422 of the form: the errors, and the values as typed (the checkbox as sent: unchecked is off). */
function refusedForm(ctx: ActionContext, locale: string, errors: Record<string, string>) {
  const f: Record<string, unknown> = valuesOf(ctx.form);
  f.portal_auto_confirm = ctx.form.get("portal_auto_confirm") === "1";
  return { ...invalid(locale, ctx.form, errors), f, ...portalLimits(ctx.url) };
}

export const actions = {
  async save(ctx: ActionContext) {
    const refused = await sensitive(ctx, "settings.write", "/admin/settings");
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const input = await check(ctx.form, brandingSchema);
    const payment = paymentInstructionsOf(ctx.form);
    const portal = portalSettingsOf(ctx.form);
    if ("errors" in input || "errors" in payment || "errors" in portal) {
      const errors = { ...("errors" in input ? input.errors : {}), ...("errors" in payment ? payment.errors : {}), ...("errors" in portal ? portal.errors : {}) };
      return refusedForm(ctx, page.locale, errors);
    }
    const current = await getSettings(ctx.db);
    const next: Record<string, string> = { ...input.value, ...payment.value, ...portalChanges(current, portal.value) };
    // The logo is optional: no file leaves the current one.
    let logo = false;
    const file = ctx.form.get("logo");
    let upload: { type: string; bytes: Uint8Array } | null = null;
    if (file instanceof File && file.size > 0) upload = { type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
    else if (typeof ctx.form.get("logo_data") === "string") upload = bytesOfDataUrl(String(ctx.form.get("logo_data")).trim());
    if (upload !== null) {
      const stored = await storeLogo(ctx.storage, upload, current.brand_logo_key ?? "");
      if (!stored.ok) return refusedForm(ctx, page.locale, { logo: `backoffice.err.logo_${stored.error}` });
      next.brand_logo_key = stored.key;
      logo = true;
    }
    await saveSettings(ctx, current, next);
    return redirect(`/admin/settings?saved=${logo ? "logo" : "1"}`);
  },
};

