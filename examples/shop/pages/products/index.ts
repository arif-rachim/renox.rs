// GET /products: the B6 page (docs/14-benchmarks.md): 100 products, exactly
// five queries. With `HX-Target: product-list` (the search box) the cell
// renders only the product_list fragment, and the loader runs one query for
// up to 20 matches (B7).
import type { LoaderContext } from "renox";

import type { Product } from "../../lib/http.ts";

/** What a card shows: the price in AED, not fils. */
export interface Card {
  id: number;
  name: string;
  category: string;
  price: number;
  stock: number;
}

const toCard = (p: Product): Card => ({ id: p.id, name: p.name, category: p.category, price: p.price_fils / 100, stock: p.stock });

/** `q` as a literal LIKE pattern (`%` and `_` escaped). */
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;

const SEARCH = `select id, name, description, price_fils, stock, category, image from app__products
  where (name like ?1 escape '\\' or description like ?1 escape '\\') order by id limit ?2`;

export async function load({ db, url, fragment, session }: LoaderContext) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  if (fragment === "product_list") {
    // B7: one block, one query, 20 items.
    const products = await db.query<Product>(SEARCH, [likePattern(q), 20]);
    return { q, products: products.map(toCard) };
  }
  // B6: five queries.
  const products = await db.query<Product>(SEARCH, [likePattern(q), 100]);
  const categories = await db.query<{ category: string; n: number }>(
    "select category, count(*) as n from app__products group by category order by category",
  );
  const total = await db.queryOne<{ n: number }>("select count(*) as n from app__products");
  const prices = await db.queryOne<{ lo: number | null; hi: number | null }>(
    "select min(price_fils) as lo, max(price_fils) as hi from app__products",
  );
  const cart = await db.queryOne<{ n: number }>(
    "select coalesce(sum(quantity), 0) as n from app__cart_items where cart_id = ?",
    [session.id],
  );
  return {
    q,
    products: products.map(toCard),
    categories,
    total: total?.n ?? 0,
    price_min: (prices?.lo ?? 0) / 100,
    price_max: (prices?.hi ?? 0) / 100,
    cart_count: cart?.n ?? 0,
  };
}
