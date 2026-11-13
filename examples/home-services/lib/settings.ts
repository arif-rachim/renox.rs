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
 * missing or out-of-range value reads as the default. They are set in the
 * "Customer portal" section of /admin/settings and by the owner connector's
 * `update_settings` (#779).
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

/** The portal's three settings as app__settings stores them (#779): the switch as "1" or "0", the two numbers as whole numbers. */
export type PortalSettings = { portal_auto_confirm: "1" | "0"; portal_cutoff_hours: string; portal_max_reschedules: string };

/** A whole number of `rule`'s range as typed (digits only), or null. */
export function wholeOf(raw: unknown, rule: { readonly min: number; readonly max: number }): number | null {
  const v = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isInteger(raw) ? String(raw) : "";
  if (!/^\d{1,3}$/u.test(v)) return null;
  const n = Number(v);
  return n >= rule.min && n <= rule.max ? n : null;
}

/**
 * The "Customer portal" section of /admin/settings (#779): only when the form
 * holds the section (its hidden `portal_section`), so another form that posts
 * the same action leaves the portal as it is. The checkbox sends "1" when on
 * and nothing when off; a number outside its range is an error keyed by its
 * field.
 */
export function portalSettingsOf(form: FormData): { value: Partial<PortalSettings> } | { errors: Record<string, string> } {
  if (form.get("portal_section") !== "1") return { value: {} };
  const errors: Record<string, string> = {};
  const cutoff = wholeOf(form.get(PORTAL_CUTOFF_HOURS.key), PORTAL_CUTOFF_HOURS);
  const max = wholeOf(form.get(PORTAL_MAX_RESCHEDULES.key), PORTAL_MAX_RESCHEDULES);
  if (cutoff === null) errors[PORTAL_CUTOFF_HOURS.key] = "backoffice.err.portal_cutoff_hours";
  if (max === null) errors[PORTAL_MAX_RESCHEDULES.key] = "backoffice.err.portal_max_reschedules";
  if (cutoff === null || max === null) return { errors };
  return { value: { portal_auto_confirm: form.get("portal_auto_confirm") === "1" ? "1" : "0", portal_cutoff_hours: String(cutoff), portal_max_reschedules: String(max) } };
}

/** The portal settings as they apply now: an unset key reads as its default. */
export const portalNow = (settings: Settings): PortalSettings => ({
  portal_auto_confirm: portalAutoConfirm(settings) ? "1" : "0",
  portal_cutoff_hours: String(portalCutoffHours(settings)),
  portal_max_reschedules: String(portalMaxReschedules(settings)),
});

/** Of `next`, the portal settings that change what applies now (so saving the defaults writes nothing and audits nothing). */
export function portalChanges(settings: Settings, next: Partial<PortalSettings>): Partial<PortalSettings> {
  const now = portalNow(settings);
  return Object.fromEntries(Object.entries(next).filter(([k, v]) => now[k as keyof PortalSettings] !== v)) as Partial<PortalSettings>;
}

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
