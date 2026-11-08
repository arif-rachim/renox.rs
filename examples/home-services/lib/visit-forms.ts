// Input schemas for the technician's visit forms (same shape as lib/forms.ts):
// an issue's message is an i18n key (`visits.err.<field>`), its path names the field.
import { filsOf, schema, text } from "./forms";

/** Both phases of a photo. */
export const PHASES = ["before", "after"] as const;
export type Phase = (typeof PHASES)[number];

/** The check-in form: the browser's position, both or neither. */
export const checkinSchema = schema<{ lat: number | null; lng: number | null }>(async (raw) => {
  const lat = text(raw, "lat", 20);
  const lng = text(raw, "lng", 20);
  if (lat === "" && lng === "") return { value: { lat: null, lng: null } };
  const la = Number(lat);
  const ln = Number(lng);
  if (lat === "" || lng === "" || !Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return { errors: { lat: "visits.err.position" } };
  return { value: { lat: la, lng: ln } };
});

export interface PartInput {
  description: string;
  qty: number;
  unit_price_fils: number;
}

export const partSchema = schema<PartInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const description = text(raw, "description", 200);
  const qty = text(raw, "qty", 8) || "1";
  const price = text(raw, "price", 12) || "0";
  if (description === "" || description.length > 200) errors.description = "visits.err.part";
  const q = /^\d{1,3}(\.\d{1,2})?$/u.test(qty) ? Number(qty) : 0;
  if (!(q > 0)) errors.qty = "visits.err.qty";
  const fils = filsOf(price);
  if (fils === null) errors.price = "visits.err.price";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { description, qty: q, unit_price_fils: fils as number } };
});

export const notesSchema = schema<{ notes: string }>(async (raw) => {
  const notes = text(raw, "notes", 2000);
  return notes.length > 2000 ? { errors: { notes: "visits.err.notes" } } : { value: { notes } };
});

export const summarySchema = schema<{ summary_en: string; summary_ar: string }>(async (raw) => {
  const en = text(raw, "summary_en", 400);
  const ar = text(raw, "summary_ar", 400);
  const errors: Record<string, string> = {};
  if (en.length > 400) errors.summary_en = "visits.err.summary";
  if (ar.length > 400) errors.summary_ar = "visits.err.summary";
  return Object.keys(errors).length > 0 ? { errors } : { value: { summary_en: en, summary_ar: ar } };
});

/** The drawn signature: a PNG data URL (the page's script writes it) and the name of whoever signed. */
export const signatureSchema = schema<{ data: string; name: string }>(async (raw) => {
  const errors: Record<string, string> = {};
  const data = typeof raw.signature === "string" ? raw.signature.trim() : "";
  const name = text(raw, "signed_by", 120);
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(data) || data.length > 300_000) errors.signature = "visits.err.signature";
  if (name === "" || name.length > 120) errors.signed_by = "visits.err.signed_by";
  return Object.keys(errors).length > 0 ? { errors } : { value: { data, name } };
});
