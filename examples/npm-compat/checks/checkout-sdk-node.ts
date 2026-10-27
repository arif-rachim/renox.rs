// Official SDK (Checkout.com). Constructs a sandbox client; no request is sent.
import { Checkout } from "checkout-sdk-node";
import { assert, assertEqual } from "./_lib/assert.ts";

export async function check(): Promise<void> {
  // v5 requires the merchant subdomain (first 8 characters of the client ID).
  const cko = new Checkout("sk_sbox_renox_fake_not_a_secret", { subdomain: "abcd1234" } as never);
  assertEqual(cko.config.host, "https://abcd1234.api.sandbox.checkout.com", "sandbox host");
  assert(typeof cko.payments.request === "function", "payments.request exists");
  assert(typeof cko.hostedPayments.create === "function", "hostedPayments.create exists");
}
