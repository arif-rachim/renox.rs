// Official SDK. Builds a signed webhook test header and verifies it with the
// Web Crypto provider (generateTestHeaderStringAsync + constructEventAsync).
// The synchronous variants need Node's crypto provider; on Bun and Deno/edge
// the SDK's default provider is SubtleCrypto, which only works async.
import Stripe from "stripe";
import { assert, assertEqual } from "./_lib/assert.ts";

// Fake values; never a real key or webhook secret.
const API_KEY = "sk_test_renox_fake_not_a_secret";
const WEBHOOK_SECRET = "whsec_renox_fake_not_a_secret";

export async function check(): Promise<void> {
  const stripe = new Stripe(API_KEY);
  const cryptoProvider = Stripe.createSubtleCryptoProvider();
  const payload = JSON.stringify({ id: "evt_test_1", object: "event", type: "payment_intent.succeeded" });

  const header = await stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: WEBHOOK_SECRET,
    cryptoProvider,
  });
  const event = await stripe.webhooks.constructEventAsync(payload, header, WEBHOOK_SECRET, undefined, cryptoProvider);
  assertEqual(event.type, "payment_intent.succeeded", "constructEventAsync type");

  let rejected = false;
  try {
    await stripe.webhooks.constructEventAsync(
      payload.replace("succeeded", "failed"),
      header,
      WEBHOOK_SECRET,
      undefined,
      cryptoProvider,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "tampered payload rejected");
}
