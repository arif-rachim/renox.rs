// Compile-time test: validate() returns the schema's output type, for zod
// and valibot alike (Standard Schema `types.output`).
import * as v from "valibot";
import { z } from "zod";

import { type ActionContext, type StandardSchemaV1, validate } from "../src/index.ts";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const Zod = z.object({ qty: z.coerce.number(), note: z.string().optional() });
const Valibot = v.object({ qty: v.pipe(v.string(), v.transform(Number)) });

export async function inferred(req: Request, ctx: ActionContext): Promise<void> {
  const a = await validate(req, Zod);
  const b = await validate(ctx.form, Valibot);
  type _A = Expect<Equal<typeof a, { qty: number; note?: string | undefined }>>;
  type _B = Expect<Equal<typeof b, { qty: number }>>;
  // Both libraries are Standard Schemas.
  const schemas: StandardSchemaV1[] = [Zod, Valibot];
  void schemas;
  // @ts-expect-error a plain object is not a schema
  await validate(req, { parse: () => 1 });
}
