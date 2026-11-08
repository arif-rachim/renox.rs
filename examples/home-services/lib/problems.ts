// The 422 an invalid form answers: a small page naming each wrong field with
// what is wrong, in the page's language. It is built here and not rendered
// from a template: `ctx.render` (ops.md section 25) is documented but the
// worker has no `op_render_template` yet, and an action's object result is
// always rendered with status 200. The messages are keyed by the issue
// messages of lib/forms.ts.

type Text = { en: string; ar: string };

/** The label of a form field. */
export const FIELDS: Record<string, Text> = {
  kind: { en: "Type", ar: "النوع" },
  name: { en: "Name", ar: "الاسم" },
  phone: { en: "Phone", ar: "الهاتف" },
  trn: { en: "TRN", ar: "الرقم الضريبي" },
  email: { en: "Email", ar: "البريد الإلكتروني" },
  language: { en: "Language", ar: "اللغة" },
  label: { en: "Site name", ar: "اسم الموقع" },
  emirate: { en: "Emirate", ar: "الإمارة" },
  area: { en: "Area", ar: "المنطقة" },
  address: { en: "Address", ar: "العنوان" },
  makani: { en: "Makani number", ar: "رقم مكاني" },
  lat: { en: "Latitude", ar: "خط العرض" },
  lng: { en: "Longitude", ar: "خط الطول" },
  access_notes: { en: "Access notes", ar: "ملاحظات الدخول" },
  service: { en: "Service", ar: "الخدمة" },
  price: { en: "Price", ar: "السعر" },
};

/** What is wrong, by the issue message of lib/forms.ts. */
export const PROBLEMS: Record<string, Text> = {
  "customers.err.kind": { en: "Choose company or household.", ar: "اختر شركة أو منزلاً." },
  "customers.err.name": { en: "Enter a name (up to 120 characters).", ar: "أدخل الاسم (حتى 120 حرفاً)." },
  "customers.err.phone": { en: "Enter a UAE phone number, for example +971 50 123 4567.", ar: "أدخل رقم هاتف إماراتياً، مثل ‎+971 50 123 4567‎." },
  "customers.err.trn": { en: "A TRN has 15 digits.", ar: "الرقم الضريبي مكوّن من 15 رقماً." },
  "customers.err.trn_required": { en: "A company needs its TRN (15 digits).", ar: "الشركة تحتاج إلى رقمها الضريبي (15 رقماً)." },
  "customers.err.email": { en: "Enter a valid email address.", ar: "أدخل بريداً إلكترونياً صحيحاً." },
  "customers.err.language": { en: "Choose English or Arabic.", ar: "اختر العربية أو الإنجليزية." },
  "customers.err.label": { en: "Name the site (up to 80 characters).", ar: "سمِّ الموقع (حتى 80 حرفاً)." },
  "customers.err.emirate": { en: "Choose one of the seven emirates.", ar: "اختر إحدى الإمارات السبع." },
  "customers.err.area": { en: "Enter the area.", ar: "أدخل المنطقة." },
  "customers.err.address": { en: "Enter the address (up to 300 characters).", ar: "أدخل العنوان (حتى 300 حرف)." },
  "customers.err.makani": { en: "A Makani number has 10 digits.", ar: "رقم مكاني مكوّن من 10 أرقام." },
  "customers.err.lat": { en: "Latitude is a number from -90 to 90.", ar: "خط العرض رقم بين -90 و90." },
  "customers.err.lng": { en: "Longitude is a number from -180 to 180.", ar: "خط الطول رقم بين -180 و180." },
  "customers.err.notes": { en: "Access notes are at most 500 characters.", ar: "ملاحظات الدخول 500 حرف كحد أقصى." },
  "catalogue.err.service": { en: "Unknown service.", ar: "خدمة غير معروفة." },
  "catalogue.err.price": { en: "Enter the price in AED, for example 120 or 120.50.", ar: "أدخل السعر بالدرهم، مثل 120 أو 120.50." },
};

const escape = (s: string): string => s.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

/** 422 with one list item per wrong field (`id="err-<field>"`); `back` is where the form is. */
export function unprocessable(locale: string, errors: Record<string, string>, back: string): Response {
  const ar = locale === "ar";
  const pick = (t: Text | undefined, fallback: string): string => (t === undefined ? fallback : ar ? t.ar : t.en);
  const items = Object.entries(errors)
    .map(([field, key]) => `<li id="err-${escape(field)}"><strong>${escape(pick(FIELDS[field], field))}</strong>: ${escape(pick(PROBLEMS[key], key))}</li>`)
    .join("");
  const title = ar ? "تعذّر حفظ النموذج" : "The form could not be saved";
  const link = ar ? "العودة إلى النموذج" : "Back to the form";
  const html = `<!doctype html><html lang="${ar ? "ar" : "en"}" dir="${ar ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/renox-ui.css"><link rel="stylesheet" href="/app.css"></head><body><main><h1>${title}</h1><ul class="problem">${items}</ul><p><a href="${escape(back)}">${link}</a></p></main></body></html>`;
  return new Response(html, { status: 422, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
