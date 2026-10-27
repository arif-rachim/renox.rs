// Hand-written helper (Tabby has no official JavaScript SDK).
// Builds the checkout session request (POST https://api.tabby.ai/api/v2/checkout,
// Bearer secret key) and verifies a webhook by its merchant-configured
// authorization header value in constant time (Tabby webhooks carry a shared
// header value, not an HMAC).
import { assert, assertEqual } from "./_lib/assert.ts";
import { timingSafeEqual } from "./_lib/crypto.ts";

const SECRET_KEY = "sk_test_renox_fake_not_a_secret";
const WEBHOOK_HEADER_VALUE = "renox-fake-webhook-token";

export function buildCheckoutSession(amount: string, currency: "AED" | "SAR" | "KWD"): Request {
  return new Request("https://api.tabby.ai/api/v2/checkout", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      payment: {
        amount,
        currency,
        description: "Renox npm-compat check",
        buyer: { name: "Test Buyer", email: "card.success@tabby.ai", phone: "+971500000001" },
        order: { reference_id: "cart-1", items: [{ title: "Item", quantity: 1, unit_price: amount, category: "test" }] },
        shipping_address: { city: "Dubai", address: "Test street 1", zip: "00000" },
      },
      lang: "ar",
      merchant_code: "renox_test",
      merchant_urls: {
        success: "https://example.com/pay/ok",
        cancel: "https://example.com/pay/cancel",
        failure: "https://example.com/pay/failed",
      },
    }),
  });
}

export async function check(): Promise<void> {
  const req = buildCheckoutSession("250.00", "AED");
  assertEqual(req.headers.get("authorization")?.startsWith("Bearer "), true, "bearer auth");
  const body = (await req.json()) as { payment: { amount: string; currency: string }; lang: string };
  assertEqual(body.payment.amount, "250.00", "amount as string");
  assertEqual(body.lang, "ar", "lang");
  assert(await timingSafeEqual(WEBHOOK_HEADER_VALUE, "renox-fake-webhook-token"), "webhook header accepted");
  assert(!(await timingSafeEqual(WEBHOOK_HEADER_VALUE, "wrong")), "wrong webhook header rejected");
}
