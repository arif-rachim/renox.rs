// Abandoned checkouts (#655): every 30 minutes, card checkouts still open
// after 24 h expire (Stripe's sessions last 24 h and the webhook may have
// been missed), so the order can be retried.
import { expireStaleCheckouts } from "../services.ts";

export const schedule = "*/30 * * * *";

export async function run(ctx: Parameters<typeof expireStaleCheckouts>[0]): Promise<void> {
  await expireStaleCheckouts(ctx);
}
