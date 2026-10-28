// Transpiled from pages/products/[id].ts (examples/shop).
export async function load({ params, db, fragment }) {
  const product = await db.queryOne("select id, name, price, stock from app__products where id = ?", [params.id]);
  if (!product) return new Response(null, { status: 404 });
  if (fragment === "cart_badge") return { product, cartCount: 0 };
  return { product, inStock: product.stock > 0, cartCount: 0 };
}

export const actions = {
  async addToCart({ form, db, session }) {
    const productId = form.get("productId");
    await db.execute("insert into app__cart_items (session_id, product_id) values (?, ?)", [session.id, productId]);
    return { fragments: ["cart_badge"] };
  },
};
