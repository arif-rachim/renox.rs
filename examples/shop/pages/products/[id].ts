// GET /products/:id: one product. POST ?/addToCart: adds to the session's
// cart in the action's transaction; an htmx form gets the product fragment
// back with the cart badge out of band.
import type { ActionContext, LoaderContext } from "renox";

import type { Product } from "../../lib/http.ts";

const productId = (raw: string | string[] | undefined): number | null => {
  const n = typeof raw === "string" && /^[1-9][0-9]{0,8}$/u.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) ? n : null;
};

const notFound = (): Response => new Response("Product not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function load({ db, params, session }: LoaderContext) {
  const id = productId(params.id);
  if (id === null) return notFound();
  const p = await db.queryOne<Product>("select id, name, description, price_fils, stock from app__products where id = ?", [id]);
  if (!p) return notFound();
  const cart = await db.queryOne<{ n: number }>("select coalesce(sum(quantity), 0) as n from app__cart_items where cart_id = ?", [session.id]);
  return {
    product: { id: p.id, name: p.name, description: p.description, price: p.price_fils / 100, stock: p.stock },
    cart_count: cart?.n ?? 0,
    added: null,
    error: null,
  };
}

export const actions = {
  async addToCart({ db, form, params, session }: ActionContext) {
    const id = productId(params.id);
    const quantity = Number(form.get("quantity") ?? 1);
    if (id === null) return notFound();
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) return { error: "Quantity must be between 1 and 99." };
    const p = await db.queryOne<{ stock: number }>("select stock from app__products where id = ?", [id]);
    if (!p) return notFound();
    const inCart = await db.queryOne<{ n: number }>(
      "select coalesce(sum(quantity), 0) as n from app__cart_items where cart_id = ? and product_id = ?",
      [session.id, id],
    );
    if ((inCart?.n ?? 0) + quantity > p.stock) return { error: `Only ${p.stock} in stock.` };
    await db.execute("insert into app__cart_items (cart_id, product_id, quantity, created_at) values (?, ?, ?, ?)", [
      session.id,
      id,
      quantity,
      Math.floor(Date.now() / 1000),
    ]);
    return { added: quantity, fragments: ["cart_badge"] };
  },
};
