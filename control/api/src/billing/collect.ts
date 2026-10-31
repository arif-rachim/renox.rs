// Collecting platform invoices (#350; deploy-api.md 0.5.1 section 20): each
// invoice the monthly close issues is charged off-session to the card the
// owner saved on the tenant's Stripe Customer. A declined charge is retried
// 1, 3 and 7 days after the invoice date, and the owner is emailed after each
// failure; the tier machine still suspends a tenant whose invoice is unpaid
// 14 days after its date. A new card pays the open invoices at once
// (confirmPaymentMethod), and a PaymentIntent's webhook settles an invoice
// the same way as the synchronous answer.
//
// The attempt count, its time, the PaymentIntent and the decline code are
// columns of the invoice row (migration 0026), never part of the Invoice
// body; no card data is read or kept.

import { reinstate, type TierState } from "@renox/billing";

import type { Deps } from "../context.ts";
import { num, type Db } from "../db/db.ts";
import { currentPsp, setTierState } from "./routes.ts";

type Row = Record<string, unknown>;

const DAY_MS = 86_400_000;
/** Days after the invoice date at which a failed charge is tried again. */
export const RETRY_DAYS = [1, 3, 7];

/** Fils of an invoice amount ("82.95"). */
const fils = (aed: string): number => Math.round(Number(aed) * 100);

/**
 * Marks the invoice paid (once) and reinstates the tenant's tier. Answers
 * whether this call moved it to paid.
 */
export async function markInvoicePaid(deps: Deps, tenantId: string, invoiceId: string, now: number, paymentIntent: string | null = null): Promise<boolean> {
  const r = (await deps.db.query<Row>("select body from invoices where tenant_id = $1 and id = $2 and status = 'open'", [tenantId, invoiceId]))[0];
  if (r === undefined) return false;
  const inv = { ...JSON.parse(r.body as string), status: "paid", paid_at: now };
  const moved = await deps.db.query(
    "update invoices set status = 'paid', paid_at = $3, body = $4, payment_intent = coalesce($5, payment_intent), decline_code = null where tenant_id = $1 and id = $2 and status = 'open' returning id",
    [tenantId, invoiceId, now, JSON.stringify(inv), paymentIntent],
  );
  if (moved.length === 0) return false;
  const row = (await deps.db.query<Row>("select state from tenant_billing where tenant_id = $1", [tenantId]))[0];
  if (row !== undefined) await setTierState(deps, deps.db, tenantId, reinstate(row.state as TierState), now);
  return true;
}

/** The owner's address of a tenant, or null. */
async function ownerEmail(db: Db, tenantId: string): Promise<string | null> {
  const r = await db.query<Row>("select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.role = 'owner' limit 1", [tenantId]);
  return typeof r[0]?.email === "string" ? r[0].email : null;
}

async function mailFailure(deps: Deps, tenantId: string, invoiceId: string, total: string, code: string, retryAt: number | null): Promise<void> {
  const to = await ownerEmail(deps.db, tenantId);
  if (to === null) return;
  const next = retryAt === null ? "No further attempt is made automatically." : `It is tried again on ${new Date(retryAt).toISOString().slice(0, 10)} (UTC).`;
  const why = code === "no_payment_method" ? "no card on file can be charged" : code === "authentication_required" ? "the bank asked for authentication" : "the card was declined";
  await deps.mailer
    .send({
      to,
      kind: "invoice_payment_failed",
      subject: `Payment of Renox invoice ${invoiceId} failed`,
      text: `The charge of AED ${total} for invoice ${invoiceId} (tenant ${tenantId}) failed: ${why}. ${next} Add or replace the card: https://dashboard.renox.app/billing (tenant ${tenantId}). An invoice unpaid 14 days after its date suspends the tenant.`,
    })
    .catch(() => deps.log.warn("invoice payment email not sent", { tenant_id: tenantId, invoice: invoiceId }));
}

/**
 * One charge attempt of an open invoice. `skipped` when it is not open or the
 * PSP was not reached (nothing counted, the next pass tries again).
 */
export async function chargeInvoice(deps: Deps, tenantId: string, invoiceId: string, now: number): Promise<"paid" | "pending" | "failed" | "skipped"> {
  const r = (
    await deps.db.query<Row>(
      "select i.status, i.body, i.issued_at, i.charge_attempts, b.stripe_customer, b.payment_method from invoices i join tenant_billing b on b.tenant_id = i.tenant_id where i.tenant_id = $1 and i.id = $2",
      [tenantId, invoiceId],
    )
  )[0];
  if (r === undefined || r.status !== "open") return "skipped";
  const total = String((JSON.parse(r.body as string) as { total: string }).total);
  const attempt = num(r.charge_attempts) + 1;
  const retryAt = (n: number): number | null => (n <= RETRY_DAYS.length ? num(r.issued_at) + (RETRY_DAYS[n - 1] as number) * DAY_MS : null);
  const pm = r.payment_method === null ? null : (JSON.parse(r.payment_method as string) as { id?: string }).id ?? null;
  const customer = typeof r.stripe_customer === "string" ? r.stripe_customer : null;
  // A card saved before #350 is on no customer: it cannot be charged again.
  const result =
    customer === null || pm === null
      ? ({ status: "failed", payment_intent: null, code: "no_payment_method" } as const)
      : await currentPsp().charge({ tenantId, invoiceId, customer, paymentMethod: pm, amount: fils(total), attempt });
  if (result.status === "unavailable") {
    deps.log.warn("invoice charge not attempted: PSP unreachable", { tenant_id: tenantId, invoice: invoiceId });
    return "skipped";
  }
  const code = result.status === "failed" ? result.code : null;
  await deps.db.query("update invoices set charge_attempts = $3, charged_at = $4, payment_intent = coalesce($5, payment_intent), decline_code = $6 where tenant_id = $1 and id = $2", [
    tenantId,
    invoiceId,
    attempt,
    now,
    result.payment_intent,
    code,
  ]);
  if (result.status === "succeeded") {
    await markInvoicePaid(deps, tenantId, invoiceId, now, result.payment_intent);
    return "paid";
  }
  if (result.status === "pending") return "pending";
  deps.log.warn("invoice charge failed", { tenant_id: tenantId, invoice: invoiceId, attempt, code: code ?? "" });
  await mailFailure(deps, tenantId, invoiceId, total, code ?? "declined", retryAt(attempt));
  return "failed";
}

/** The tenant's open invoices due a charge: never tried, or past the next retry day. */
export async function collectDue(deps: Deps, tenantId: string, now: number, all = false): Promise<string[]> {
  const rows = await deps.db.query<Row>("select id, issued_at, charge_attempts from invoices where tenant_id = $1 and status = 'open' order by issued_at", [tenantId]);
  const charged: string[] = [];
  for (const r of rows) {
    const n = num(r.charge_attempts);
    const due = all || n === 0 || (n <= RETRY_DAYS.length && now >= num(r.issued_at) + (RETRY_DAYS[n - 1] as number) * DAY_MS);
    if (!due) continue;
    if ((await chargeInvoice(deps, tenantId, r.id as string, now)) !== "skipped") charged.push(r.id as string);
  }
  return charged;
}
