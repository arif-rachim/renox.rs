// GET /b8?n=100|1000: render path A. The cell renders pages/b8/index.html
// (a copy of pages/products/index.html, made by bench/scenarios/B8/run.sh)
// in Rust from this loader's data; HX-Target: product-list renders the
// product_list fragment only.
import { b8Data, itemCount, type Ctx } from "../../lib/b8-data.ts";

export async function load({ db, url, session }: Ctx & { session: { id: string } }) {
  return b8Data(db, itemCount(url), session.id);
}
