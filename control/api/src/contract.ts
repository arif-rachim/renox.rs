// The deploy API contract, loaded from docs/contracts at build time: request
// and message schemas (validated with Ajv, JSON Schema 2020-12) and the state
// machines of deploy-api.md sections 5 and 10. The API never keeps a second
// copy of these rules.

import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject, ValidateFunction } from "ajv";
import spec from "../../../docs/contracts/schemas/deploy-api.yaml";
import controlMessages from "../../../docs/contracts/schemas/control-messages.schema.json";
import meterRecord from "../../../docs/contracts/schemas/meter-record.schema.json";
import { ApiError, type Detail } from "./errors.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Spec = {
  components: { schemas: Record<string, Json> };
  "x-renox-state-machines": Record<string, { initial: string[]; transitions: Record<string, string[]> }>;
};

const SPEC_ID = "https://renox.dev/contracts/deploy-api/v0/deploy-api.yaml";
const files: Record<string, string> = {
  "control-messages.schema.json": controlMessages.$id,
  "meter-record.schema.json": meterRecord.$id,
};

/** Rewrites `$ref: "<file>#..."` to the file's `$id` so Ajv resolves it. */
function absolutize(node: Json): Json {
  if (Array.isArray(node)) return node.map(absolutize);
  if (node === null || typeof node !== "object") return node;
  const out: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string" && !v.startsWith("#")) {
      const hash = v.indexOf("#");
      const file = hash === -1 ? v : v.slice(0, hash);
      const id = files[file];
      if (id === undefined) throw new Error(`unknown schema file in $ref: ${v}`);
      out[k] = hash === -1 ? id : `${id}${v.slice(hash)}`;
    } else out[k] = absolutize(v);
  }
  return out;
}

const api = spec as Spec;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(controlMessages as object);
ajv.addSchema(meterRecord as object);
ajv.addSchema({ $id: SPEC_ID, components: absolutize(api.components as unknown as Json) } as object);

const cache = new Map<string, ValidateFunction>();
function compiled(ref: string): ValidateFunction {
  let fn = cache.get(ref);
  if (fn === undefined) {
    const found = ajv.getSchema(ref);
    if (found === undefined) throw new Error(`no schema ${ref}`);
    fn = found;
    cache.set(ref, fn);
  }
  return fn;
}

const toDetails = (errors: ErrorObject[] | null | undefined): Detail[] =>
  (errors ?? []).slice(0, 20).map((e) => {
    const extra =
      e.keyword === "additionalProperties"
        ? `/${(e.params as { additionalProperty: string }).additionalProperty}`
        : e.keyword === "required"
          ? `/${(e.params as { missingProperty: string }).missingProperty}`
          : "";
    return { field: `${e.instancePath}${extra}`.replace(/^\//u, "").replaceAll("/", ".") || "body", reason: e.message ?? e.keyword };
  });

/** Validates `value` against `components.schemas.<name>`; throws 400 RENOX_VALIDATION. */
export function check<T>(name: string, value: unknown): T {
  const fn = compiled(`${SPEC_ID}#/components/schemas/${name}`);
  if (!fn(value)) throw new ApiError("RENOX_VALIDATION", toDetails(fn.errors));
  return value as T;
}

/** Validates a control message against `control-messages.schema.json#/$defs/<def>`. */
export function checkMessage<T>(def: string, value: unknown): T {
  const fn = compiled(`${controlMessages.$id}#/$defs/${def}`);
  if (!fn(value)) throw new ApiError("RENOX_VALIDATION", toDetails(fn.errors));
  return value as T;
}

/** Validates a meter batch envelope (meter-record.schema.json). */
export function checkMeterBatch<T>(value: unknown): T {
  const fn = compiled(meterRecord.$id);
  if (!fn(value)) throw new ApiError("RENOX_VALIDATION", toDetails(fn.errors));
  return value as T;
}

export type Machine = "deployment" | "domain";

/** True when deploy-api.md allows `from -> to` in `machine`. */
export function canTransition(machine: Machine, from: string, to: string): boolean {
  return api["x-renox-state-machines"][machine]?.transitions[from]?.includes(to) ?? false;
}

/** Throws 409 RENOX_CONFLICT unless `from -> to` is allowed. */
export function assertTransition(machine: Machine, from: string, to: string): void {
  if (!canTransition(machine, from, to)) {
    throw new ApiError("RENOX_CONFLICT", [{ field: "state", reason: `${from} -> ${to} is not allowed` }]);
  }
}

export const stateMachines = api["x-renox-state-machines"];
