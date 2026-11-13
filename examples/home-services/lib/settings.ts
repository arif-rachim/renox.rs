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

/**
 * Whether a self-booking (/book, #775) is confirmed at once: the setting
 * `portal_auto_confirm` is "1". Off by default: the job waits as `new` for the
 * dispatcher, with the requested time kept.
 */
export const portalAutoConfirm = (settings: Settings): boolean => settings.portal_auto_confirm === "1";

/**
 * The customer portal's change rules (#778): until how many hours before the
 * slot a customer may still cancel or move a visit on /my
 * (`portal_cutoff_hours`, a whole number 0 to 168, default 12), and how often
 * one visit may be moved (`portal_max_reschedules`, 0 to 5, default 2). A
 * missing or out-of-range value reads as the default. The fields on
 * /admin/settings come with the dispatcher issue (#779).
 */
export const PORTAL_CUTOFF_HOURS = { key: "portal_cutoff_hours", min: 0, max: 168, default: 12 } as const;
export const PORTAL_MAX_RESCHEDULES = { key: "portal_max_reschedules", min: 0, max: 5, default: 2 } as const;

const wholeIn = (raw: string | undefined, rule: { readonly min: number; readonly max: number; readonly default: number }): number => {
  const v = (raw ?? "").trim();
  if (!/^\d{1,3}$/u.test(v)) return rule.default;
  const n = Number(v);
  return n >= rule.min && n <= rule.max ? n : rule.default;
};

export const portalCutoffHours = (settings: Settings): number => wholeIn(settings[PORTAL_CUTOFF_HOURS.key], PORTAL_CUTOFF_HOURS);
export const portalMaxReschedules = (settings: Settings): number => wholeIn(settings[PORTAL_MAX_RESCHEDULES.key], PORTAL_MAX_RESCHEDULES);

/**
 * How a customer pays an open invoice (#777: no online payment, D31): plain
 * text in English and in Arabic, at most PAYMENT_INSTRUCTIONS_MAX characters
 * each, shown on /my/invoices/<number> while the invoice is open; empty hides
 * the block.
 */
export const PAYMENT_INSTRUCTION_KEYS = ["payment_instructions_en", "payment_instructions_ar"] as const;
export const PAYMENT_INSTRUCTIONS_MAX = 500;

/**
 * The payment instructions a settings form sends: each field the form holds,
 * trimmed, with Windows line ends made plain (a field the form does not send
 * is left as it is); a text over the limit is an error keyed by its field.
 */
export function paymentInstructionsOf(form: FormData): { value: Partial<Record<(typeof PAYMENT_INSTRUCTION_KEYS)[number], string>> } | { errors: Record<string, string> } {
  const value: Partial<Record<(typeof PAYMENT_INSTRUCTION_KEYS)[number], string>> = {};
  const errors: Record<string, string> = {};
  for (const key of PAYMENT_INSTRUCTION_KEYS) {
    const raw = form.get(key);
    if (typeof raw !== "string") continue;
    const text = raw.replace(/\r\n?/gu, "\n").trim();
    if (text.length > PAYMENT_INSTRUCTIONS_MAX) errors[key] = "backoffice.err.payment_instructions";
    else value[key] = text;
  }
  return Object.keys(errors).length > 0 ? { errors } : { value };
}

/** Where the layout loads the logo from: the image path of the platform (`/_img`, a public key needs no signature), or null without a logo. */
export function logoSrc(settings: Settings): string | null {
  const key = settings.brand_logo_key ?? "";
  if (key === "") return null;
  // An SVG is served as it is, by /_files (a public key needs no signature).
  return key.endsWith(".svg") ? `/_files/${key}` : `/_img/${key}?w=400`;
}
