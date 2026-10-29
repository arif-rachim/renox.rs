export const guard = { action: "order.read", resource: { type: "Order", id: ":id" } };
export async function load({ db, params }) {
  return { order: await db.queryOne("select id, amount, status from app__orders where id = ?", [params.id]) };
}
