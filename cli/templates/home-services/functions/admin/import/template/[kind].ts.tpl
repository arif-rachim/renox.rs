// GET /admin/import/template/<kind>: the one-sheet .xlsx of a kind (customers,
// sites, services, parts, stock, contracts) with the header row and two example rows, made by
// the `reports` module. `settings.read`.
import type { Handler } from "@renoxium/sdk";
import { reports } from "renox:modules";

import { isKind, TEMPLATES, XLSX_TYPE } from "../../../../lib/import";

export const guard = { action: "settings.read" };

export const GET: Handler = async (ctx) => {
  const kind = ctx.params.kind;
  if (!isKind(kind)) return new Response("Unknown kind", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const bytes = await reports.xlsx(kind, TEMPLATES[kind]);
  return new Response(bytes as BodyInit, {
    headers: { "content-type": XLSX_TYPE, "content-disposition": `attachment; filename="import-${kind}-template.xlsx"`, "cache-control": "no-store" },
  });
};
