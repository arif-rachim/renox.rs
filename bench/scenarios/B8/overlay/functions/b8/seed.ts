// POST /b8/seed: after POST /api/dev/seed (100 products), 900 more as
// copies, for the 1,000-item runs. Dev hosts only, like the shop's seed.
import type { Ctx } from "../../lib/b8-data.ts";

const MORE = `with recursive k(n) as (select 1 union all select n + 1 from k where n < 9)
insert or ignore into app__products (id, name, description, price_fils, stock, category, image)
select p.id + 100 * k.n, p.name || ' #' || k.n, p.description, p.price_fils + k.n, (p.stock + k.n) % 50, p.category, p.image
from app__products p, k where p.id <= 100`;

export const POST = async ({ db, url }: Ctx): Promise<Response> => {
  if (!url.hostname.endsWith(".localhost")) return new Response("not found", { status: 404 });
  await db.transaction(async (tx) => {
    await tx.execute(MORE);
  });
  const row = await db.queryOne<{ n: number }>("select count(*) as n from app__products");
  return Response.json({ products: row?.n ?? 0 });
};
