// GET /products/:id: one product. POST ?/addToCart: adds to the session's
// cart in the action's transaction; an htmx form gets the product fragment
// back with the cart badge out of band.
import type { ActionContext, LoaderContext } from "renox";

import { auth, i18n, org } from "renox:modules";

import type { Product } from "../../lib/http.ts";

const productId = (raw: string | string[] | undefined): number | null => {
  const n = typeof raw === "string" && /^[1-9][0-9]{0,8}$/u.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) ? n : null;
};

/**
 * The stored image (#332) as `<x-image>` takes it: the key and the
 * dimensions kept on the row, so the page needs no storage call. Null
 * before the seed has stored it.
 */
const photoOf = (p: Product) => (p.image_width && p.image_height && p.image.startsWith("storage/") ? { key: p.image, width: p.image_width, height: p.image_height } : null);

const notFound = (): Response => new Response("Product not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

/** The page's locale (i18n, #244) from the user's and the organisation's choice, set; the header's data. */
async function header({ url, setLocale }: Pick<LoaderContext, "url" | "setLocale">) {
  const user = await auth.currentUser();
  const switcher = await org.switcher(url.pathname);
  const locale = await i18n.detectLocale({ user_id: user?.id ?? null, org_locale: switcher?.current?.locale ?? null });
  setLocale(locale.locale, locale.dir);
  return { user, switcher, locale };
}

export async function load({ db, params, session, url, setLocale }: LoaderContext) {
  const { user, switcher, locale } = await header({ url, setLocale });
  const id = productId(params.id);
  if (id === null) return notFound();
  const p = await db.queryOne<Product>("select id, name, description, price_fils, stock, image, image_width, image_height from app__products where id = ?", [id]);
  if (!p) return notFound();
  const cart = await db.queryOne<{ n: number }>("select coalesce(sum(quantity), 0) as n from app__cart_items where cart_id = ?", [session.id]);
  return {
    product: { id: p.id, name: p.name, description: p.description, price: p.price_fils / 100, stock: p.stock, photo: photoOf(p) },
    cart_count: cart?.n ?? 0,
    added: null,
    error: null,
    // The header: auth's user menu and org's switcher (the app.header
    // slot), the language links (i18n).
    auth_user: user,
    org_switcher: switcher,
    i18n_links: locale.alternates,
  };
}

export const actions = {
  async addToCart({ db, form, params, session, url, setLocale }: ActionContext) {
    await header({ url, setLocale });
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
