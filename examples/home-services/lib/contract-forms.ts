// Input schemas for the contract forms (same shape as lib/forms.ts): an issue's
// message is an i18n key (`contracts.err.<field>`), its path names the field.
import { filsOf, schema, text } from "./forms";

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** A real calendar day written `YYYY-MM-DD`. */
export function validDay(s: string): boolean {
  if (!DATE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

/** How many item rows the new-contract form has (more are added on the contract's page while it is a draft). */
export const ITEM_SLOTS = 4;

export interface ItemInput {
  site_id: string;
  service_id: number;
  visits_per_year: number;
}

export interface ContractInput {
  customer_id: string;
  starts_on: string;
  /** Blank on the form means the day before the next anniversary of the start. */
  ends_on: string | null;
  price_fils: number;
  notes: string;
  items: ItemInput[];
}

/** One item: a site, a catalogue service and 1 to 52 visits a year. */
function itemOf(raw: Record<string, unknown>, suffix: string, errors: Record<string, string>): ItemInput | null {
  const site = text(raw, `site_id${suffix}`, 64);
  const service = text(raw, `service${suffix}`, 12);
  const visits = text(raw, `visits${suffix}`, 3);
  if (suffix !== "" && site === "" && service === "" && visits === "") return null;
  let ok = true;
  if (!ID.test(site)) {
    errors[`site_id${suffix}`] = "contracts.err.site";
    ok = false;
  }
  const serviceId = Number(service);
  if (!Number.isSafeInteger(serviceId) || serviceId < 1) {
    errors[`service${suffix}`] = "contracts.err.service";
    ok = false;
  }
  const n = /^\d{1,2}$/u.test(visits) ? Number(visits) : 0;
  if (n < 1 || n > 52) {
    errors[`visits${suffix}`] = "contracts.err.visits";
    ok = false;
  }
  return ok ? { site_id: site, service_id: serviceId, visits_per_year: n } : null;
}

/** The new-contract form: a customer, the term, the yearly price before VAT, notes and up to ITEM_SLOTS items (`site_id_N`, `service_N`, `visits_N`). */
export const contractSchema = schema<ContractInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const customer = text(raw, "customer_id", 64);
  const starts = text(raw, "starts_on", 10);
  const ends = text(raw, "ends_on", 10);
  const price = text(raw, "price", 12) || "0";
  const notes = text(raw, "notes", 1000);
  if (!ID.test(customer)) errors.customer_id = "contracts.err.customer";
  if (!validDay(starts)) errors.starts_on = "contracts.err.date";
  if (ends !== "" && !validDay(ends)) errors.ends_on = "contracts.err.date";
  if (validDay(starts) && ends !== "" && validDay(ends) && ends < starts) errors.ends_on = "contracts.err.term";
  const fils = filsOf(price);
  if (fils === null) errors.price = "contracts.err.price";
  if (notes.length > 1000) errors.notes = "contracts.err.notes";
  const items: ItemInput[] = [];
  for (let i = 0; i < ITEM_SLOTS; i++) {
    const item = itemOf(raw, `_${i}`, errors);
    if (item !== null) items.push(item);
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { customer_id: customer, starts_on: starts, ends_on: ends === "" ? null : ends, price_fils: fils as number, notes, items } };
});

/** The add-item form of a draft contract's page. */
export const itemSchema = schema<ItemInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const item = itemOf(raw, "", errors);
  return item === null || Object.keys(errors).length > 0 ? { errors } : { value: item };
});

/** The remove-item form: the item's number. */
export const itemIdSchema = schema<{ item: number }>(async (raw) => {
  const n = Number(text(raw, "item", 12));
  return Number.isSafeInteger(n) && n >= 1 ? { value: { item: n } } : { errors: { item: "contracts.err.item" } };
});
