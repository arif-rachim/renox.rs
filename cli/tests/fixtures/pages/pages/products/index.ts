import type { LoaderContext } from "renox";
export async function load({ db }: LoaderContext) {
  return { products: await db.query("select 1") };
}
