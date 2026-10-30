// The billing module's services (#329): see lib/core.ts.
import * as core from "./lib/core.ts";

type Ctx = core.BillingCtx;

export const createPlan = (ctx: Ctx, p: Parameters<typeof core.createPlan>[1]) => core.createPlan(ctx, p ?? {});
export const plans = (ctx: Ctx) => core.plans(ctx);
export const checkout = (ctx: Ctx, customerId: unknown, planId: unknown) => core.checkout(ctx, customerId, planId);
export const subscription = (ctx: Ctx, customerId: unknown) => core.subscription(ctx, customerId);
export const recordUsage = (ctx: Ctx, customerId: unknown, metric: unknown, quantity: unknown) => core.recordUsage(ctx, customerId, metric, quantity);
export const usage = (ctx: Ctx, customerId: unknown, metric: unknown, since: unknown) => core.usage(ctx, customerId, metric, since);
export const invoices = (ctx: Ctx, customerId: unknown) => core.invoices(ctx, customerId);
