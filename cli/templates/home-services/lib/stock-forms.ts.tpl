// The three forms of /admin/stock (#813): receive, adjust (the counted quantity) and transfer. The error values are
// i18n keys (`stock.err.*`), the paths are the form's field names. Whether a part exists, whether the branches are
// ones the user holds and whether the balance allows the move are checked by the action and lib/stock.ts, not here.
import { schema, text } from "./forms";
import { filsOf, isPartId, quantityOf } from "./parts";

export type ReceiveInput = { part: string; qty: number; unit_cost_fils: number; reason: string };
export type AdjustInput = { part: string; counted: number; reason: string };
export type TransferInput = { part: string; qty: number; to_branch: string; reason: string };

const REASON_MIN = 3;
const REASON_MAX = 200;
const reasonOf = (raw: Record<string, unknown>): string => text(raw, "reason", REASON_MAX);
const reasonOk = (reason: string): boolean => reason.length >= REASON_MIN && reason.length <= REASON_MAX;
const partOk = (part: string): boolean => isPartId(part);
/** More than zero. */
const positive = (raw: string): number | null => {
  const n = quantityOf(raw);
  return n !== null && n > 0 ? n : null;
};

export const receiveSchema = schema<ReceiveInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const part = text(raw, "part", 40);
  const qty = positive(text(raw, "qty", 12));
  const cost = filsOf(text(raw, "unit_cost", 12));
  const reason = reasonOf(raw);
  if (!partOk(part)) errors.part = "stock.err.part";
  if (qty === null) errors.qty = "stock.err.qty";
  if (cost === null) errors.unit_cost = "stock.err.unit_cost";
  if (!reasonOk(reason)) errors.reason = "stock.err.reason";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { part, qty: qty as number, unit_cost_fils: cost as number, reason } };
});

export const adjustSchema = schema<AdjustInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const part = text(raw, "part", 40);
  // Zero is a count (the shelf is empty); a negative or a text is not.
  const counted = quantityOf(text(raw, "counted", 12));
  const reason = reasonOf(raw);
  if (!partOk(part)) errors.part = "stock.err.part";
  if (counted === null) errors.counted = "stock.err.counted";
  if (!reasonOk(reason)) errors.reason = "stock.err.reason";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { part, counted: counted as number, reason } };
});

export const transferSchema = schema<TransferInput>(async (raw) => {
  const errors: Record<string, string> = {};
  const part = text(raw, "part", 40);
  const qty = positive(text(raw, "qty", 12));
  const to = text(raw, "to_branch", 64);
  const reason = reasonOf(raw);
  if (!partOk(part)) errors.part = "stock.err.part";
  if (qty === null) errors.qty = "stock.err.qty";
  if (!/^[a-z0-9_]{1,64}$/u.test(to)) errors.to_branch = "stock.err.to_branch";
  if (!reasonOk(reason)) errors.reason = "stock.err.reason";
  if (Object.keys(errors).length > 0) return { errors };
  return { value: { part, qty: qty as number, to_branch: to, reason } };
});
