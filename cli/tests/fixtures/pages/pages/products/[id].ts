import type { ActionContext, LoaderContext } from "renox";
export async function load({ params }: LoaderContext) {
  return { product: { name: params.id } };
}
export const actions = {
  async addToCart({ form }: ActionContext) {
    // a comment with { braces } and "quotes"
    const label = `added ${form.get("productId")}`;
    return { label, fragments: ["cart_badge"] };
  },
  remove: async () => ({ removed: { ok: true } }),
  "rename": () => undefined,
};
