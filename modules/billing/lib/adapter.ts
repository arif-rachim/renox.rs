// The PSP adapter of the billing module (#329): what a payment provider does
// for it. Stripe UAE is here; the GCC providers come with #330 behind the
// same interface. Amounts are integers in minor units (fils for AED).

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface SessionRequest {
  order_id: string;
  customer_id: string;
  mode: "payment" | "subscription";
  amount: number;
  currency: string;
  description: string;
  interval?: "month" | "year";
  success_url: string;
  cancel_url: string;
}

export interface Session {
  id: string;
  url: string;
}

/** A provider event, normalised. `kind` is what the module applies. */
export interface PspEvent {
  id: string;
  kind: "checkout_completed" | "payment_received" | "payment_failed" | "invoice_issued" | "subscription_cancelled" | "refunded" | "ignored";
  order_id?: string;
  customer_id?: string;
  invoice_id?: string;
  amount?: number;
  currency?: string;
  payment_intent?: string;
  psp_customer?: string;
  psp_subscription?: string;
  period_end?: number;
}

export interface PspAdapter {
  readonly name: string;
  createSession(r: SessionRequest): Promise<Session>;
  /** A payment authorised but not captured (providers with separate capture); Stripe Checkout captures itself. */
  capture(paymentIntent: string, amount: number): Promise<{ ok: boolean }>;
  refund(paymentIntent: string, amount: number, idempotencyKey: string): Promise<{ id: string }>;
  /** The verified payload (`webhook.verify`'s) as an event of the module. */
  parseWebhook(payload: unknown): PspEvent;
}

export class PspError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PspError";
  }
}

export function stripe(fetchFn: FetchFn, key: string): PspAdapter {
  const call = async (path: string, form: URLSearchParams, idempotency?: string): Promise<Record<string, any>> => {
    let res: Response;
    try {
      res = await fetchFn(`https://api.stripe.com/v1/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded", ...(idempotency ? { "idempotency-key": idempotency } : {}) },
        body: form.toString(),
      });
    } catch {
      throw new PspError("stripe unreachable", 0);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new PspError(`stripe ${res.status}`, res.status);
    }
    return (await res.json()) as Record<string, any>;
  };
  return {
    name: "stripe",
    async createSession(r) {
      const form = new URLSearchParams({
        mode: r.mode,
        success_url: r.success_url,
        cancel_url: r.cancel_url,
        client_reference_id: r.customer_id,
        "metadata[customer_id]": r.customer_id,
        "metadata[order_id]": r.order_id,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": r.currency.toLowerCase(),
        "line_items[0][price_data][unit_amount]": String(r.amount),
        "line_items[0][price_data][product_data][name]": r.description,
      });
      if (r.mode === "subscription") {
        form.set("line_items[0][price_data][recurring][interval]", r.interval ?? "month");
        form.set("subscription_data[metadata][customer_id]", r.customer_id);
      } else {
        form.set("payment_intent_data[metadata][order_id]", r.order_id);
        form.set("payment_intent_data[metadata][customer_id]", r.customer_id);
      }
      // One session per order, even when the call is retried (Stripe's idempotency key).
      const s = await call("checkout/sessions", form, `checkout:${r.order_id}`);
      return { id: String(s.id), url: String(s.url) };
    },
    async capture(paymentIntent, amount) {
      await call(`payment_intents/${encodeURIComponent(paymentIntent)}/capture`, new URLSearchParams({ amount_to_capture: String(amount) }));
      return { ok: true };
    },
    async refund(paymentIntent, amount, idempotencyKey) {
      const r = await call("refunds", new URLSearchParams({ payment_intent: paymentIntent, amount: String(amount) }), idempotencyKey);
      return { id: String(r.id) };
    },
    parseWebhook(payload) {
      const e = (payload ?? {}) as { id?: string; type?: string; data?: { object?: Record<string, any> } };
      const o = e.data?.object ?? {};
      const meta = (o.metadata ?? {}) as Record<string, string>;
      const base = { id: String(e.id ?? ""), customer_id: meta.customer_id ?? (typeof o.client_reference_id === "string" ? o.client_reference_id : undefined) };
      switch (e.type) {
        case "checkout.session.completed":
          return { ...base, kind: "checkout_completed", order_id: meta.order_id, amount: Number(o.amount_total ?? 0), currency: String(o.currency ?? "aed").toUpperCase(), payment_intent: typeof o.payment_intent === "string" ? o.payment_intent : undefined, psp_customer: o.customer ?? undefined, psp_subscription: o.subscription ?? undefined };
        case "invoice.finalized":
          return { ...base, kind: "invoice_issued", invoice_id: String(o.id), amount: Number(o.amount_due ?? 0), currency: String(o.currency ?? "aed").toUpperCase(), psp_customer: o.customer ?? undefined };
        case "invoice.paid":
          return { ...base, kind: "payment_received", invoice_id: String(o.id), amount: Number(o.amount_paid ?? 0), currency: String(o.currency ?? "aed").toUpperCase(), payment_intent: typeof o.payment_intent === "string" ? o.payment_intent : undefined, psp_customer: o.customer ?? undefined, period_end: typeof o.lines?.data?.[0]?.period?.end === "number" ? o.lines.data[0].period.end * 1000 : undefined };
        case "invoice.payment_failed":
        case "payment_intent.payment_failed":
          return { ...base, kind: "payment_failed", invoice_id: typeof o.id === "string" && e.type === "invoice.payment_failed" ? o.id : undefined, order_id: meta.order_id, psp_customer: o.customer ?? undefined };
        case "customer.subscription.deleted":
          return { ...base, kind: "subscription_cancelled", psp_customer: o.customer ?? undefined };
        case "charge.refunded":
          return { ...base, kind: "refunded", payment_intent: typeof o.payment_intent === "string" ? o.payment_intent : undefined, amount: Number(o.amount_refunded ?? 0) };
        default:
          return { ...base, kind: "ignored" };
      }
    },
  };
}
