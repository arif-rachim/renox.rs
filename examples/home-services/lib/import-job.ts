// The part the two import jobs share (jobs/import-check.ts, jobs/import-commit.ts):
// reading the stored file of an import inside a job attempt, and what happens when
// that fails. The protocol is explained in jobs/import-check.ts.
import type { JobContext } from "@renoxium/sdk";

import { type Cell, cheapFileError, failImport, type ImportRow, readCells, readErrorCode } from "./import";

export interface ImportPayload {
  import_id?: unknown;
  /** The user who asked for the commit (the audit row's actor). */
  by?: unknown;
}

/**
 * The cells of the import's stored file, or null when the import has been ended as `failed` (the caller
 * stops: there is nothing more to do). It does not throw: a thrown `reports.readXlsx` is caught and written.
 */
export async function readForJob(ctx: JobContext<ImportPayload>, row: ImportRow, from: "checking" | "committing"): Promise<Cell[][] | null> {
  if (ctx.job.attempt > 1) {
    // The previous attempt ended without finishing, and nothing in here throws: it was stopped (the CPU or wall
    // limit of the attempt), so the file is too large to read in one. The service is never called again.
    await failImport(ctx.db, row.id, from, "too_large");
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
    // A module service call runs in a savepoint (#734, ops.md 1.17.0, renox-worker 0.9.0): its throw undid only
    // the call, and the attempt's transaction goes on, so the failure is written now and the job ends normally.
    await failImport(ctx.db, row.id, from, readErrorCode(e));
    return null;
  }
}
