// POST /api/cart {"cart_id": "c_1", "product_id": 7, "quantity": 2}
//   -> 201 {"item": {...}, "cart": {"items": n, "total_fils": n}}
// The body is validated with zod before anything touches the database;
// stock is checked and the item inserted in one transaction.
import type { Handler } from "renox";
import { z } from "zod";

import { badRequest, json, notFound } from "../../lib/http.ts";

export const CartItemInput = z.strictObject({
  cart_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u, "cart_id: 1-64 letters, digits, _ or -"),
  product_id: z.number().int().positive(),
  quantity: z.number().int().min(1).max(99),
});

export const POST: Handler = async ({ req, db }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("body must be JSON");
  }
  const parsed = CartItemInput.safeParse(body);
  if (!parsed.success) return badRequest("invalid cart item", z.flattenError(parsed.error).fieldErrors);
  const { cart_id, product_id, quantity } = parsed.data;

  const outcome = await db.transaction(async (tx) => {
    const product = await tx.queryOne<{ stock: number }>("select stock from app__products where id = ?", [product_id]);
    if (!product) return { kind: "missing" as const };
    const inCart = await tx.queryOne<{ n: number }>(
      "select coalesce(sum(quantity), 0) as n from app__cart_items where cart_id = ? and product_id = ?",
      [cart_id, product_id],
    );
    if ((inCart?.n ?? 0) + quantity > product.stock) return { kind: "stock" as const, stock: product.stock };
    const r = await tx.execute(
      "insert into app__cart_items (cart_id, product_id, quantity, created_at) values (?, ?, ?, ?)",
      [cart_id, product_id, quantity, Math.floor(Date.now() / 1000)],
    );
    const cart = await tx.queryOne<{ items: number; total_fils: number }>(
      `select count(*) as items, coalesce(sum(c.quantity * p.price_fils), 0) as total_fils
       from app__cart_items c join app__products p on p.id = c.product_id
       where c.cart_id = ?`,
      [cart_id],
    );
    return { kind: "ok" as const, id: Number(r.lastInsertRowid), cart };
  });

  if (outcome.kind === "missing") return notFound("product");
  if (outcome.kind === "stock") return json({ error: { code: "out_of_stock", message: `only ${outcome.stock} in stock` } }, 409);
  return json({ item: { id: outcome.id, cart_id, product_id, quantity }, cart: outcome.cart }, 201);
};
