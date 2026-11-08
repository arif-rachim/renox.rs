// Input schemas for the invoice forms (same shape as lib/forms.ts): an issue's
// message is an i18n key (`invoices.err.<field>`), its path names the field.
import { filsOf, schema, text } from "./forms";

export const METHODS = ["cash", "transfer", "cheque"] as const;
export type Method = (typeof METHODS)[number];

export interface PaymentInput {
  method: Method;
  amount_fils: number;
  /** Unix seconds of the start of the day the money was received (Dubai); the form's date, today when blank. */
  received_on: string;
  reference: string;
  cheque_number: string | null;
  cheque_date: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const validDate = (s: string): boolean => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** `today` is the Dubai day (`YYYY-MM-DD`) a blank date means. */
export const paymentSchema = (today: string) =>
  schema<PaymentInput>(async (raw) => {
    const errors: Record<string, string> = {};
    const method = text(raw, "method", 10);
    const amount = text(raw, "amount", 12);
    const received = text(raw, "received_on", 10) || today;
    const reference = text(raw, "reference", 120);
    const chequeNumber = text(raw, "cheque_number", 40);
    const chequeDate = text(raw, "cheque_date", 10);
    if (!(METHODS as readonly string[]).includes(method)) errors.method = "invoices.err.method";
    const fils = filsOf(amount);
    if (fils === null || fils < 1) errors.amount = "invoices.err.amount";
    if (!validDate(received)) errors.received_on = "invoices.err.date";
    if (reference.length > 120) errors.reference = "invoices.err.reference";
    if (method === "cheque") {
      if (chequeNumber === "" || chequeNumber.length > 40) errors.cheque_number = "invoices.err.cheque_number";
      if (!validDate(chequeDate)) errors.cheque_date = "invoices.err.date";
    }
    if (Object.keys(errors).length > 0) return { errors };
    const cheque = method === "cheque";
    return { value: { method: method as Method, amount_fils: fils as number, received_on: received, reference, cheque_number: cheque ? chequeNumber : null, cheque_date: cheque ? chequeDate : null } };
  });

/** The credit note's reason (the tax_gcc module wants at least three characters). */
export const creditSchema = schema<{ reason: string }>(async (raw) => {
  const reason = text(raw, "reason", 200);
  return reason.length < 3 || reason.length > 200 ? { errors: { reason: "invoices.err.reason" } } : { value: { reason } };
});
