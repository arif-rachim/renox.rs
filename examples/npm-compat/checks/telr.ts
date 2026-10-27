// Hand-written helper (Telr has no official JavaScript SDK).
// 1. Builds the Hosted Payment Page "create order" request (JSON POST to
//    https://secure.telr.com/gateway/order.json) as a Request object.
// 2. Verifies a transaction advice callback: the `tran_check` value is the
//    SHA-1 of the advice secret and the transaction fields joined with ':'.
//    The exact field list and order must be confirmed against Telr's
//    "Transaction Advice Service" docs before M17 (payments-gcc).
import { assert, assertEqual } from "./_lib/assert.ts";
import { digestHex, timingSafeEqual } from "./_lib/crypto.ts";

const STORE_ID = "12345";
const AUTH_KEY = "renox-fake-not-a-secret";
const ADVICE_SECRET = "renox-fake-advice-secret";

export function buildCreateOrder(cartId: string, amount: string, currency: string): Request {
  return new Request("https://secure.telr.com/gateway/order.json", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      method: "create",
      store: STORE_ID,
      authkey: AUTH_KEY,
      framed: 0,
      order: { cartid: cartId, test: "1", amount, currency, description: "Renox npm-compat check" },
      return: {
        authorised: "https://example.com/pay/ok",
        declined: "https://example.com/pay/declined",
        cancelled: "https://example.com/pay/cancelled",
      },
    }),
  });
}

const ADVICE_FIELDS = ["tran_store", "tran_type", "tran_class", "tran_test", "tran_ref", "tran_prevref",
  "tran_firstref", "tran_currency", "tran_amount", "tran_cartid", "tran_desc", "tran_status",
  "tran_authcode", "tran_authmessage"] as const;

export async function adviceCheck(secret: string, fields: Record<string, string>): Promise<string> {
  return digestHex("SHA-1", [secret, ...ADVICE_FIELDS.map((f) => fields[f] ?? "")].join(":"));
}

export async function check(): Promise<void> {
  const req = buildCreateOrder("cart-1", "99.50", "AED");
  const body = (await req.json()) as { method: string; order: { currency: string } };
  assertEqual(body.method, "create", "method");
  assertEqual(body.order.currency, "AED", "currency");

  const advice: Record<string, string> = {
    tran_store: STORE_ID, tran_type: "sale", tran_class: "ecom", tran_test: "1", tran_ref: "040012345678",
    tran_currency: "AED", tran_amount: "99.50", tran_cartid: "cart-1", tran_status: "A",
    tran_authcode: "123456", tran_authmessage: "Authorised",
  };
  const tranCheck = await adviceCheck(ADVICE_SECRET, advice);
  assertEqual(tranCheck.length, 40, "SHA-1 hex length");
  assert(await timingSafeEqual(tranCheck, await adviceCheck(ADVICE_SECRET, advice)), "advice verifies");
  assert(
    !(await timingSafeEqual(tranCheck, await adviceCheck(ADVICE_SECRET, { ...advice, tran_amount: "1.00" }))),
    "tampered advice rejected",
  );
}
