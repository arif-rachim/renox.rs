// The company's settings (app__settings): branding for the layout, PDFs and mails.
import type { DbStatements } from "@renoxium/sdk";

export type Settings = Record<string, string>;

/** Every setting as a key to value map. The statement is constant. */
export async function getSettings(db: DbStatements): Promise<Settings> {
  const rows = await db.query<{ key: string; value: string }>("select key, value from app__settings", []);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const COLOR = /^#[0-9a-fA-F]{6}$/u;

/** The brand colour when it is a #rrggbb value, else the platform's coral. */
export function brandColor(settings: Settings): string {
  const c = settings.brand_color ?? "";
  return COLOR.test(c) ? c : "#e8634a";
}

export type Lang = "en" | "ar";

/** The brand name in the language: the Arabic name when the company set one, else the English name. */
export function brandName(settings: Settings, lang: Lang): string {
  const ar = (settings.brand_name_ar ?? "").trim();
  return lang === "ar" && ar !== "" ? ar : (settings.brand_name ?? "");
}

/** The footer text in the language. */
export const brandFooter = (settings: Settings, lang: Lang): string => (lang === "ar" ? settings.brand_footer_ar : settings.brand_footer_en) ?? "";

/**
 * What a PDF template reads as `brand`. Templates do not interpolate inside
 * <style>, so the colour comes as style attributes. The logo is not here: the
 * PDF engine renders no images (docs/contracts/ops.md section 24, issue #573).
 */
export function pdfBrand(settings: Settings, lang: Lang) {
  const color = brandColor(settings);
  return { name: brandName(settings, lang), color, text_style: `color: ${color}`, rule_style: `border-bottom: 2pt solid ${color}`, footer: brandFooter(settings, lang) };
}

/** Where the layout loads the logo from: the image path of the platform (`/_img`, a public key needs no signature), or null without a logo. */
export function logoSrc(settings: Settings): string | null {
  const key = settings.brand_logo_key ?? "";
  return key === "" ? null : `/_img/${key}?w=400`;
}
