// Quotation arithmetic, in fils (1 AED = 100 fils). Every amount is an integer;
// each line is rounded half up on its own, so the totals are the sums of the lines.

export interface PricedLine {
  qty: number;
  unit_price_fils: number;
  vat_rate: number;
}

export interface LineAmounts {
  /** qty x unit price, VAT not included. */
  net_fils: number;
  vat_fils: number;
  total_fils: number;
}

/** Quantities have at most two decimals (1.5 hours): they are counted in hundredths so the product stays exact. */
const hundredths = (qty: number): number => Math.round(qty * 100);

/** Net, VAT and gross of one line, each rounded half up to a fil. */
export function lineTotal(qty: number, unitFils: number, vatRate: number): LineAmounts {
  const net = Math.floor((hundredths(qty) * unitFils + 50) / 100);
  const vat = Math.floor((net * vatRate + 50) / 100);
  return { net_fils: net, vat_fils: vat, total_fils: net + vat };
}

/** The quotation's totals: the sums of its lines. */
export function totals(lines: readonly PricedLine[]): { subtotal_fils: number; vat_fils: number; total_fils: number } {
  let subtotal = 0;
  let vat = 0;
  for (const l of lines) {
    const a = lineTotal(l.qty, l.unit_price_fils, l.vat_rate);
    subtotal += a.net_fils;
    vat += a.vat_fils;
  }
  return { subtotal_fils: subtotal, vat_fils: vat, total_fils: subtotal + vat };
}

/** "1,234.50" for fils: for text that is not rendered by a template (PDF data is, by `number(2)`). */
export const aed = (fils: number): string => (fils / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
