// Test only: defines the plans the pages show (app code calls the service).
import { billing } from "renox:modules";

export async function POST() {
  await billing.createPlan({ id: "pro", name: "Pro", amount: 29900, interval: "month" });
  return Response.json({ ok: true });
}
