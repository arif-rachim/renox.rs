// App MCP tools (#284; docs/contracts/ops.md section 19). `tool()` checks a
// tool's declaration and returns the `Tool` a `functions/tools/*.ts` (or a
// module's `tools/*.ts`) default-exports. `renox build` imports the module,
// takes `name`, `description`, `action` and `confirm`, and records
// `toolInputSchema(tool.input)` as the route entry's `input`: the JSON
// Schema of the input, restricted to the keywords the platform checks.

import type { Tool, ToolContext, ToolDefinition } from "./ctx.ts";
import type { StandardSchemaV1 } from "./validate.ts";

/** `^[a-z][a-z0-9_]{0,63}$` (artifact.md 1.3, tool routes). */
const NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const ACTION = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;

/** The JSON Schema keywords a tool input may use (validate.ts subset, ops.md section 19). */
export const INPUT_KEYWORDS = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "description",
  "default",
  "anyOf",
  "nullable",
] as const;

const KEEP = new Set<string>(INPUT_KEYWORDS);
/** Values below which a number bound is the integer range zod adds, not the author's. */
const SAFE = Number.MAX_SAFE_INTEGER;

/** A JSON Schema reduced to `INPUT_KEYWORDS`, recursively; bounds at the safe-integer range are dropped. */
function restrict(s: unknown): Record<string, unknown> {
  if (s === null || typeof s !== "object" || Array.isArray(s)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (!KEEP.has(k)) continue;
    if ((k === "minimum" || k === "maximum") && typeof v === "number" && Math.abs(v) >= SAFE) continue;
    if (k === "properties" && v && typeof v === "object") out[k] = Object.fromEntries(Object.entries(v).map(([p, x]) => [p, restrict(x)]));
    else if (k === "items") out[k] = restrict(v);
    else if (k === "anyOf" && Array.isArray(v)) out[k] = v.map(restrict);
    else if (k === "additionalProperties" && typeof v === "object") out[k] = restrict(v);
    else out[k] = v;
  }
  return out;
}

/**
 * The JSON Schema of a Standard Schema input: through the Standard JSON
 * Schema interface (`~standard.jsonSchema.input`, zod 4.2+), else a
 * `toJSONSchema()` method, else the schema itself when it is plain JSON
 * Schema. Throws a TypeError when none applies.
 */
export function toolInputSchema(schema: unknown): Record<string, unknown> {
  const std = (schema as { "~standard"?: { jsonSchema?: { input?: (o: { target: string }) => unknown } } })?.["~standard"];
  let raw: unknown;
  if (typeof std?.jsonSchema?.input === "function") raw = std.jsonSchema.input({ target: "draft-2020-12" });
  else if (typeof (schema as { toJSONSchema?: () => unknown })?.toJSONSchema === "function") raw = (schema as { toJSONSchema: () => unknown }).toJSONSchema();
  else if (schema && typeof schema === "object" && typeof (schema as { type?: unknown }).type === "string" && !std) raw = schema;
  else throw new TypeError("tool: the input schema cannot be described as JSON Schema (use zod 4, or a schema with ~standard.jsonSchema)");
  const out = restrict(raw);
  if (out.type !== "object") throw new TypeError("tool: the input schema must describe an object");
  return out;
}

/**
 * Declares a tool. Checks `name`, `description`, `action` and that the
 * input is a Standard Schema; returns the definition with `confirm`
 * defaulted to false.
 *
 * ```ts
 * export default tool({ name: "create_invoice", description: "...", input: z.object({ ... }), action: "invoice.create", async run(ctx) { ... } });
 * ```
 */
export function tool<S extends StandardSchemaV1>(
  def: Omit<ToolDefinition<StandardSchemaV1.InferOutput<S>>, "input" | "run"> & {
    input: S;
    run(ctx: ToolContext<StandardSchemaV1.InferOutput<S>>): unknown;
  },
): Tool<StandardSchemaV1.InferOutput<S>> {
  if (!NAME.test(def.name)) throw new TypeError(`tool: name must match ^[a-z][a-z0-9_]{0,63}$, got ${JSON.stringify(def.name)}`);
  if (typeof def.description !== "string" || def.description.length === 0 || def.description.length > 200) throw new TypeError("tool: description is 1 to 200 characters");
  if (!ACTION.test(def.action)) throw new TypeError(`tool: action must be <resource>.<verb>, got ${JSON.stringify(def.action)}`);
  if (typeof def.input?.["~standard"]?.validate !== "function") throw new TypeError("tool: input must be a Standard Schema (zod, valibot, arktype, ...)");
  if (typeof def.run !== "function") throw new TypeError("tool: run must be a function");
  if (def.confirm !== undefined && typeof def.confirm !== "boolean") throw new TypeError("tool: confirm is a boolean");
  return { ...def, input: def.input as unknown as Tool<StandardSchemaV1.InferOutput<S>>["input"], confirm: def.confirm ?? false } as Tool<StandardSchemaV1.InferOutput<S>>;
}
