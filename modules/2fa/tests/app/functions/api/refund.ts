// Test only: a refund behind the policy that needs mfa_verified; the guard
// denies before the handler runs (403 RENOX_FORBIDDEN).
export const guard = { action: "invoice.refund" };

export function POST() {
  return Response.json({ refunded: true });
}
