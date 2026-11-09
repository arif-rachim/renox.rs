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
  site_id: { en: "Site", ar: "الموقع" },
  valid_days: { en: "Valid for (days)", ar: "صالح لمدة (أيام)" },
  notes: { en: "Notes", ar: "ملاحظات" },
  lines: { en: "Lines", ar: "البنود" },
  desc: { en: "Description", ar: "الوصف" },
  qty: { en: "Quantity", ar: "الكمية" },
  quote_id: { en: "Quotation", ar: "عرض السعر" },
  priority: { en: "Priority", ar: "الأولوية" },
  description: { en: "Description", ar: "الوصف" },
  slot: { en: "Slot", ar: "الموعد" },
  technician: { en: "Technician", ar: "الفني" },
  to: { en: "Status", ar: "الحالة" },
  signature: { en: "Signature", ar: "التوقيع" },
  signed_by: { en: "Name of the person signing", ar: "اسم الموقّع" },
  summary_en: { en: "Summary (English)", ar: "الملخص (الإنجليزية)" },
  summary_ar: { en: "Summary (Arabic)", ar: "الملخص (العربية)" },
  phase: { en: "Photo phase", ar: "مرحلة الصورة" },
  method: { en: "Method", ar: "الطريقة" },
  amount: { en: "Amount", ar: "المبلغ" },
  received_on: { en: "Date received", ar: "تاريخ الاستلام" },
  reference: { en: "Reference", ar: "المرجع" },
  cheque_number: { en: "Cheque number", ar: "رقم الشيك" },
  cheque_date: { en: "Cheque date", ar: "تاريخ الشيك" },
  reason: { en: "Reason", ar: "السبب" },
  customer_id: { en: "Customer", ar: "العميل" },
  starts_on: { en: "Starts on", ar: "تاريخ البدء" },
  ends_on: { en: "Ends on", ar: "تاريخ الانتهاء" },
  visits: { en: "Visits a year", ar: "الزيارات في السنة" },
  item: { en: "Item", ar: "البند" },
  items: { en: "Items", ar: "البنود" },
  brand_name: { en: "Company name (English)", ar: "اسم الشركة (الإنجليزية)" },
  brand_name_ar: { en: "Company name (Arabic)", ar: "اسم الشركة (العربية)" },
  brand_color: { en: "Brand colour", ar: "لون الهوية" },
  brand_footer_en: { en: "Footer (English)", ar: "التذييل (الإنجليزية)" },
  brand_footer_ar: { en: "Footer (Arabic)", ar: "التذييل (العربية)" },
  sender_name: { en: "Sender name", ar: "اسم المرسل" },
  accounts_email: { en: "Accounts email", ar: "بريد الحسابات" },
  logo: { en: "Logo", ar: "الشعار" },
  name_en: { en: "Name (English)", ar: "الاسم (الإنجليزية)" },
  name_ar: { en: "Name (Arabic)", ar: "الاسم (العربية)" },
  role: { en: "Role", ar: "الدور" },
  user_id: { en: "Person", ar: "الشخص" },
  branch: { en: "Branch", ar: "الفرع" },
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
  "quotes.err.request": { en: "Describe the request in 1 to 2000 characters.", ar: "صف الطلب في 1 إلى 2000 حرف." },
  "quotes.err.site": { en: "Choose a site of this branch.", ar: "اختر موقعاً من هذا الفرع." },
  "quotes.err.valid": { en: "Enter a validity from 1 to 365 days.", ar: "أدخل مدة صلاحية من 1 إلى 365 يوماً." },
  "quotes.err.notes": { en: "Notes are at most 1000 characters.", ar: "الملاحظات 1000 حرف كحد أقصى." },
  "quotes.err.lines": { en: "Add at least one line.", ar: "أضف بنداً واحداً على الأقل." },
  "quotes.err.service": { en: "Unknown service.", ar: "خدمة غير معروفة." },
  "quotes.err.desc": { en: "A description is at most 200 characters.", ar: "الوصف 200 حرف كحد أقصى." },
  "quotes.err.qty": { en: "Enter a quantity above 0 with at most two decimals.", ar: "أدخل كمية أكبر من 0 بخانتين عشريتين كحد أقصى." },
  "quotes.err.price": { en: "Enter the price in AED, for example 120 or 120.50.", ar: "أدخل السعر بالدرهم، مثل 120 أو 120.50." },
  "quotes.err.price_required": { en: "A line without a service needs a price in AED.", ar: "البند بدون خدمة يحتاج إلى سعر بالدرهم." },
  "jobs.err.site": { en: "Choose a site of this branch.", ar: "اختر موقعاً من هذا الفرع." },
  "jobs.err.quote": { en: "Choose a quotation of this branch.", ar: "اختر عرض سعر من هذا الفرع." },
  "jobs.err.service": { en: "Choose a service.", ar: "اختر خدمة." },
  "jobs.err.priority": { en: "Choose low, normal, high or urgent.", ar: "اختر منخفضة أو عادية أو عالية أو عاجلة." },
  "jobs.err.description": { en: "The description is at most 1000 characters.", ar: "الوصف 1000 حرف كحد أقصى." },
  "jobs.err.slot": { en: "Choose one of the free slots.", ar: "اختر أحد المواعيد المتاحة." },
  "jobs.err.note": { en: "A note is at most 200 characters.", ar: "الملاحظة 200 حرف كحد أقصى." },
  "jobs.err.technician": { en: "Choose a technician.", ar: "اختر فنياً." },
  "jobs.err.status": { en: "Choose a status.", ar: "اختر حالة." },
  "visits.err.position": { en: "The position is not valid.", ar: "الموقع غير صالح." },
  "visits.err.part": { en: "Name the part (up to 200 characters).", ar: "سمِّ القطعة (حتى 200 حرف)." },
  "visits.err.qty": { en: "Enter a quantity above 0 with at most two decimals.", ar: "أدخل كمية أكبر من 0 بخانتين عشريتين كحد أقصى." },
  "visits.err.price": { en: "Enter the price in AED, for example 120 or 120.50.", ar: "أدخل السعر بالدرهم، مثل 120 أو 120.50." },
  "visits.err.notes": { en: "Notes are at most 2000 characters.", ar: "الملاحظات 2000 حرف كحد أقصى." },
  "visits.err.summary": { en: "A summary is at most 400 characters.", ar: "الملخص 400 حرف كحد أقصى." },
  "visits.err.signature": { en: "Draw the signature first.", ar: "ارسم التوقيع أولاً." },
  "visits.err.signed_by": { en: "Enter the name of the person signing.", ar: "أدخل اسم الموقّع." },
  "visits.err.phase": { en: "Choose before or after.", ar: "اختر قبل أو بعد." },
  "invoices.err.method": { en: "Choose cash, bank transfer or cheque.", ar: "اختر نقداً أو تحويلاً بنكياً أو شيكاً." },
  "invoices.err.amount": { en: "Enter the amount in AED, for example 120 or 120.50.", ar: "أدخل المبلغ بالدرهم، مثل 120 أو 120.50." },
  "invoices.err.date": { en: "Enter a date as YYYY-MM-DD.", ar: "أدخل التاريخ بصيغة YYYY-MM-DD." },
  "invoices.err.reference": { en: "A reference is at most 120 characters.", ar: "المرجع 120 حرفاً كحد أقصى." },
  "invoices.err.cheque_number": { en: "A cheque needs its number.", ar: "الشيك يحتاج إلى رقمه." },
  "invoices.err.reason": { en: "Give a reason of 3 to 200 characters.", ar: "اكتب سبباً من 3 إلى 200 حرف." },
  "invoices.err.overpay": { en: "The payment is more than the balance of the invoice.", ar: "الدفعة أكبر من رصيد الفاتورة." },
  "contracts.err.customer": { en: "Choose a customer of this branch.", ar: "اختر عميلاً من هذا الفرع." },
  "contracts.err.date": { en: "Enter a date as YYYY-MM-DD.", ar: "أدخل التاريخ بصيغة YYYY-MM-DD." },
  "contracts.err.term": { en: "The contract cannot end before it starts.", ar: "لا يمكن أن ينتهي العقد قبل أن يبدأ." },
  "contracts.err.price": { en: "Enter the yearly price in AED, for example 2400 or 2400.50.", ar: "أدخل السعر السنوي بالدرهم، مثل 2400 أو 2400.50." },
  "contracts.err.notes": { en: "Notes are at most 1000 characters.", ar: "الملاحظات 1000 حرف كحد أقصى." },
  "contracts.err.site": { en: "Choose a site of this customer.", ar: "اختر موقعاً من مواقع هذا العميل." },
  "contracts.err.service": { en: "Choose a service.", ar: "اختر خدمة." },
  "contracts.err.visits": { en: "Enter 1 to 52 visits a year.", ar: "أدخل من 1 إلى 52 زيارة في السنة." },
  "contracts.err.item": { en: "Unknown item.", ar: "بند غير معروف." },
  "contracts.err.no_items": { en: "Add at least one service and site before activating.", ar: "أضف خدمة وموقعاً واحداً على الأقل قبل التفعيل." },
  "backoffice.err.brand_name": { en: "Enter a name of 1 to 80 characters.", ar: "أدخل اسماً من 1 إلى 80 حرفاً." },
  "backoffice.err.color": { en: "Enter a colour as #rrggbb, for example #1f6f5c.", ar: "أدخل اللون بصيغة #rrggbb، مثل #1f6f5c." },
  "backoffice.err.footer": { en: "A footer is at most 200 characters.", ar: "التذييل 200 حرف كحد أقصى." },
  "backoffice.err.sender": { en: "A sender name is at most 80 characters.", ar: "اسم المرسل 80 حرفاً كحد أقصى." },
  "backoffice.err.accounts_email": { en: "Enter a valid email address, or leave it empty.", ar: "أدخل بريداً إلكترونياً صحيحاً أو اتركه فارغاً." },
  "backoffice.err.logo_type": { en: "A logo is a PNG, JPEG or WebP image.", ar: "الشعار صورة PNG أو JPEG أو WebP." },
  "backoffice.err.logo_size": { en: "The logo is over 512 KB.", ar: "الشعار أكبر من 512 كيلوبايت." },
  "backoffice.err.logo_empty": { en: "The logo file is empty.", ar: "ملف الشعار فارغ." },
  "backoffice.err.logo_storage": { en: "The storage refused the logo.", ar: "رفض التخزين الشعار." },
  "backoffice.err.branch_name": { en: "Enter a name of 1 to 80 characters.", ar: "أدخل اسماً من 1 إلى 80 حرفاً." },
  "backoffice.err.branch_phone": { en: "Enter a phone number of digits, for example +971 4 000 0001.", ar: "أدخل رقم هاتف من أرقام، مثل ‎+971 4 000 0001‎." },
  "backoffice.err.branch_emirate": { en: "Choose one of the seven emirates.", ar: "اختر إحدى الإمارات السبع." },
  "backoffice.err.branch_area": { en: "The area is at most 80 characters.", ar: "المنطقة 80 حرفاً كحد أقصى." },
  "backoffice.err.branch_address": { en: "The address is at most 200 characters.", ar: "العنوان 200 حرف كحد أقصى." },
  "backoffice.err.branch_exists": { en: "A branch with this name already exists.", ar: "يوجد فرع بهذا الاسم." },
  "backoffice.err.email": { en: "Enter a valid email address.", ar: "أدخل بريداً إلكترونياً صحيحاً." },
  "backoffice.err.invite": { en: "The invitation was refused: the person may be a member already.", ar: "رُفضت الدعوة: قد يكون الشخص عضواً بالفعل." },
  "backoffice.err.role": { en: "Choose one of the five roles.", ar: "اختر أحد الأدوار الخمسة." },
  "backoffice.err.member": { en: "Choose a member of this branch.", ar: "اختر عضواً من هذا الفرع." },
  "backoffice.err.self": { en: "You cannot change or remove yourself.", ar: "لا يمكنك تغيير نفسك أو إزالتها." },
  "backoffice.err.remove": { en: "The person could not be removed (the last owner stays).", ar: "تعذرت إزالة الشخص (آخر مالك يبقى)." },
  "catalogue.err.service": { en: "Unknown service.", ar: "خدمة غير معروفة." },
  "catalogue.err.price": { en: "Enter the price in AED, for example 120 or 120.50.", ar: "أدخل السعر بالدرهم، مثل 120 أو 120.50." },
};

const escape = (s: string): string => s.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

/** 422 with one list item per wrong field (`id="err-<field>"`); `back` is where the form is. */
export function unprocessable(locale: string, errors: Record<string, string>, back: string): Response {
  const ar = locale === "ar";
  const pick = (t: Text | undefined, fallback: string): string => (t === undefined ? fallback : ar ? t.ar : t.en);
  // A line's field is `<name>_<row>` (`qty_2`): the label of the name, with the line number.
  const label = (field: string): string => {
    const m = /^(service|desc|desc_ar|qty|price|site_id|visits)_(\d+)$/u.exec(field);
    if (m === null) return pick(FIELDS[field], field);
    const base = pick(FIELDS[m[1] === "desc_ar" ? "desc" : (m[1] as string)], field);
    return `${base} (${ar ? "البند" : "line"} ${Number(m[2]) + 1})`;
  };
  const items = Object.entries(errors)
    .map(([field, key]) => `<li id="err-${escape(field)}"><strong>${escape(label(field))}</strong>: ${escape(pick(PROBLEMS[key], key))}</li>`)
    .join("");
  const title = ar ? "تعذّر حفظ النموذج" : "The form could not be saved";
  const link = ar ? "العودة إلى النموذج" : "Back to the form";
  const html = `<!doctype html><html lang="${ar ? "ar" : "en"}" dir="${ar ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/renox-ui.css"><link rel="stylesheet" href="/app.css"></head><body><main><h1>${title}</h1><ul class="problem">${items}</ul><p><a href="${escape(back)}">${link}</a></p></main></body></html>`;
  return new Response(html, { status: 422, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
