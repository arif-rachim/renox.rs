// #284: `tool()` (docs/contracts/ops.md section 19): the declaration is
// checked, `confirm` defaults to false, and `toolInputSchema` gives the JSON
// Schema `renox build` records, restricted to the platform's keywords.

import { expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";

import { INPUT_KEYWORDS, type Tool, tool, toolInputSchema } from "../src/index.ts";

const input = z.object({ customerId: z.string().min(1), qty: z.number().int().positive(), note: z.string().max(200).optional() });

test("tool() checks the declaration and defaults confirm", () => {
  const t = tool({ name: "create_invoice", description: "Create a draft invoice", input, action: "invoice.create", async run(ctx) {
    expectTypeOf(ctx.tool.input).toEqualTypeOf<{ customerId: string; qty: number; note?: string | undefined }>();
    return { id: "inv_1", customer: ctx.tool.input.customerId };
  } });
  expect(t.confirm).toBe(false);
  expect(t.name).toBe("create_invoice");
  expectTypeOf(t).toMatchTypeOf<Tool<{ customerId: string; qty: number; note?: string | undefined }>>();
  const base = { description: "x", input, action: "invoice.create", run: () => null };
  expect(() => tool({ ...base, name: "Create" })).toThrow(/name must match/u);
  expect(() => tool({ ...base, name: "ok", action: "invoice" })).toThrow(/<resource>.<verb>/u);
  expect(() => tool({ ...base, name: "ok", description: "" })).toThrow(/description/u);
  expect(() => tool({ ...base, name: "ok", input: {} as typeof input })).toThrow(/Standard Schema/u);
  expect(tool({ ...base, name: "ok", confirm: true }).confirm).toBe(true);
});

test("toolInputSchema: zod's JSON Schema reduced to the platform's keywords", () => {
  const s = toolInputSchema(input);
  expect(s).toEqual({
    type: "object",
    properties: {
      customerId: { type: "string", minLength: 1 },
      qty: { type: "integer", exclusiveMinimum: 0 },
      note: { type: "string", maxLength: 200 },
    },
    required: ["customerId", "qty"],
  });
  const keys = (o: unknown): string[] =>
    o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o).flatMap(([k, v]) => (k === "properties" ? Object.values(v as object).flatMap(keys) : [k, ...keys(v)])) : [];
  expect(keys(s).every((k) => (INPUT_KEYWORDS as readonly string[]).includes(k))).toBe(true);
  expect(() => toolInputSchema(z.string())).toThrow(/must describe an object/u);
  expect(() => toolInputSchema({ "~standard": { version: 1, vendor: "x", validate: () => ({ value: 1 }) } })).toThrow(/cannot be described/u);
});
