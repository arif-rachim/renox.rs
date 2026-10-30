// Test only: the signed-in user's bank-transfer checkout for an order (app code calls the service).
import { auth, billing } from "renox:modules";

export async function POST(ctx) {
  const user = await auth.requireUser();
  const s = await billing.createCheckout({ order_id: ctx.url.searchParams.get("order"), customer_id: user.id, amount: 125050, description: "Order", method: "bank" });
  return Response.json(s);
}
