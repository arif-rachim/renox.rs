// Orders as the F5 pages and the live screen see them (#292): the row as a
// Cedar resource (`[authz.entities] Order`: type, id and the declared
// attributes only), and the live topic of an organisation.

export interface OrderRow {
  id: number;
  user_id: string;
  org_id: string | null;
  amount_fils: number;
  created_at: number;
  refunded?: number | null;
}

/** The order with what `r-can` and `ctx.authz` need: `type`, `id`, the declared attributes. */
export const asResource = (o: OrderRow) => ({ ...o, type: "Order", id: String(o.id) });

/** The live orders topic of an organisation (the policy allows only the active one). */
export const ordersTopic = (orgId: string): string => `orders:${orgId}`;

/** AED from fils, for display. */
export const aed = (fils: number): string => (fils / 100).toFixed(2);
