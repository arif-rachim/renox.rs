// A browser script of a tenant app (public/scripts/cart.js once built).
// The fixture for #128: an error thrown in `boom` must be shown at this
// file's line 13, not at the built file's position.

interface Cart {
  items: { price: number }[];
  total?: number;
}

export function boom(cart: Cart): string {
  const n = cart.items.length;
  // `total` is missing: this line throws.
  return cart.total!.toFixed(n);
}

document.querySelector("#checkout")?.addEventListener("click", () => {
  boom({ items: [] });
});
