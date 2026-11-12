// The commit of a checked spreadsheet (#733): POST /admin/import/<id> ?/commit (second
// factor, a checked file with no errors) makes the row `committing` and enqueues this
// job with `{ import_id, by }`. The job re-reads the file, plans it again against the
// data as it is now and writes the whole file in this attempt's one transaction
// (lib/import.ts commitChecked), then `committed` and the `import.committed` audit row.
// A file whose data changed since the check is ended as `failed` (`data_changed`), and
// nothing of it is written.
//
// Safe to run twice: only a `committing` row is worked.
//
// The failure protocol is the one of jobs/import-check.ts (read it there; #734, savepoints
// around service calls, lets the catch write in the same attempt once a worker has them):
// the cheap checks fail the row at once; a thrown `readXlsx` leaves a marker in storage and
// the retry ends the row as `failed` with its code; a retry with no marker means the first
// attempt was stopped by the CPU or wall limit, so the row ends as `failed` with
// `too_large`, keeping the report of its check. Nothing of the file was written: the
// stopped attempt's transaction rolled back, and the one transaction per file stays.
//
// Every job route has a schedule (artifact V27); this one is a queue: its runs come from
// the action's enqueue, and the yearly tick (no payload) does nothing.
import type { JobContext } from "@renoxium/sdk";

import { checkCells, commitChecked, failImport, findImport, importId } from "../lib/import";
import { type ImportPayload, readForJob } from "../lib/import-job";

export const schedule = "0 4 1 1 *";

export async function run(ctx: JobContext<ImportPayload>): Promise<void> {
  const id = importId(ctx.job.payload?.import_id);
  if (id === null) return;
  const row = await findImport(ctx.db, id);
  if (row === null || row.status !== "committing") return;
  const cells = await readForJob(ctx, row, "committing");
  if (cells === null) return;
  const by = typeof ctx.job.payload?.by === "string" && ctx.job.payload.by !== "" ? ctx.job.payload.by : (row.created_by ?? "unknown");
  // Contracts are written as the user who asked, in the branch of each customer (lib/import.ts writeContracts).
  const principal = ctx.principal === null ? null : { ...ctx.principal, id: by };
  const work = { db: ctx.db, principal };
  const done = await commitChecked(work, row, await checkCells(work, row.kind, cells), by);
  if (!done.ok) await failImport(ctx.db, id, "committing", done.code);
}
