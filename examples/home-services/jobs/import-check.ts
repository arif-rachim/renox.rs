// The check of an uploaded spreadsheet (#733): POST /admin/import ?/check makes the
// `app__imports` row `checking` and enqueues this job with `{ import_id }`; the job
// reads the stored file (`reports.readXlsx`), parses and plans it (lib/import.ts, the
// validation rules are the same as ever) and keeps the report, the counts and
// `checked` (or `failed`). The page at /admin/import/<id> refreshes until then.
//
// Safe to run twice: a row that is not `checking` is left alone.
//
// The failure protocol, on the pinned worker (0.8.0). A module service that throws ends
// the attempt's transaction (there are no savepoints around a service call until #734 is
// in a worker release), so after `reports.readXlsx` throws nothing more can be written in
// that attempt, and the job's transaction begins before `run`: there is no "outside" to
// write from. So the failure is written by the next attempt (the retry, 10 s later):
//   - before the service: the cheap checks of the file (over 10 MiB, no zip signature)
//     write `failed` at once (lib/import.ts cheapFileError), with no service call;
//   - when `readXlsx` throws, the job catches the error, writes a marker with its code to
//     storage (`app/imports/<id>.error`, text/plain; the object store is outside the
//     SQLite transaction, so the marker survives the rollback) and rethrows, so the
//     attempt ends and is retried;
//   - an attempt after the first, for a row still `checking`: with the marker, it writes
//     `failed` with its code (`not_xlsx`, `too_many_rows`) and deletes the marker; with
//     none, the previous attempt was stopped before it could catch (the CPU or wall limit
//     of the attempt: a file that is too large to read in it, `import.err.too_large`).
//     It never calls the service again.
// Once a worker with savepoints around service calls (#734) is pinned, the catch can write
// `failed` in the same attempt, and the marker and the retry go.
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
