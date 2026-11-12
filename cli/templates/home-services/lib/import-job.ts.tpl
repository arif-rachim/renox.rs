// The part the two import jobs share (jobs/import-check.ts, jobs/import-commit.ts):
// reading the stored file of an import inside a job attempt, and what happens when
// that fails. The protocol is explained in jobs/import-check.ts.
import type { JobContext } from "@renoxium/sdk";

import { type Cell, cheapFileError, failImport, type FileErrorCode, type ImportRow, readCells, readErrorCode } from "./import";

export interface ImportPayload {
  import_id?: unknown;
  /** The user who asked for the commit (the audit row's actor). */
  by?: unknown;
}

/** The marker an attempt leaves for the next one when `reports.readXlsx` threw: the file-level code, as text. */
export const markerKey = (id: string): string => `app/imports/${id}.error`;

const isCode = (v: string): v is FileErrorCode => v === "not_xlsx" || v === "too_many_rows";

/**
 * The cells of the import's stored file, or null when the import has been ended as `failed` (the caller
 * stops: there is nothing more to do). Throws, on purpose, only after a marker was written.
 */
export async function readForJob(ctx: JobContext<ImportPayload>, row: ImportRow, from: "checking" | "committing"): Promise<Cell[][] | null> {
  const marker = markerKey(row.id);
  if (ctx.job.attempt > 1) {
    // The previous attempt ended without finishing. With a marker it caught the read's error; without one it was
    // stopped before it could (the CPU or wall limit of the attempt). The service is never called again.
    let code: string | null = null;
    try {
      code = new TextDecoder().decode(await ctx.storage.read(marker)).trim();
      await ctx.storage.delete(marker);
    } catch {
      // No marker.
    }
    await failImport(ctx.db, row.id, from, code !== null && isCode(code) ? code : "too_large");
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await ctx.storage.read(row.file_key);
  } catch {
    await failImport(ctx.db, row.id, from, "no_file");
    return null;
  }
  const cheap = cheapFileError(bytes);
  if (cheap !== null) {
    await failImport(ctx.db, row.id, from, cheap);
    return null;
  }
  try {
    return await readCells(bytes);
  } catch (e) {
    const code = readErrorCode(e);
    // Catch, then write. On a worker with savepoints around service calls (#734, ops.md 1.17.0) only the call was
    // undone and the attempt's transaction goes on, so the failure is written now and the job ends normally.
    try {
      await failImport(ctx.db, row.id, from, code);
      return null;
    } catch {
      // The pinned worker (0.8.0): the failed call ended the attempt's transaction (RENOX_DB_TX_STATE).
    }
    // Then the object store, which is outside the transaction, keeps the code for the next attempt.
    await ctx.storage.put(marker, new TextEncoder().encode(code), { contentType: "text/plain" });
    throw e;
  }
}
