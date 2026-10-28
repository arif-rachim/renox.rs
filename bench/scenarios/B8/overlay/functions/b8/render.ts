// GET /b8/render?n=100|1000[&fragment=product_list]: render path B. The
// same data as GET /b8, rendered in the isolate by the template module that
// renox-template's emit_js generated from the same compiled templates
// (lib/b8-templates.mjs, written by bench/scenarios/B8/run.sh).
import { b8Data, itemCount, type Ctx } from "../../lib/b8-data.ts";
// @ts-expect-error generated at stage time, no type declarations
import { render, renderFragment } from "../../lib/b8-templates.mjs";

export const GET = async ({ db, url }: Ctx): Promise<Response> => {
  const data = await b8Data(db, itemCount(url), "b8");
  const fragment = url.searchParams.get("fragment");
  const cx = { locale: "en-AE" };
  const html: string = fragment === null ? render("pages/b8/index", data, cx) : renderFragment("pages/b8/index", fragment, data, cx);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
};
