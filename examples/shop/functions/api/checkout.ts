// POST /api/checkout {"cart_id": "c_1"}
//   -> {"amount": n, "currency": "aed", "order_id": n, "payment_intent": {...}}
//
// Needs a signed-in user (the auth module, #241): 401 without one. The
// order carries the user's id and the active organisation's (the org
// module, #242), if any; the shop has no auth or org code of its own.
//
// Builds the Stripe PaymentIntent request for a cart with the official SDK
// and makes no network call: `renox.toml` declares no outbound host. The
// import is here so that B1 measures a realistic dependency set (zod plus
// one payment SDK; F0 finding in #14, F1 gate condition #37).
import type { Handler } from "renox";
import { auth, org } from "renox:modules";
import Stripe from "stripe";
import { z } from "zod";

import { badRequest, json, notFound } from "../../lib/http.ts";
import { aed, ordersTopic } from "../../lib/orders.ts";

// No key and no network: the client is only used to build and check the
// request. A real integration reads the key from ctx.secrets.
const stripe = new Stripe("renox_shop_example_no_network", {
  httpClient: Stripe.createFetchHttpClient(),
  maxNetworkRetries: 0,
});

const CheckoutInput = z.strictObject({ cart_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u) });

export const POST: Handler = async ({ req, db, realtime }) => {
  const user = (await auth.currentUser()) as { id: string } | null;
  if (user === null) return json({ error: { code: "AUTH_REQUIRED", message: "sign in to check out" } }, 401);
  const parsed = CheckoutInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("invalid checkout request", z.flattenError(parsed.error).fieldErrors);
  const cart = await db.queryOne<{ items: number; total_fils: number }>(
    `select count(*) as items, coalesce(sum(c.quantity * p.price_fils), 0) as total_fils
     from app__cart_items c join app__products p on p.id = c.product_id
     where c.cart_id = ?`,
    [parsed.data.cart_id],
  );
  if (!cart || cart.items === 0) return notFound("cart");
  const active = await org.currentOrg();
  const params: Stripe.PaymentIntentCreateParams = {
    amount: cart.total_fils,
    currency: "aed",
    automatic_payment_methods: { enabled: true },
    metadata: { cart_id: parsed.data.cart_id, items: String(cart.items) },
  };
  // app__orders is an owned table (#292, renox.toml [authz.ownership]): the
  // insert goes through db.scoped(), which checks the owner and org columns.
  const createdAt = Math.floor(Date.now() / 1000);
  const scope = active ? { user_id: user.id, org_id: active.id } : { user_id: user.id };
  const order = await db.scoped(scope).execute("insert into app__orders (user_id, org_id, cart_id, amount_fils, created_at) values (?, ?, ?, ?, ?)", [
    user.id,
    active?.id ?? null,
    parsed.data.cart_id,
    cart.total_fils,
    createdAt,
  ]);
  // The organisation's live orders screen gets the new row (pages/orders/live).
  if (active) {
    const row = { id: Number(order.lastInsertRowid), user_id: user.id, org_id: active.id, amount_fils: cart.total_fils, created_at: createdAt };
    await realtime.publish(ordersTopic(active.id), { fragment: "partials/order-row", data: { o: { ...row, id: String(row.id), amount: aed(row.amount_fils) } }, event: "order-created" });
  }
  return json({
    order_id: Number(order.lastInsertRowid),
    amount: params.amount,
    currency: params.currency,
    payment_intent: params,
    sdk: { api_version: Stripe.API_VERSION, create: typeof stripe.paymentIntents.create },
  });
};
