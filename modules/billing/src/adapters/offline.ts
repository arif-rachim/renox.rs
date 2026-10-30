// Payment methods without a card PSP (#330): cash on delivery and bank
// transfer. Nothing leaves the app: the "session" is the app's own
// confirmation page, and the money is confirmed later (the courier for COD,
// the bank statement for a transfer).

/** The cash-on-delivery order states and their moves. `delivered` is paid; `refused` ends it unpaid. */
export const COD_MOVES: Record<string, string[]> = {
  placed: ["out_for_delivery", "refused"],
  out_for_delivery: ["delivered", "refused"],
  delivered: [],
  refused: [],
};

/**
 * A transfer reference the customer quotes: `RNX-` and 8 characters of a
 * Crockford alphabet (no I, L, O, U), so it survives being typed into a
 * banking app and read back off a statement.
 */
export function transferReference(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `RNX-${Array.from(b, (x) => alphabet[x % 32]).join("")}`;
}

export interface StatementRow {
  booked_on: string;
  /** Minor units (fils). */
  amount: number;
  description: string;
}

/**
 * A bank statement as CSV: a header row naming `date`, `amount` and
 * `description` (any order, other columns ignored), amounts as decimals
 * (`125.00`, `1,250.50`). Rows that do not parse are answered as problems,
 * never guessed.
 */
export function parseStatement(csv: string): { rows: StatementRow[]; problems: string[] } {
  const lines = csv.replace(/\r\n?/gu, "\n").split("\n").filter((l) => l.trim() !== "");
  const split = (l: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i] as string;
      if (ch === '"') {
        if (quoted && l[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const head = split(lines[0] ?? "").map((h) => h.toLowerCase());
  const [d, a, s] = ["date", "amount", "description"].map((k) => head.indexOf(k));
  if (d === -1 || a === -1 || s === -1) return { rows: [], problems: ["the first row must name the columns date, amount and description"] };
  const rows: StatementRow[] = [];
  const problems: string[] = [];
  for (const [n, l] of lines.slice(1).entries()) {
    const c = split(l);
    const amount = (c[a as number] ?? "").replace(/,/gu, "");
    if (!/^\d+(\.\d{1,2})?$/u.test(amount)) {
      problems.push(`row ${n + 2}: amount ${JSON.stringify(c[a as number] ?? "")} is not a positive decimal`);
      continue;
    }
    const [whole, frac = ""] = amount.split(".");
    rows.push({ booked_on: c[d as number] ?? "", amount: Number(whole) * 100 + Number(frac.padEnd(2, "0")), description: (c[s as number] ?? "").slice(0, 500) });
  }
  return { rows, problems };
}
