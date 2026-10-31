// POST /api/dev/seed -> loads seeds/products.sql (100 products), idempotent,
// then stores one image per category through the storage module (#332) and
// points each product at it (`image` is the stored key).
//
// Dev only until `renox db seed` exists (F2+): it answers 404 unless the
// request came through `renox dev`, which routes the app as
// `<app>.localhost`. A deployed app is never served under `.localhost`.
import type { Handler } from "renox";

import { storage } from "renox:modules";

import seed from "../../../seeds/products.sql" with { type: "text" };
import { json, notFound } from "../../../lib/http.ts";
import { categoryPng } from "../../../lib/placeholder-png.ts";

export const POST: Handler = async ({ db, url }) => {
  if (!url.hostname.endsWith(".localhost")) return notFound("route");
  await db.transaction(async (tx) => {
    await tx.execute(seed);
  });
  const missing = await db.query<{ category: string }>("select distinct category from app__products where image_width is null order by category");
  for (const { category } of missing) {
    const png = categoryPng(category);
    const stored = (await storage.upload("products", `${category}.png`, png.bytes, "image/png", { public: true })) as { key: string; width: number | null; height: number | null };
    await db.execute("update app__products set image = ?, image_width = ?, image_height = ? where category = ?", [stored.key, stored.width ?? png.width, stored.height ?? png.height, category]);
  }
  const row = await db.queryOne<{ n: number }>("select count(*) as n from app__products");
  return json({ products: row?.n ?? 0 });
};
