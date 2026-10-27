// POST /api/checkout {"cart_id": "c_1"}
//   -> {"amount": n, "currency": "aed", "payment_intent": {...}}
//
// Builds the Stripe PaymentIntent request for a cart with the official SDK
// and makes no network call: `renox.toml` declares no outbound host. The
// import is here so that B1 measures a realistic dependency set (zod plus
// one payment SDK; F0 finding in #14, F1 gate condition #37).
import type { Handler } from "renox";
import Stripe from "stripe";
import { z } from "zod";

import { badRequest, json, notFound } from "../../lib/http.ts";

// No key and no network: the client is only used to build and check the
// request. A real integration reads the key from ctx.secrets.
const stripe = new Stripe("renox_shop_example_no_network", {
  httpClient: Stripe.createFetchHttpClient(),
  maxNetworkRetries: 0,
});

const CheckoutInput = z.strictObject({ cart_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u) });

export const POST: Handler = async ({ req, db }) => {
  const parsed = CheckoutInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid checkout request", z.flattenError(parsed.error).fieldErrors);
  const cart = await db.queryOne<{ items: number; total_fils: number }>(
    `select count(*) as items, coalesce(sum(c.quantity * p.price_fils), 0) as total_fils
     from app__cart_items c join app__products p on p.id = c.product_id
     where c.cart_id = ?`,
    [parsed.data.cart_id],
  );
  if (!cart || cart.items === 0) return notFound("cart");
  const params: Stripe.PaymentIntentCreateParams = {
    amount: cart.total_fils,
    currency: "aed",
    automatic_payment_methods: { enabled: true },
    metadata: { cart_id: parsed.data.cart_id, items: String(cart.items) },
  };
  return json({
    amount: params.amount,
    currency: params.currency,
    payment_intent: params,
    sdk: { api_version: Stripe.API_VERSION, create: typeof stripe.paymentIntents.create },
  });
};
