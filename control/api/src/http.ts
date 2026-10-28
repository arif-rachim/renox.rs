// Request helpers shared by every route module.

import type { Context } from "hono";
import { ApiError, invalid } from "./errors.ts";
import { check } from "./contract.ts";
import type { Env } from "./context.ts";

/** deploy-api.md section 1: JSON bodies are at most 1 MiB. */
export const JSON_LIMIT = 1024 * 1024;

/** Reads a body of at most `limit` bytes, stopping as soon as it is exceeded. */
export async function readBody(c: Context<Env>, limit: number): Promise<Uint8Array> {
  const declared = Number(c.req.header("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > limit) throw new ApiError("RENOX_BODY_TOO_LARGE");
  const body = c.req.raw.body;
  if (body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > limit) throw new ApiError("RENOX_BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Parses a JSON body and validates it against `components.schemas.<schema>`. */
export async function jsonBody<T>(c: Context<Env>, schema: string, optional = false): Promise<T> {
  const type = c.req.header("content-type") ?? "";
  const bytes = await readBody(c, JSON_LIMIT);
  if (bytes.length === 0 && optional) return check<T>(schema, {});
  if (!/^application\/json(;|$)/u.test(type)) throw invalid("content-type", "must be application/json");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("body", "not valid UTF-8 JSON");
  }
  return check<T>(schema, value);
}

/** Validates a path parameter against a component schema (404 when it cannot exist). */
export function pathParam(c: Context<Env>, name: string, schema: string): string {
  const value = c.req.param(name);
  try {
    return check<string>(schema, value);
  } catch {
    throw new ApiError("RENOX_NOT_FOUND");
  }
}
