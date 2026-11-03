import type { LoaderContext } from "@renoxium/sdk";
export async function load({ db }: LoaderContext) {
  return { products: await db.query("select 1") };
}
