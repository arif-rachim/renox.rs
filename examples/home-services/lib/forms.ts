// Input schemas for the customer, site and service forms: Standard Schema
// objects for `validate(form, schema)` (the SDK depends on no schema library),
// with the gcc module's checks for +971 phones, TRN, Makani and the emirate.
// An issue's message is an i18n key (`customers.err.<field>`); its path names the field.
import { ValidationError, validate, type StandardSchemaV1 } from "@renoxium/sdk";
import { gcc } from "renox:modules";

type Raw = Record<string, unknown>;
type Issues = { path: [string]; message: string }[];

/** A Standard Schema whose `run` returns the value, or the field to key map of what is wrong. */
function schema<T>(run: (raw: Raw) => Promise<{ value: T } | { errors: Record<string, string> }>): StandardSchemaV1<unknown, T> {
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
const text = (raw: Raw, key: string, max: number): string => (typeof raw[key] === "string" ? (raw[key] as string).trim().slice(0, max + 1) : "");

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

/** The text fields of a submitted form as typed, to show again beside the errors. */
export const valuesOf = (form: FormData): Record<string, string> => Object.fromEntries([...form].filter((e): e is [string, string] => typeof e[1] === "string" && e[0] !== "_csrf"));

/** The fields a failed `validate()` names, each with its i18n key; other errors are rethrown. */
export async function check<T>(form: FormData, s: StandardSchemaV1<unknown, T>): Promise<{ value: T } | { errors: Record<string, string> }> {
  try {
    return { value: await validate(form, s) };
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    return { errors: Object.fromEntries(e.issues.map((i) => [String(i.path[0] ?? "form"), i.message])) };
  }
}
