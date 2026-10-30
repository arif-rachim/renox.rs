// GET /orders/live (#292): the active organisation's new orders as they
// happen, over SSE (functions/sse/orders.ts), with no reload.
export const guard = { action: "order.list" };

export function load() {
  return {};
}
