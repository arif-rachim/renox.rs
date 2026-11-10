// GET /admin/import/<id>: the report of a checked file: the totals, the first 200
// errors (row, column, message) and, for a file with no errors, the button that
// writes it. POST ?/commit writes the whole file in one transaction
// (`settings.write`, sensitive: the owner with a recent second factor; refused
// with 409 unless the import is checked and has no errors) and is audited as
// `import.committed`. POST ?/discard drops a checked import without writing.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { sensitive } from "../../../lib/admin";
import { commitImport, findImport, reportOf } from "../../../lib/import";
import { shell } from "../../../lib/page";

export const guard = { action: "settings.write" };

const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });
const plain = (status: number, text: string): Response => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const notFound = (): Response => plain(404, "Import not found");

/** Where the written rows can be found, by kind. */
const WHERE: Record<string, string> = { customers: "/customers", sites: "/customers", services: "/services", contracts: "/contracts" };

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const row = await findImport(ctx.db, ctx.params.id);
  if (row === null) return notFound();
  const report = reportOf(row);
  return {
    ...page,
    imp: { id: row.id, kind: row.kind, file_name: row.file_name, status: row.status, rows: row.rows, errors: row.errors, insert: report.insert, update: report.update, exists: report.exists, to_write: row.ok },
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
    const done = await commitImport(ctx, ctx.params.id);
    if (!done.ok) return plain(done.status, done.message);
    return redirect(`/admin/import/${ctx.params.id}`);
  },

  async discard(ctx: ActionContext) {
    const row = await findImport(ctx.db, ctx.params.id);
    if (row === null) return notFound();
    if (row.status !== "checked") return plain(409, `This import is ${row.status}.`);
    await ctx.db.execute("update app__imports set status = 'discarded' where id = ?", [row.id]);
    return redirect("/admin/import");
  },
};
