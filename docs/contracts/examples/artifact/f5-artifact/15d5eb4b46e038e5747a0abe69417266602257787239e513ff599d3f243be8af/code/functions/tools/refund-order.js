import { tool } from "renox";
export default tool({
  name: "refund_order",
  description: "Refund a paid order",
  input: { "~standard": { version: 1, vendor: "renox", validate: (v) => v } },
  action: "order.refund",
  confirm: true,
  async run({ tool: t, db, authz }) {
    const order = await db.queryOne("select id, amount, org_id, status from app__orders where id = ?", [t.input.orderId]);
    await authz.require("order.refund", { type: "Order", ...order });
    if (t.preview) return { would_refund: order.amount };
    await db.execute("update app__orders set status = ? where id = ?", ["refunded", order.id]);
    return { refunded: order.amount };
  },
});
