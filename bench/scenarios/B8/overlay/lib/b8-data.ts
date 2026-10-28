// B8 (#42): the data of the shop list page (pages/products/index.ts, the B6
// page) for `n` products. Both render paths call this, so they run the same
// five queries and differ only in where the HTML is rendered.
// The overlay is typechecked under bench/, where the `renox` package does
// not resolve: the context types it uses are declared here, structurally
// compatible with sdk/src/db.ts and sdk/src/ctx.ts.
type Param = null | number | string;
export interface Db {
  query<T>(sql: string, params?: readonly Param[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: readonly Param[]): Promise<T | null>;
  execute(sql: string, params?: readonly Param[]): Promise<unknown>;
  transaction<T>(fn: (tx: Omit<Db, "transaction">) => Promise<T>): Promise<T>;
}
export interface Ctx {
  db: Db;
  url: URL;
}

/** A row of app__products (examples/shop/migrations/001_init.sql). */
interface Product {
  [column: string]: string | number;
  id: number;
  name: string;
  description: string;
  price_fils: number;
  stock: number;
  category: string;
  image: string;
}

export interface Card {
  id: number;
  name: string;
  category: string;
  price: number;
  stock: number;
}

const toCard = (p: Product): Card => ({ id: p.id, name: p.name, category: p.category, price: p.price_fils / 100, stock: p.stock });

/** `?n=`: 100 (default) or 1000 items. */
export function itemCount(url: URL): number {
  return url.searchParams.get("n") === "1000" ? 1000 : 100;
}

export async function b8Data(db: Db, n: number, cartId: string): Promise<Record<string, unknown>> {
  const products = await db.query<Product>(
    "select id, name, description, price_fils, stock, category, image from app__products order by id limit ?1",
    [n],
  );
  const categories = await db.query<{ category: string; n: number }>(
    "select category, count(*) as n from app__products group by category order by category",
  );
  const total = await db.queryOne<{ n: number }>("select count(*) as n from app__products");
  const prices = await db.queryOne<{ lo: number | null; hi: number | null }>(
    "select min(price_fils) as lo, max(price_fils) as hi from app__products",
  );
  const cart = await db.queryOne<{ n: number }>(
    "select coalesce(sum(quantity), 0) as n from app__cart_items where cart_id = ?",
    [cartId],
  );
  return {
    q: "",
    products: products.map(toCard),
    categories,
    total: total?.n ?? 0,
    price_min: (prices?.lo ?? 0) / 100,
    price_max: (prices?.hi ?? 0) / 100,
    cart_count: cart?.n ?? 0,
  };
}
