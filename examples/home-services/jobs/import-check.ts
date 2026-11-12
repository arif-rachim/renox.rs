// The check of an uploaded spreadsheet (#733): POST /admin/import ?/check makes the
// `app__imports` row `checking` and enqueues this job with `{ import_id }`; the job
// reads the stored file (`reports.readXlsx`), parses and plans it (lib/import.ts, the
// validation rules are the same as ever) and keeps the report, the counts and
// `checked` (or `failed`). The page at /admin/import/<id> refreshes until then.
//
// Safe to run twice: a row that is not `checking` is left alone.
//
// The failure protocol (lib/import-job.ts readForJob). A module service call runs in a
// savepoint (#734, ops.md 1.17.0, renox-worker 0.9.0), so a throw undoes only the call
// and the attempt's transaction goes on:
//   - before the service: the cheap checks of the file (over 10 MiB, no zip signature)
//     write `failed` at once (lib/import.ts cheapFileError), with no service call;
//   - when `readXlsx` throws, the job catches the error and writes `failed` with its code
//     (`not_xlsx`, `too_many_rows`) in the same attempt, and ends normally;
//   - an attempt after the first, for a row still `checking`: nothing in the read throws,
//     so the previous attempt was stopped (the CPU or wall limit of the attempt: a file
//     that is too large to read in it, `import.err.too_large`). It never calls the
//     service again.
//
// Every job route has a schedule (artifact V27); this one is a queue: its runs come from
// the action's enqueue, and the yearly tick (no payload) does nothing.
import type { JobContext } from "@renoxium/sdk";

import { checkCells, failImport, finishCheck, findImport, importId } from "../lib/import";
import { type ImportPayload, readForJob } from "../lib/import-job";

export const schedule = "0 4 1 1 *";

export async function run(ctx: JobContext<ImportPayload>): Promise<void> {
  const id = importId(ctx.job.payload?.import_id);
  if (id === null) return;
  const row = await findImport(ctx.db, id);
  if (row === null || row.status !== "checking") return;
  const cells = await readForJob(ctx, row, "checking");
  if (cells === null) return;
  try {
    await finishCheck(ctx.db, id, await checkCells(ctx, row.kind, cells));
  } catch (e) {
    // A database failure here leaves the transaction usable, but not the work: end the import rather than retry for ever.
    await failImport(ctx.db, id, "checking", "check_failed");
    console.error("import-check", id, e instanceof Error ? e.message : String(e));
  }
}
