// POST /api/dev/seed -> loads seeds/products.sql (100 products), idempotent.
//
// Dev only until `renox db seed` exists (F2+): it answers 404 unless the
// request came through `renox dev`, which routes the app as
// `<app>.localhost`. A deployed app is never served under `.localhost`.
import type { Handler } from "renox";

import seed from "../../../seeds/products.sql" with { type: "text" };
import { json, notFound } from "../../../lib/http.ts";

export const POST: Handler = async ({ db, url }) => {
  if (!url.hostname.endsWith(".localhost")) return notFound("route");
  await db.transaction(async (tx) => {
    await tx.execute(seed);
  });
  const row = await db.queryOne<{ n: number }>("select count(*) as n from app__products");
  return json({ products: row?.n ?? 0 });
};
