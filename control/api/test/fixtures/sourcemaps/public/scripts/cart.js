// scripts/cart.ts
function boom(cart) {
  const n = cart.items.length;
  return cart.total.toFixed(n);
}
document.querySelector("#checkout")?.addEventListener("click", () => {
  boom({ items: [] });
});
export {
  boom
};

//# debugId=8477610C9B30480364756E2164756E21
