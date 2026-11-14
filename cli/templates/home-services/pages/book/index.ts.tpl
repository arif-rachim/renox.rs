// GET /book: the public booking page (#775), no sign-in. One page in three
// steps kept in the URL (`?step=`), each a plain form:
//   1. the service (active, self-booking on, "from AED <price>"), the
//      emirate and the area (the area list follows the chosen emirate when the
//      form is sent again: "Show the areas"), the address, Makani and notes;
//   2. the time: the branch that serves the emirate (none: "We do not serve
//      this emirate yet" and the company's phone), the next 7 days as links,
//      and the chosen day's free slots across the branch's technicians;
//   3. the visitor: name, WhatsApp number, language. POST ?/hold holds the
//      slot (booking's hold_minutes) and stores the draft (lib/book.ts), then
//      sends them to auth's phone sign-in with `next=/book/confirm/<draft>`
//      (a signed-in portal user goes straight there, with their own phone).
// Steps 1 and 2 are GET forms (the choices are in the query string): the
// app writes nothing and sets no cookie of its own before step 3. A step
// whose earlier choices fail their checks shows the earlier step with the
// errors. 429 past 5 drafts an hour per address or 3 live drafts per phone.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";
import { gcc } from "renox:modules";

import ar from "../../i18n/ar.json";
import en from "../../i18n/en.json";
import {
  areasOf,
  bookableServices,
  branchFor,
  checkPlace,
  type Choices,
  choicesOf,
  companyPhone,
  createDraft,
  freeSlots,
  ipHashOf,
  nextDays,
  overLimit,
  parseSlot,
  queryOf,
  resolveSlot,
} from "../../lib/book";
import { emirateOptions } from "../../lib/forms";
import { invalid } from "../../lib/invalid";
import { shell } from "../../lib/page";
import { portalUser, signOut } from "../../lib/portal";
import { day as dayOf } from "../../lib/quotes";
import type { Branch } from "../../lib/scope";

type Ctx = LoaderContext | ActionContext;
type Lang = "en" | "ar";

const weekdayName = (lang: Lang, weekday: number): string => {
  const days = (lang === "ar" ? ar : en).backoffice.hours.day as Record<string, string>;
  return days[String(weekday)] ?? String(weekday);
};

/** A FormData of `c`, for lib/invalid.ts (it echoes the typed values). */
function formOf(c: Partial<Record<string, string>>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(c)) if (typeof v === "string") f.set(k, v);
  return f;
}

/** The step-1 choices as hidden fields of a later step's form. */
const hiddenOf = (c: Choices, keys: (keyof Choices)[]): { name: string; value: string }[] => keys.filter((k) => c[k] !== "").map((k) => ({ name: k, value: c[k] }));
const PLACE_KEYS: (keyof Choices)[] = ["service", "emirate", "area", "address", "makani", "notes"];

/** What steps 2 and 3 show of the branch and the chosen day. */
async function timeOf(ctx: Ctx, lang: Lang, c: Choices, branch: Branch, serviceCode: string) {
  const days = nextDays();
  const chosen = days.find((d) => d.key === c.day)?.key ?? (days[0] as { key: string }).key;
  const slots = await freeSlots(ctx, branch, { code: serviceCode }, chosen);
  return {
    branch: { name: lang === "ar" ? branch.name_ar : branch.name_en },
    day: chosen,
    day_label: weekdayName(lang, days.find((d) => d.key === chosen)?.weekday ?? 0),
    days: days.map((d) => ({ key: d.key, label: weekdayName(lang, d.weekday), current: d.key === chosen, href: `/book?${queryOf({ ...c, day: d.key, slot: "" }, { step: "2" })}` })),
    slots: slots.map((s) => ({ ...s, checked: s.value === c.slot })),
  };
}

/**
 * The page's data for the step asked for in `params` (or `form`, after a
 * POST). `step3` adds the typed name, phone and language and their errors (a
 * 422 of ?/hold).
 */
async function view(ctx: Ctx, locale: string, params: { get(name: string): unknown }, step3?: { values: Record<string, string>; errors: Record<string, string>; problems: unknown[] }) {
  const lang: Lang = locale === "ar" ? "ar" : "en";
  const c = choicesOf(params);
  const wanted = String(params.get("step") ?? "1");
  const services = (await bookableServices(ctx.db)).map((s) => ({ id: s.id, name: lang === "ar" ? s.name_ar : s.name_en, price: s.price_fils / 100, checked: String(s.id) === c.service }));
  const areas = (await areasOf(c.emirate)).map((a) => ({ value: a.name_en, name: lang === "ar" ? a.name_ar : a.name_en, selected: a.name_en === c.area }));
  const base = { values: { ...c }, errors: {}, problems: [] as unknown[], services, areas, emirates: emirateOptions(locale), taken: params.get("taken") === "1" };
  if (wanted !== "2" && wanted !== "3") return { ...base, step: 1 };
  const place = await checkPlace(ctx.db, c);
  if ("errors" in place) {
    const bad = invalid(locale, formOf({ ...c }), place.errors);
    return { ...base, step: 1, values: { ...c }, errors: bad.errors, problems: bad.problems };
  }
  const branch = await branchFor(ctx.db, c.emirate);
  if (branch === null) return { ...base, step: 2, no_branch: true, company_phone: await companyPhone(ctx.db), back: `/book?${queryOf(c)}` };
  if (place.value.service.branch_id !== null && place.value.service.branch_id !== branch.id) {
    const bad = invalid(locale, formOf({ ...c }), { service: "book.err.service_here" });
    return { ...base, step: 1, errors: bad.errors, problems: bad.problems };
  }
  const time = await timeOf(ctx, lang, c, branch, place.value.service.code);
  const hidden2 = hiddenOf(c, PLACE_KEYS);
  if (wanted === "2") return { ...base, step: 2, ...time, hidden: hidden2, back: `/book?${queryOf({ ...c, slot: "" })}` };
  // Step 3: the slot must be one step 2 offers now.
  const parsed = parseSlot(c.slot);
  const slot = parsed === null ? undefined : await resolveSlot(ctx, branch, { code: place.value.service.code }, c.slot);
  if (slot === undefined) {
    const t2 = parsed === null ? time : await timeOf(ctx, lang, { ...c, day: dayOf(Math.floor(parsed.start / 1000)) }, branch, place.value.service.code);
    if (parsed === null && c.slot === "") {
      const bad = invalid(locale, formOf({ ...c }), { slot: "book.err.slot" });
      return { ...base, step: 2, ...t2, hidden: hidden2, errors: bad.errors, problems: bad.problems, back: `/book?${queryOf({ ...c, slot: "" })}` };
    }
    return { ...base, step: 2, ...t2, hidden: hidden2, taken: true, back: `/book?${queryOf({ ...c, slot: "" })}` };
  }
  const portal = await portalUser(ctx);
  const day = dayOf(Math.floor(slot.start / 1000));
  return {
    ...base,
    step: 3,
    values: { ...c, language: lang, ...(step3?.values ?? {}) },
    errors: step3?.errors ?? {},
    problems: step3?.problems ?? [],
    summary: { service: lang === "ar" ? place.value.service.name_ar : place.value.service.name_en, area: areas.find((a) => a.value === c.area)?.name ?? c.area, emirate: emirateOptions(locale).find((e) => e.code === c.emirate)?.name ?? c.emirate, address: c.address, day, from: slot.from, to: slot.to },
    portal_phone: portal?.phone ?? null,
    hidden: hiddenOf({ ...c, day }, [...PLACE_KEYS, "day", "slot"]),
    back: `/book?${queryOf({ ...c, day }, { step: "2" })}`,
  };
}

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  return { ...page, ...(await view(ctx, page.locale, ctx.url.searchParams)) };
}

const tooMany = (lang: Lang): Response =>
  new Response(lang === "ar" ? "طلبات حجز كثيرة. يرجى المحاولة لاحقاً." : "Too many booking requests. Please try again later.", { status: 429, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "3600" } });

const seeOther = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });

export const actions = {
  /** Step 3's submit: checks every step again, holds the slot and stores the draft. */
  async hold(ctx: ActionContext) {
    const page = await shell(ctx);
    const lang: Lang = page.locale === "ar" ? "ar" : "en";
    const c = choicesOf(ctx.form);
    const place = await checkPlace(ctx.db, c);
    if ("errors" in place) return seeOther(`/book?${queryOf(c)}&step=2`);
    const branch = await branchFor(ctx.db, c.emirate);
    const parsed = parseSlot(c.slot);
    if (branch === null || parsed === null) return seeOther(`/book?${queryOf({ ...c, slot: "" })}&step=2`);
    const slot = await resolveSlot(ctx, branch, { code: place.value.service.code }, c.slot);
    if (slot === undefined) return seeOther(`/book?${queryOf({ ...c, slot: "", day: dayOf(Math.floor(parsed.start / 1000)) })}&step=2&taken=1`);
    // The visitor.
    const portal = await portalUser(ctx);
    const raw = (k: string, max: number): string => {
      const v = ctx.form.get(k);
      return typeof v === "string" ? v.trim().slice(0, max + 1) : "";
    };
    const name = raw("name", 80);
    const language = raw("language", 5);
    const errors: Record<string, string> = {};
    if ([...name].length < 2 || [...name].length > 80) errors.name = "book.err.name";
    if (language !== "en" && language !== "ar") errors.language = "book.err.language";
    let phone = portal?.phone ?? "";
    if (portal === null) {
      const p = (await gcc.validatePhone(raw("phone", 40))) as { ok: boolean; value?: string };
      if (p.ok && typeof p.value === "string") phone = p.value;
      else errors.phone = "book.err.phone";
    }
    if (Object.keys(errors).length > 0) {
      const bad = invalid(page.locale, ctx.form, errors);
      return { ...(await view(ctx, page.locale, new URLSearchParams({ ...Object.fromEntries(Object.entries(c)), step: "3" }), bad)), status: 422 as const };
    }
    const ipHash = await ipHashOf(ctx.headers);
    if ((await overLimit(ctx.db, ipHash, phone)) !== null) return tooMany(lang);
    const made = await createDraft(ctx.db, { place: place.value, branch, slot, name, phone, language: language as Lang, ipHash });
    if (made === "taken") return seeOther(`/book?${queryOf({ ...c, slot: "", day: dayOf(Math.floor(parsed.start / 1000)) })}&step=2&taken=1`);
    const next = `/book/confirm/${made.id}`;
    if (portal !== null) return seeOther(next);
    return seeOther(`/auth/phone?phone=${encodeURIComponent(phone)}&next=${encodeURIComponent(next)}`);
  },

  async signout() {
    return signOut();
  },
};
