// The signed download shared by `renox db export` and `renox export`
// (docs/contracts/deploy-api.md section 14).

import { createHash } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

import { EnvironmentError } from "../errors.ts";
import type { Io } from "../commands/login.ts";

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/**
 * Downloads `url` (a signed URL: it carries its own authorization, so the API
 * token is not sent), compares the SHA-256 with `sha256`, and writes `dest` as
 * `dest.partial` with mode 0600, then renames it. A mismatch writes nothing and
 * throws an EnvironmentError (exit 3).
 */
export async function downloadVerified(io: Io, url: string, sha256: string, dest: string): Promise<void> {
  let res: Response;
  try {
    res = await io.fetch(url, { method: "GET" });
  } catch (err) {
    throw new EnvironmentError(`cannot download the export: ${(err as Error).message}`);
  }
  if (res.status !== 200) throw new EnvironmentError(`the export download answered ${res.status}`, { hint: "the URL expires after at most 15 minutes; run the command again" });
  const body = new Uint8Array(await res.arrayBuffer());
  const got = sha256Hex(body);
  if (got !== sha256) throw new EnvironmentError(`the downloaded file's SHA-256 ${got} does not match the export's ${sha256}; nothing was written`, { hint: "run the command again" });
  const tmp = `${dest}.partial`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new EnvironmentError(`cannot write ${dest}: ${(err as Error).message}`);
  }
}
