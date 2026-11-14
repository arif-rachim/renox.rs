// GET /admin/import/<id>: the report of a checked file: the totals, the first 200
// errors (row, column, message) and, for a file with no errors, the button that
// writes it. While the file is `checking` or `committing` (a background job,
// jobs/import-check.ts and jobs/import-commit.ts) the page says so and reloads
// itself every 3 seconds; a `failed` import shows its reason. POST ?/commit
// (`settings.write`, sensitive: the owner with a recent second factor; refused
// with 409 unless the import is checked and has no errors) sets `committing` and
// enqueues the job, which writes the whole file in one transaction and audits it
// as `import.committed`. POST ?/discard drops a checked import without writing.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { sensitive } from "../../../lib/admin";
import { findImport, reportOf, startCommit } from "../../../lib/import";
import { shell } from "../../../lib/page";

export const guard = { action: "settings.write" };

const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });
const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const notFound = (): Response => plain(404, "Import not found");

/** Where the written rows can be found, by kind. */
const WHERE: Record<string, string> = { customers: "/customers", sites: "/customers", services: "/services", contracts: "/contracts", parts: "/admin/parts", stock: "/admin/stock" };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const row = await findImport(ctx.db, ctx.params.id);
  if (row === null) return notFound();
  const report = reportOf(row);
  return {
    ...page,
    imp: { id: row.id, kind: row.kind, file_name: row.file_name, status: row.status, rows: row.rows, errors: row.errors, insert: report.insert, update: report.update, exists: report.exists, to_write: row.ok, error: row.error },
    // The layout (pages/_layouts/back-office.html) adds <meta http-equiv="refresh"> to the head for this many seconds.
    refresh: row.status === "checking" || row.status === "committing" ? 3 : null,
    working: row.status === "checking" || row.status === "committing",
    failed: row.status === "failed",
    has_report: row.status !== "checking" && !(row.status === "failed" && row.checked_at === null),
    error_rows: report.errors,
    truncated: row.errors > report.errors.length,
    can_commit: row.status === "checked" && row.errors === 0,
    where: WHERE[row.kind] ?? "/customers",
  };
}

export const actions = {
  async commit(ctx: ActionContext) {
    const refused = await sensitive(ctx, "settings.write", `/admin/import/${ctx.params.id}`);
    if (refused !== null) return refused;
    const row = await findImport(ctx.db, ctx.params.id);
    if (row === null) return notFound();
    if (row.status !== "checked") return plain(409, `This import is ${row.status}: check the file again.`);
    if (row.errors > 0) return plain(409, "This file has errors: fix it and check it again.");
    if (!(await startCommit(ctx.db, row.id))) return plain(409, "This import is not ready to be imported: check the file again.");
    await ctx.jobs.enqueue("import-commit", { import_id: row.id, by: ctx.principal?.id ?? row.created_by ?? "unknown" });
    return redirect(`/admin/import/${row.id}`);
  },

  async discard(ctx: ActionContext) {
    const row = await findImport(ctx.db, ctx.params.id);
    if (row === null) return notFound();
    if (row.status !== "checked") return plain(409, `This import is ${row.status}.`);
    await ctx.db.execute("update app__imports set status = 'discarded' where id = ?", [row.id]);
    return redirect("/admin/import");
  },
};
