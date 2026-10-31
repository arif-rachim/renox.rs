// GET <mount>/areas?q=Dub[&emirate=AE-DU]: areas starting with `q`. The
// address partial asks for the `area_list` fragment only (HX-Target:
// gcc-area-list): one indexed query, the list items.
import { type Area, findAreas } from "../services.ts";

interface Ctx {
  url: URL;
  db: { query<T>(sql: string, params?: unknown[]): Promise<T[]> };
  setLocale?: (locale: string, dir?: "ltr" | "rtl") => void;
}

export async function load(ctx: Ctx): Promise<{ q: string; areas: Area[] }> {
  // The list is bilingual (each area in English and Arabic); `?lang=ar` makes
  // the page itself right-to-left (#336). gcc has no i18n dependency, so it
  // reads only that parameter.
  if (ctx.url.searchParams.get("lang") === "ar") ctx.setLocale?.("ar", "rtl");
  const q = ctx.url.searchParams.get("q") ?? ctx.url.searchParams.get("area") ?? "";
  return { q, areas: await findAreas(ctx, q, ctx.url.searchParams.get("emirate")) };
}
