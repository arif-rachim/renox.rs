// Official package (zod). Parses a nested object and rejects an invalid one.
import { z } from "zod";
import { assert, assertEqual } from "./_lib/assert.ts";

const Order = z.object({
  id: z.string().min(1),
  customer: z.object({ name: z.string(), phone: z.string().regex(/^\+971\d{8,9}$/) }),
  items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive(), price: z.number() })).min(1),
});

export async function check(): Promise<void> {
  const parsed = Order.parse({
    id: "o-1",
    customer: { name: "Fatima", phone: "+971500000001" },
    items: [{ sku: "A", qty: 2, price: 10.5 }],
  });
  assertEqual(parsed.items[0]?.qty, 2, "parsed qty");
  const bad = Order.safeParse({ id: "", customer: { name: "x", phone: "123" }, items: [] });
  assert(!bad.success && bad.error.issues.length >= 3, "invalid order reports every issue");
}
