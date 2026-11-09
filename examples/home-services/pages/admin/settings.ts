// GET /admin/settings: the branding form. POST ?/save changes the company's
// settings (`settings.write`, sensitive: the owner with a recent second
// factor; every decision is audited): the names, the colour (#rrggbb; anything
// else is a 422), the footers, the sender name, the accounts email, and the logo (multipart `logo`: a PNG, JPEG or WebP up to
// 512 KB, stored public under app/brand/ and loaded through /_img). The layout,
// the PDFs, the mails and the WhatsApp texts read these settings (lib/settings.ts).
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { brandingSchema, saveSettings, sensitive, storeLogo } from "../../lib/admin";
import { check } from "../../lib/forms";
import { bytesOfDataUrl } from "../../lib/visit-data";
import { shell } from "../../lib/page";
import { unprocessable } from "../../lib/problems";
import { getSettings, logoSrc } from "../../lib/settings";

export const guard = { action: "settings.read" };

const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const s = await getSettings(ctx.db);
  const saved = ctx.url.searchParams.get("saved");
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
    },
  };
}

export const actions = {
  async save(ctx: ActionContext) {
    const refused = await sensitive(ctx, "settings.write", "/admin/settings");
    if (refused !== null) return refused;
    const page = await shell(ctx);
    const input = await check(ctx.form, brandingSchema);
    if ("errors" in input) return unprocessable(page.locale, input.errors, "/admin/settings");
    const current = await getSettings(ctx.db);
    const next: Record<string, string> = { ...input.value };
    // The logo is optional: no file leaves the current one.
    let logo = false;
    const file = ctx.form.get("logo");
    let upload: { type: string; bytes: Uint8Array } | null = null;
    if (file instanceof File && file.size > 0) upload = { type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
    else if (typeof ctx.form.get("logo_data") === "string") upload = bytesOfDataUrl(String(ctx.form.get("logo_data")).trim());
    if (upload !== null) {
      const stored = await storeLogo(ctx.storage, upload, current.brand_logo_key ?? "");
      if (!stored.ok) return unprocessable(page.locale, { logo: `backoffice.err.logo_${stored.error}` }, "/admin/settings");
      next.brand_logo_key = stored.key;
      logo = true;
    }
    await saveSettings(ctx, current, next);
    return redirect(`/admin/settings?saved=${logo ? "logo" : "1"}`);
  },
};

