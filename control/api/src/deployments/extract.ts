// Upload extraction (#95; docs/contracts/deploy-api.md section 4): the request
// body is streamed through the shared tar reader of @renox/artifact-validate,
// which applies T1-T8 as it reads and stops at the first violation. Nothing
// is written to disk; what is held in memory never exceeds the T2 cap, and the
// body is cancelled at the first violation, so a bomb is never read to its end.
// The worker's artifact loader (#55) applies the same caps; see
// packages/artifact-validate/README.md.

import type { Context } from "hono";
import { extractTar, InputTooLarge, TarRejected, UPLOAD_LIMITS, type TarLimits, type Violation } from "@renox/artifact-validate";
import { ApiError, invalid } from "../errors.ts";
import type { Env } from "../context.ts";

const MiB = 1024 * 1024;
/** deploy-api.md section 4: sourcemap tars are at most 50 MiB. */
export const SOURCEMAP_LIMIT = 50 * MiB;
export const SOURCEMAP_LIMITS: TarLimits = { ...UPLOAD_LIMITS, maxInputBytes: SOURCEMAP_LIMIT, maxTotalBytes: SOURCEMAP_LIMIT };

/** True for a gzip body, false for a plain tar; 400 for any other content type. */
export function gzipOf(c: Context<Env>): boolean {
  const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim();
  if (type === "application/x-tar") return false;
  if (type === "application/gzip" || type === "application/x-gzip") return true;
  throw invalid("content-type", "must be application/x-tar or application/gzip");
}

const bodyStream = (c: Context<Env>): ReadableStream<Uint8Array> => c.req.raw.body ?? new ReadableStream({ start: (ctl) => ctl.close() });

/** The extracted files, or the first T rule the body broke. 413 when the body is over `maxInputBytes`. */
export async function extractUpload(c: Context<Env>, limits: TarLimits = UPLOAD_LIMITS): Promise<{ files: Map<string, Uint8Array> } | { violation: Violation }> {
  const gzip = gzipOf(c);
  if (Number(c.req.header("content-length") ?? "0") > limits.maxInputBytes) throw new ApiError("RENOX_BODY_TOO_LARGE");
  try {
    return { files: await extractTar(bodyStream(c), { gzip, limits, now: Date.now }) };
  } catch (e) {
    if (e instanceof InputTooLarge) throw new ApiError("RENOX_BODY_TOO_LARGE");
    if (e instanceof TarRejected) return { violation: e.violation };
    throw e;
  }
}

/** Sourcemap tars: the same rules with the 50 MiB caps; a violation is 422 RENOX_VALIDATION. */
export async function extractSourcemaps(c: Context<Env>): Promise<Map<string, Uint8Array>> {
  const out = await extractUpload(c, SOURCEMAP_LIMITS);
  if ("files" in out) return out.files;
  const v = out.violation;
  throw new ApiError("RENOX_VALIDATION", [{ field: v.path ?? "body", reason: `${v.rule}: ${v.reason}` }], { status: 422 });
}
