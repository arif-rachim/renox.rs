// Input schemas for the customer, site and service forms: Standard Schema
// objects for `validate(form, schema)` (the SDK depends on no schema library),
// with the gcc module's checks for +971 phones, TRN, Makani and the emirate.
// An issue's message is an i18n key (`customers.err.<field>`); its path names the field.
import { ValidationError, validate, type StandardSchemaV1 } from "@renoxium/sdk";
import { gcc } from "renox:modules";

import type { LineInput } from "./quotes";

type Raw = Record<string, unknown>;
type Issues = { path: [string]; message: string }[];

/** A Standard Schema whose `run` returns the value, or the field to key map of what is wrong. */
export function schema<T>(run: (raw: Raw) => Promise<{ value: T } | { errors: Record<string, string> }>): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "home-services",
      validate: async (input) => {
        const r = await run(typeof input === "object" && input !== null ? (input as Raw) : {});
        if ("value" in r) return { value: r.value };
        const issues: Issues = Object.entries(r.errors).map(([field, message]) => ({ path: [field], message }));
        return { issues };
      },
    },
  };
}

/** The trimmed string of a form field ("" when absent), cut at `max` + 1 so an over-long value fails its limit. */
export const text = (raw: Raw, key: string, max: number): string => (typeof raw[key] === "string" ? (raw[key] as string).trim().slice(0, max + 1) : "");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const KINDS = ["company", "household"] as const;
export const LANGUAGES = ["en", "ar"] as const;
/** The emirates, as the gcc module names them (ISO 3166-2:AE); the module has no list to ask for, only `listAreas(code)`. */
export const EMIRATES = ["AE-AZ", "AE-DU", "AE-SH", "AE-AJ", "AE-UQ", "AE-RK", "AE-FU"] as const;

export interface CustomerInput {
  kind: (typeof KINDS)[number];
  name: string;
  trn: string | null;
  phone: string;
  email: string | null;
  language: (typeof LANGUAGES)[number];
}

export const customerSchema = schema<CustomerInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const kind = text(raw, "kind", 20);
  const name = text(raw, "name", 120);
  const trn = text(raw, "trn", 40);
  const phone = text(raw, "phone", 40);
  const email = text(raw, "email", 254);
  const language = text(raw, "language", 5) || "en";
  if (!(KINDS as readonly string[]).includes(kind)) errors.kind = "customers.err.kind";
  if (name === "" || name.length > 120) errors.name = "customers.err.name";
  let phoneValue = "";
  const p = await gcc.validatePhone(phone);
  if (p.ok) phoneValue = p.value;
  else errors.phone = "customers.err.phone";
  // A company is invoiced with its TRN; a household may leave it out, but a value is checked.
  let trnValue: string | null = null;
  if (trn === "") {
    if (kind === "company") errors.trn = "customers.err.trn_required";
  } else {
    const t = await gcc.validateTrn(trn);
    if (t.ok) trnValue = t.value;
    else errors.trn = "customers.err.trn";
  }
  if (email !== "" && (email.length > 254 || !EMAIL.test(email))) errors.email = "customers.err.email";
  if (!(LANGUAGES as readonly string[]).includes(language)) errors.language = "customers.err.language";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { kind: kind as CustomerInput["kind"], name, trn: trnValue, phone: phoneValue, email: email === "" ? null : email, language: language as CustomerInput["language"] } };
});

export interface SiteInput {
  label: string;
  emirate: string;
  area: string;
  address: string;
  makani: string | null;
  lat: number | null;
  lng: number | null;
  access_notes: string;
}

/** An optional coordinate: "" is none, else a number within `limit`. */
function coordinate(value: string, limit: number): number | null | "bad" {
  if (value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : "bad";
}

export const siteSchema = schema<SiteInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const label = text(raw, "label", 80);
  const emirate = text(raw, "emirate", 10);
  const area = text(raw, "area", 80);
  const address = text(raw, "address", 300);
  const makani = text(raw, "makani", 20);
  const lat = coordinate(text(raw, "lat", 20), 90);
  const lng = coordinate(text(raw, "lng", 20), 180);
  const notes = text(raw, "access_notes", 500);
  if (label === "" || label.length > 80) errors.label = "customers.err.label";
  // The emirate is one the gcc module knows: it lists areas for it.
  if (!(EMIRATES as readonly string[]).includes(emirate) || (await gcc.listAreas(emirate)).length === 0) errors.emirate = "customers.err.emirate";
  if (area === "" || area.length > 80) errors.area = "customers.err.area";
  if (address === "" || address.length > 300) errors.address = "customers.err.address";
  let makaniValue: string | null = null;
  if (makani !== "") {
    const m = await gcc.validateMakani(makani);
    if (m.ok) makaniValue = m.value;
    else errors.makani = "customers.err.makani";
  }
  if (lat === "bad") errors.lat = "customers.err.lat";
  if (lng === "bad") errors.lng = "customers.err.lng";
  if (notes.length > 500) errors.access_notes = "customers.err.notes";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { label, emirate, area, address, makani: makaniValue, lat: lat as number | null, lng: lng as number | null, access_notes: notes } };
});

export interface ServiceInput {
  id: number;
  price_fils: number;
  active: 0 | 1;
}

/** The catalogue edit: the price in AED as typed ("120" or "120.50"), stored in fils. */
export const serviceSchema = schema<ServiceInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const id = Number(text(raw, "service", 12));
  const price = text(raw, "price", 12);
  if (!Number.isSafeInteger(id) || id < 1) errors.service = "catalogue.err.service";
  if (!/^\d{1,7}(\.\d{1,2})?$/u.test(price)) errors.price = "catalogue.err.price";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { id, price_fils: Math.round(Number(price) * 100), active: raw.active === "1" ? 1 : 0 } };
});

/** How many line rows the quotation form has. */
export const LINE_SLOTS = 8;

export interface QuoteInput {
  site_id: string;
  valid_days: number;
  notes: string;
  lines: LineInput[];
}

/** An amount in AED as typed ("120" or "120.50") in fils, or null when it is not one. */
export function filsOf(typed: string): number | null {
  return /^\d{1,7}(\.\d{1,2})?$/u.test(typed) ? Math.round(Number(typed) * 100) : null;
}

/**
 * The quotation form: a site (the customer is the site's), a validity in days,
 * notes and up to LINE_SLOTS lines named `service_N`, `desc_N`, `desc_ar_N`, `qty_N`,
 * `price_N`. A row is a line when it names a service or has a description; a
 * service line may leave the price to the catalogue, a free-text line needs one.
 */
export const quoteSchema = schema<QuoteInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const site = text(raw, "site_id", 64);
  const days = text(raw, "valid_days", 3) || "30";
  const notes = text(raw, "notes", 1000);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(site)) errors.site_id = "quotes.err.site";
  if (!/^\d{1,3}$/u.test(days) || Number(days) < 1 || Number(days) > 365) errors.valid_days = "quotes.err.valid";
  if (notes.length > 1000) errors.notes = "quotes.err.notes";
  const lines: LineInput[] = [];
  for (let i = 0; i < LINE_SLOTS; i++) {
    const service = text(raw, `service_${i}`, 12);
    const desc = text(raw, `desc_${i}`, 200);
    const descAr = text(raw, `desc_ar_${i}`, 200);
    const qty = text(raw, `qty_${i}`, 8) || "1";
    const price = text(raw, `price_${i}`, 12);
    if (service === "" && desc === "") continue;
    const serviceId = service === "" ? null : Number(service);
    if (serviceId !== null && !(Number.isSafeInteger(serviceId) && serviceId >= 1)) errors[`service_${i}`] = "quotes.err.service";
    if (desc.length > 200 || descAr.length > 200) errors[`desc_${i}`] = "quotes.err.desc";
    const q = /^\d{1,3}(\.\d{1,2})?$/u.test(qty) ? Number(qty) : 0;
    if (!(q > 0)) errors[`qty_${i}`] = "quotes.err.qty";
    const fils = price === "" ? null : filsOf(price);
    if (price !== "" && fils === null) errors[`price_${i}`] = "quotes.err.price";
    if (serviceId === null && price === "" && errors[`price_${i}`] === undefined) errors[`price_${i}`] = "quotes.err.price_required";
    lines.push({ service_id: serviceId, description_en: desc, description_ar: descAr, qty: q, unit_price_fils: fils });
  }
  if (lines.length === 0) errors.lines = "quotes.err.lines";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { site_id: site, valid_days: Number(days), notes, lines } };
});

/** The body of POST /api/quotes/draft: `{ "request": "<free text, 1 to 2000 characters>" }`. */
export const draftRequestSchema = schema<{ request: string }>(async (raw) => {
  const request = typeof raw.request === "string" ? raw.request.trim() : "";
  if (request === "" || request.length > 2000) return { errors: { request: "quotes.err.request" } };
  return { value: { request } };
});

/** The emirates' names for the select, in the page's language. */
const EMIRATE_NAMES: Record<(typeof EMIRATES)[number], { en: string; ar: string }> = {
  "AE-AZ": { en: "Abu Dhabi", ar: "أبوظبي" },
  "AE-DU": { en: "Dubai", ar: "دبي" },
  "AE-SH": { en: "Sharjah", ar: "الشارقة" },
  "AE-AJ": { en: "Ajman", ar: "عجمان" },
  "AE-UQ": { en: "Umm Al Quwain", ar: "أم القيوين" },
  "AE-RK": { en: "Ras Al Khaimah", ar: "رأس الخيمة" },
  "AE-FU": { en: "Fujairah", ar: "الفجيرة" },
};

export const emirateOptions = (locale: string): { code: string; name: string }[] =>
  EMIRATES.map((code) => ({ code, name: EMIRATE_NAMES[code][locale === "ar" ? "ar" : "en"] }));

/** Fields that never go back to the page: the token, a drawn signature, an uploaded logo. */
const NOT_ECHOED = new Set(["_csrf", "signature", "logo_data"]);
const MAX_ECHOED = 2000;

/** The text fields of a submitted form as typed (the first value of a name), to show again beside the errors. */
export function valuesOf(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string" || NOT_ECHOED.has(name) || value.length > MAX_ECHOED || name in values) continue;
    values[name] = value;
  }
  return values;
}

/** The fields a failed `validate()` names, each with its i18n key; other errors are rethrown. */
export async function check<T>(form: FormData, s: StandardSchemaV1<unknown, T>): Promise<{ value: T } | { errors: Record<string, string> }> {
  try {
    return { value: await validate(form, s) };
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    return { errors: Object.fromEntries(e.issues.map((i) => [String(i.path[0] ?? "form"), i.message])) };
  }
}
