// The address and phone partials, in English or Arabic (?lang=ar).
export async function load(ctx) {
  const lang = ctx.url.searchParams.get("lang") === "ar" ? "ar-AE" : "en-AE";
  ctx.setLocale(lang);
  return {};
}
