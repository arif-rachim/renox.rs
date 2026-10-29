// GET <mount>/areas?q=Dub[&emirate=AE-DU]: areas starting with `q`. The
// address partial asks for the `area_list` fragment only (HX-Target:
// gcc-area-list): one indexed query, the list items.
import { type Area, findAreas } from "../services.ts";

interface Ctx {
  url: URL;
  db: { query<T>(sql: string, params?: unknown[]): Promise<T[]> };
}

export async function load(ctx: Ctx): Promise<{ q: string; areas: Area[] }> {
  const q = ctx.url.searchParams.get("q") ?? ctx.url.searchParams.get("area") ?? "";
  return { q, areas: await findAreas(ctx, q, ctx.url.searchParams.get("emirate")) };
}
