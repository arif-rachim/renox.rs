// Live smoke test of platform billing against a Stripe sandbox (#350, #351).
// Not part of `bun test`: it needs a test-mode key and the network.
//
//   STRIPE_SECRET_KEY=sk_test_… STRIPE_PUBLISHABLE_KEY=pk_test_… bun scripts/stripe-smoke.ts
//
// It walks the path the API takes: a Customer per tenant, a SetupIntent for
// it confirmed with a test card (the browser's step), the saved card read
// back and made the default, an off-session charge of an invoice (and the
// same attempt again: one PaymentIntent), a declined card, the tenant of a
// PaymentIntent, and a dispute found through its PaymentIntent. Every object
// is created in test mode with `metadata[tenant_id]` = `t_smoke_<run>`.

import { stripePsp } from "../src/billing/routes.ts";

const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!key.startsWith("sk_test_")) {
  console.error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_…)");
  process.exit(2);
}

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  (${detail})`}`);
}

/** The browser's part (Stripe.js), done server-side with Stripe's test payment methods. */
async function stripe(path: string, form?: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: form === undefined ? undefined : new URLSearchParams(form),
  });
  return (await res.json()) as Record<string, any>;
}

const run = Date.now().toString(36);
const tenant = `t_smoke_${run}`;

const customer = await stripePsp.ensureCustomer(tenant, { email: `owner+${run}@example.com`, name: "Smoke LLC" });
check("a Customer for the tenant", customer.startsWith("cus_"), customer);
check("the same Customer on a retried call (idempotency key)", (await stripePsp.ensureCustomer(tenant, { email: `owner+${run}@example.com`, name: "Smoke LLC" })) === customer);

async function saveCard(testCard: string): Promise<string | null> {
  const s = await stripePsp.createSetup(tenant, customer);
  await stripe(`setup_intents/${s.setup_id}/confirm`, { payment_method: testCard });
  return (await stripePsp.confirmSetup(s.setup_id))?.id ?? null;
}

// The dashboard's step exactly (public/billing.js, Stripe.js confirmCardSetup): the publishable key and the client secret.
{
  const s = await stripePsp.createSetup(tenant, customer);
  const res = await fetch(`https://api.stripe.com/v1/setup_intents/${s.setup_id}/confirm`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.publishable_key}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_secret: s.client_secret, "payment_method_data[type]": "card", "payment_method_data[card][token]": "tok_visa" }),
  });
  const j = (await res.json()) as { status?: string; error?: { message?: string } };
  check("the browser's confirm (publishable key and client secret) succeeds", j.status === "succeeded", j.status ?? j.error?.message ?? "");
}

const visa = await saveCard("pm_card_visa");
check("a card saved through a SetupIntent of the Customer", visa !== null, visa ?? "not confirmed");
const pm = await stripe(`payment_methods/${visa}`);
check("the card is attached to the Customer", pm.customer === customer);
await stripePsp.setDefault(customer, visa as string, null);
check("the card is the Customer's default", (await stripe(`customers/${customer}`)).invoice_settings?.default_payment_method === visa);

const invoice = `INV-SMOKE-${run}`;
const paid = await stripePsp.charge({ tenantId: tenant, invoiceId: invoice, customer, paymentMethod: visa as string, amount: 8295, attempt: 1 });
check("an off-session charge of AED 82.95 succeeds", paid.status === "succeeded", JSON.stringify(paid));
const again = await stripePsp.charge({ tenantId: tenant, invoiceId: invoice, customer, paymentMethod: visa as string, amount: 8295, attempt: 1 });
check("the same attempt again is the same PaymentIntent", "payment_intent" in again && "payment_intent" in paid && again.payment_intent === paid.payment_intent);
if ("payment_intent" in paid && paid.payment_intent !== null) {
  const pi = await stripe(`payment_intents/${paid.payment_intent}`);
  check("the PaymentIntent carries the tenant and the invoice", pi.metadata?.tenant_id === tenant && pi.metadata?.invoice_id === invoice && pi.amount === 8295 && pi.currency === "aed");
  check("paymentIntentTenant reads the tenant back", (await stripePsp.paymentIntentTenant(paid.payment_intent)) === tenant);
}

const declining = await saveCard("pm_card_chargeCustomerFail");
check("a card that attaches but declines charges is saved", declining !== null);
await stripePsp.setDefault(customer, declining as string, visa);
check("the replaced card is detached", (await stripe(`payment_methods/${visa}`)).customer === null);
const declined = await stripePsp.charge({ tenantId: tenant, invoiceId: `${invoice}-2`, customer, paymentMethod: declining as string, amount: 8295, attempt: 1 });
check("its off-session charge fails with a decline code", declined.status === "failed" && declined.code !== "", JSON.stringify(declined));

// The path before #350: a SetupIntent without a Customer leaves a card that cannot be charged again.
const lone = await stripe("setup_intents", { usage: "off_session", "automatic_payment_methods[enabled]": "true", "automatic_payment_methods[allow_redirects]": "never" });
const loneCard = (await stripe(`setup_intents/${lone.id}/confirm`, { payment_method: "pm_card_visa" })).payment_method as string;
const unattached = await stripePsp.charge({ tenantId: tenant, invoiceId: `${invoice}-3`, customer, paymentMethod: loneCard, amount: 500, attempt: 1 });
check("a card saved without a Customer cannot be charged", unattached.status === "failed", JSON.stringify(unattached));

// A dispute: Stripe's test card creates one on the charge. The dispute object carries no metadata of ours.
const disputeCard = await saveCard("pm_card_createDispute");
const disputed = await stripePsp.charge({ tenantId: tenant, invoiceId: `${invoice}-4`, customer, paymentMethod: disputeCard as string, amount: 5000, attempt: 1 });
let dispute: Record<string, any> | undefined;
for (let i = 0; i < 10 && dispute === undefined && "payment_intent" in disputed && disputed.payment_intent !== null; i++) {
  await Bun.sleep(2000);
  dispute = ((await stripe(`disputes?payment_intent=${disputed.payment_intent}`)).data ?? [])[0];
}
check("a dispute is opened on the charge", dispute !== undefined);
if (dispute !== undefined) {
  check("the dispute's own metadata is empty", Object.keys(dispute.metadata ?? {}).length === 0);
  check("its PaymentIntent names the tenant", (await stripePsp.paymentIntentTenant(dispute.payment_intent)) === tenant);
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
