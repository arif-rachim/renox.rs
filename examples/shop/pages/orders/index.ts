// GET /orders (#292): the signed-in user's orders in their active
// organisation. The guard (`order.list`) denies before the loader runs; the
// loader reads through db.scoped() (owned rows); the refund button is
// `r-can="invoice.refund"` with the order as resource, so the template asks
// the same policy the action enforces. POST ?/refund: the order loaded
// from the database, `ctx.authz.require` (roles, the amount threshold, the
// second factor; a sensitive action, so audited), the 2fa module's
// `requireRecent`, the refund row, a notification.
import { notifications, twofa } from "renox:modules";

import { aed, asResource, type OrderRow } from "../../lib/orders.ts";

export const guard = { action: "order.list" };

interface Ctx {
  principal: { id: string; attrs: { org?: string } } | null;
  db: { scoped(scope: Record<string, string>): { query<T>(sql: string, params?: unknown[]): Promise<T[]>; queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>; execute(sql: string, params?: unknown[]): Promise<unknown> } };
  authz: { require(action: string, resource?: unknown): Promise<void> };
  form: FormData;
  url: URL;
}

const scopeOf = (ctx: Ctx) => ({ user_id: ctx.principal?.id ?? "", org_id: ctx.principal?.attrs.org ?? "" });

async function view(ctx: Ctx, notice: string | null) {
  const rows = await ctx.db.scoped(scopeOf(ctx)).query<OrderRow>(
    "select o.id, o.user_id, o.org_id, o.amount_fils, o.created_at, r.id as refunded from app__orders o left join app__refunds r on r.order_id = o.id where o.user_id = ? order by o.id desc limit 50",
    [ctx.principal?.id ?? ""],
  );
  const orders = rows.map((o) => ({ ...asResource(o), amount: aed(o.amount_fils) }));
  return { orders, notice };
}

export const load = (ctx: Ctx) => view(ctx, null);

export const actions = {
  async refund(ctx: Ctx) {
    const id = Number(ctx.form.get("order"));
    const order = await ctx.db.scoped(scopeOf(ctx)).queryOne<OrderRow>("select id, user_id, org_id, amount_fils, created_at from app__orders where id = ?", [Number.isSafeInteger(id) ? id : 0]);
    if (order === null) return new Response("Not found", { status: 404 });
    // The same policy as the button: a curl request without the role, over
    // the threshold, or without the second factor is denied here (403). The
    // denial is answered, not thrown, so the action's transaction commits
    // the platform's audit row of the decision (a sensitive action).
    try {
      await ctx.authz.require("invoice.refund", asResource(order));
    } catch (e) {
      if ((e as { code?: string }).code === "RENOX_FORBIDDEN") return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });
      throw e;
    }
    await twofa.requireRecent({ next: "/orders" });
    await ctx.db.scoped(scopeOf(ctx)).execute("insert into app__refunds (order_id, amount_fils, refunded_by, created_at) values (?, ?, ?, ?)", [order.id, order.amount_fils, ctx.principal?.id, Math.floor(Date.now() / 1000)]);
    await notifications.notify(order.user_id, { category: "orders", title: `Order #${order.id} refunded`, link: "/orders" });
    return view(ctx, `Order #${order.id} refunded.`);
  },
};
