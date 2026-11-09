// The input schema of an App MCP tool. The SDK's `tool()` takes a Standard
// Schema and `renox build` derives the route's JSON Schema from its
// `~standard.jsonSchema.input()` (sdk/src/tools.ts); the app has no schema
// library, so the schema is written out once and checked by `parse`.
import type { StandardSchemaV1 } from "@renoxium/sdk";

type Issue = { message: string; path: string[] };

/** A string property of a tool's input. */
export const str = (description: string, max: number, min = 1) => ({ type: "string", minLength: min, maxLength: max, description });

/** A Standard Schema for `T`: `parse` returns the value or the issues; `json` is the JSON Schema `renox build` records. */
export function inputOf<T>(json: Record<string, unknown>, parse: (raw: Record<string, unknown>, issues: Issue[]) => T): StandardSchemaV1<unknown, T> & { "~standard": { jsonSchema: { input: () => Record<string, unknown> } } } {
  return {
    "~standard": {
      version: 1,
      vendor: "home-services",
      validate(v: unknown) {
        const issues: Issue[] = [];
        if (typeof v !== "object" || v === null || Array.isArray(v)) return { issues: [{ message: "an object", path: [] }] };
        const value = parse(v as Record<string, unknown>, issues);
        return issues.length > 0 ? { issues } : { value };
      },
      jsonSchema: { input: () => json },
    },
  } as never;
}

/** The trimmed string at `key` (checked against `max`), or undefined and an issue when it is missing or too long. */
export function field(raw: Record<string, unknown>, key: string, max: number, issues: Issue[], optional = false): string | undefined {
  const v = raw[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string" || v.trim() === "" || v.trim().length > max) {
    issues.push({ message: `${key} is ${optional ? "optional, at most" : "required, 1 to"} ${max} characters`, path: [key] });
    return undefined;
  }
  return v.trim();
}
