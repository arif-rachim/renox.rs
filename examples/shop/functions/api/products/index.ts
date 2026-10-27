// GET /api/products            -> the first 100 products by id
// GET /api/products?q=dates    -> name or description contains `q` (case-insensitive)
// GET /api/products?category=coffee
import type { Handler } from "renox";

import { badRequest, json, type Product } from "../../../lib/http.ts";

const CATEGORIES = new Set(["dates", "coffee", "spices", "sweets", "perfume"]);

export const GET: Handler = async ({ db, url }) => {
  const q = url.searchParams.get("q")?.trim() ?? "";
  const category = url.searchParams.get("category");
  if (q.length > 100) return badRequest("q is longer than 100 characters");
  if (category !== null && !CATEGORIES.has(category)) return badRequest("unknown category");
  // LIKE wildcards in the search text are escaped, so `q` is always literal.
  const pattern = `%${q.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
  const products = await db.query<Product>(
    `select id, name, description, price_fils, stock, category, image from app__products
     where (name like ?1 escape '\\' or description like ?1 escape '\\')
       and (?2 is null or category = ?2)
     order by id limit 100`,
    [pattern, category],
  );
  return json({ count: products.length, products });
};
