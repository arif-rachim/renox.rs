// The billing module's services (#329): see lib/core.ts and lib/adapter.ts.
import * as core from "./lib/core.ts";

type Ctx = core.BillingCtx;

export const createPlan = (ctx: Ctx, p: Parameters<typeof core.createPlan>[1]) => core.createPlan(ctx, p ?? {});
export const plans = (ctx: Ctx) => core.plans(ctx);
/** One checkout per order: ({ order_id, customer_id, plan_id } | { order_id, customer_id, amount, description }) -> { url, session_id, reused }. */
export const createCheckout = (ctx: Ctx, opts: core.CheckoutOptions) => core.createCheckout(ctx, opts ?? {});
export const checkout = (ctx: Ctx, customerId: unknown, planId: unknown) => core.checkout(ctx, customerId, planId);
export const getSubscription = (ctx: Ctx, customerId: unknown) => core.subscription(ctx, customerId);
export const subscription = getSubscription;
export const recordUsage = (ctx: Ctx, customerId: unknown, metric: unknown, quantity: unknown) => core.recordUsage(ctx, customerId, metric, quantity);
export const usage = (ctx: Ctx, customerId: unknown, metric: unknown, since: unknown) => core.usage(ctx, customerId, metric, since);
export const listInvoices = (ctx: Ctx, customerId: unknown) => core.invoices(ctx, customerId);
export const invoices = listInvoices;
export const refund = (ctx: Ctx, invoiceId: unknown, amount: unknown) => core.refund(ctx, invoiceId, amount);
