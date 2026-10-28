// `validate(input, Schema)`: input validation before the handler body
// (docs/04-isolation-security.md, "Input validation"). Any schema library
// that implements Standard Schema v1 (https://standardschema.dev) works:
// zod (3.24+), valibot (1.0+), arktype, effect. The SDK depends on none of
// them: the interface below is the spec's, copied as the spec recommends.

/** The Standard Schema v1 interface (`@standard-schema/spec` 1.0.0). */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  export interface PathSegment {
    readonly key: PropertyKey;
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["input"];
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["output"];
}

/** One validation failure: the schema's message and the path to the value, `[]` for the root. */
export interface ValidationIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

/**
 * Thrown by `validate()` when the input does not match the schema, or when a
 * `Request` body cannot be read as JSON or a form. Not a `RenoxError`: no
 * platform code, it is the tenant's own 400. `toResponse()` builds one.
 */
export class ValidationError extends Error {
  override readonly name = "ValidationError";
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const first = issues[0];
    super(
      first
        ? `validation failed: ${first.path.length ? `${first.path.join(".")}: ` : ""}${first.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`
        : "validation failed",
    );
    this.issues = Object.freeze([...issues]);
  }

  /** `400` with `{ "issues": [{ "message", "path" }] }`. */
  toResponse(init?: ResponseInit): Response {
    return Response.json({ issues: this.issues }, { status: 400, ...init });
  }
}

/** What `validate()` reads: a request body, a parsed form, query parameters, or a plain value. */
export type ValidateInput = Request | FormData | URLSearchParams | unknown;

/**
 * A form or query string as an object: a key seen once maps to its value
 * (`string`, or `File` for an upload), a repeated key to the array of its
 * values in order.
 */
export function formToObject(form: FormData | URLSearchParams): Record<string, FormDataEntryValue | FormDataEntryValue[]> {
  const out: Record<string, FormDataEntryValue | FormDataEntryValue[]> = Object.create(null);
  for (const [key, value] of form as Iterable<[string, FormDataEntryValue]>) {
    const prev = out[key];
    if (prev === undefined) out[key] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else out[key] = [prev, value];
  }
  return out;
}

const fail = (message: string): ValidationError => new ValidationError([{ message, path: [] }]);

/** The value a `Request` body stands for: JSON, or a form as `formToObject` builds it. */
async function readBody(req: Request): Promise<unknown> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "application/json" || type.endsWith("+json")) {
    const text = await req.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw fail("request body is not valid JSON");
    }
  }
  if (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw fail("request body is not a valid form");
    }
    return formToObject(form);
  }
  throw fail(`unsupported content type ${type ? JSON.stringify(type) : "(none)"}: expected JSON or a form`);
}

function pathOf(path: StandardSchemaV1.Issue["path"]): (string | number)[] {
  return (path ?? []).map((seg) => {
    const key = typeof seg === "object" && seg !== null ? seg.key : seg;
    return typeof key === "number" ? key : String(key);
  });
}

/**
 * Validates `input` against a Standard Schema and returns the schema's
 * output (with its transforms and defaults applied).
 *
 * - `Request`: the body, read once as JSON (`application/json`, `+json`) or
 *   as a form (urlencoded, multipart); any other content type fails.
 * - `FormData`, `URLSearchParams` (`ctx.form` in an action,
 *   `ctx.url.searchParams`): converted with `formToObject`.
 * - Anything else is validated as is.
 *
 * Throws `ValidationError` on failure.
 *
 * ```ts
 * const order = await validate(req, OrderSchema);          // POST handler
 * const input = await validate(form, AddToCartSchema);     // action
 * ```
 */
export async function validate<S extends StandardSchemaV1>(
  input: ValidateInput,
  schema: S,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const std = (schema as Partial<StandardSchemaV1> | null)?.["~standard"];
  if (!std || std.version !== 1 || typeof std.validate !== "function")
    throw new TypeError("validate(): the schema does not implement Standard Schema v1 (zod 3.24+, valibot 1.0+)");
  let value: unknown = input;
  if (input instanceof Request) value = await readBody(input);
  else if (input instanceof FormData || input instanceof URLSearchParams) value = formToObject(input);
  const result = await std.validate(value);
  if (result.issues) throw new ValidationError(result.issues.map((i) => ({ message: i.message, path: pathOf(i.path) })));
  return result.value as StandardSchemaV1.InferOutput<S>;
}
