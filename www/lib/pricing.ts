// The plans of pricing.toml (#326): the pricing page's source, which the
// billing plans equal (tests/pages.test.ts). A reader for this file's own
// shape (strings, integers, `[[plan]]` tables), not a general TOML parser.
import source from "../pricing.toml" with { type: "text" };

export interface PricedPlan {
  id: string;
  name: string;
  price_month: string;
  quotas: Record<string, number | null>;
}

export function parsePricing(text: string): { currency: string; vat_rate: string; plans: PricedPlan[] } {
  const top: Record<string, string> = {};
  const plans: PricedPlan[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/u, "").trim();
    if (line === "") continue;
    if (line === "[[plan]]") {
      plans.push({ id: "", name: "", price_month: "", quotas: {} });
      continue;
    }
    const m = /^([a-z_]+)\s*=\s*(?:"([^"]*)"|(-?\d+))$/u.exec(line);
    if (m === null) throw new Error(`pricing.toml: cannot read ${JSON.stringify(raw)}`);
    const [key, str, int] = [m[1] as string, m[2], m[3]];
    const plan = plans.at(-1);
    if (plan === undefined) top[key] = str ?? (int as string);
    else if (key === "id" || key === "name" || key === "price_month") plan[key] = str ?? "";
    else plan.quotas[key] = Number(int) === -1 ? null : Number(int);
  }
  return { currency: top.currency ?? "", vat_rate: top.vat_rate ?? "", plans };
}

export const PRICING = parsePricing(source);

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** A quota for the page: unlimited, a byte size, or a count. */
export function quotaText(key: string, v: number | null): string {
  if (v === null) return "unlimited";
  if (key.endsWith("_bytes")) return v >= GiB ? `${v / GiB} GB` : `${v / MiB} MB`;
  if (key === "cpu_ms") return `${(v / 3_600_000).toLocaleString("en")} CPU-hours`;
  return v.toLocaleString("en");
}

/** VAT-inclusive monthly price, as AED with two decimals. */
export function withVat(aed: string, rate: string): string {
  const fils = Math.round(Number(aed) * 100);
  return (Math.floor((fils * Math.round(Number(rate) * 10_000) * 2 + 10_000) / 20_000) / 100 + fils / 100).toFixed(2);
}
