// Hand-written helper (PayTabs has no official JavaScript SDK for edge runtimes).
// PayTabs signs callbacks (IPN) with HMAC-SHA256 of the raw request body using
// the profile's server key, sent in the `signature` header; the return-page
// POST is signed the same way over the URL-encoded, key-sorted fields without
// `signature`. Cross-checked against node:crypto so both crypto stacks run.
import { createHmac } from "node:crypto";
import { assert, assertEqual } from "./_lib/assert.ts";
import { hmacSha256Hex, timingSafeEqual } from "./_lib/crypto.ts";

const SERVER_KEY = "SRJN-renox-fake-not-a-secret";

export async function signCallback(serverKey: string, rawBody: string): Promise<string> {
  return hmacSha256Hex(serverKey, rawBody);
}

export async function signReturnFields(serverKey: string, fields: Record<string, string>): Promise<string> {
  const query = Object.keys(fields)
    .filter((k) => k !== "signature" && fields[k] !== "")
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(fields[k] ?? "")}`)
    .join("&");
  return hmacSha256Hex(serverKey, query);
}

export async function check(): Promise<void> {
  const raw = JSON.stringify({ tran_ref: "TST2026000001", cart_id: "cart-1", cart_amount: "99.50", cart_currency: "AED" });
  const signature = await signCallback(SERVER_KEY, raw);
  const nodeSignature = createHmac("sha256", SERVER_KEY).update(raw).digest("hex");
  assertEqual(signature, nodeSignature, "Web Crypto and node:crypto agree");
  assert(await timingSafeEqual(signature, await signCallback(SERVER_KEY, raw)), "callback verifies");
  assert(!(await timingSafeEqual(signature, await signCallback(SERVER_KEY, `${raw} `))), "tampered body rejected");

  const fields = { acquirerMessage: "", cartId: "cart-1", respStatus: "A", tranRef: "TST2026000001" };
  const s1 = await signReturnFields(SERVER_KEY, fields);
  const s2 = await signReturnFields(SERVER_KEY, { ...fields, signature: s1 });
  assertEqual(s1, s2, "signature field excluded from the signed string");
}
