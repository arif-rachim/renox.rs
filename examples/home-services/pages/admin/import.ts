// GET /admin/import: bring customers, sites, services, parts, opening stock and contracts in from
// Excel (`settings.write`: the owner). Six kinds, one sheet each, with a
// template to download. The browser sends the file straight to the store with a
// signed PUT (`public/upload.js`: a page action is limited to 1 MiB), POST
// ?/upload_url signs it, and POST ?/check makes an `app__imports` row
// (`checking`) and enqueues the job `import-check`, which reads the stored file,
// validates it and keeps the report; nothing else is written. The report and the
// commit are at /admin/import/<id>.
import type { ActionContext, LoaderContext } from "@renoxium/sdk";

import { invalid } from "../../lib/invalid";
import { COLUMNS, isKind, isUploadKey, KINDS, MAX_FILE_BYTES, recentImports, startImport, XLSX_TYPE } from "../../lib/import";
import { shell } from "../../lib/page";

export const guard = { action: "settings.write" };

const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });
const json = (status: number, message: string): Response => Response.json({ message }, { status, headers: { "cache-control": "no-store" } });

export async function load(ctx: LoaderContext) {
  const page = await shell(ctx);
  const imports = await recentImports(ctx.db, 10);
  return {
    ...page,
    kinds: KINDS.map((k) => ({ kind: k, columns: COLUMNS[k].map((c) => (c.required ? `${c.name}*` : c.name)).join(", ") })),
    max_mb: MAX_FILE_BYTES / (1024 * 1024),
    imports,
    values: {},
  };
}

const stem = (name: string): string =>
  name
    .replace(/\.[^.]*$/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);

export const actions = {
  /** Step one (`upload.js`): a signed URL for the browser's PUT of one .xlsx under `app/imports/`, as JSON `{ url, max_bytes }`. */
  async upload_url(ctx: ActionContext) {
    const name = String(ctx.form.get("name") ?? "");
    const type = String(ctx.form.get("type") ?? "");
    const size = ctx.form.get("size");
    if (!/\.xlsx$/iu.test(name)) return json(422, "Choose an Excel file (.xlsx).");
    if (type !== XLSX_TYPE) return json(422, "Choose an Excel file (.xlsx).");
    if (typeof size === "string" && /^\d+$/u.test(size)) {
      if (Number(size) < 1) return json(422, "The file is empty.");
      if (Number(size) > MAX_FILE_BYTES) return json(413, "The file is over 10 MiB.");
    }
    const random = crypto.randomUUID().replace(/-/gu, "").slice(0, 16);
    const s = stem(name);
    const key = `app/imports/${random}${s === "" ? "" : `-${s}`}.xlsx`;
    const signed = await ctx.storage.signUpload(key, { contentType: XLSX_TYPE, maxBytes: MAX_FILE_BYTES });
    return Response.json({ url: signed.url, max_bytes: signed.max_bytes }, { headers: { "cache-control": "no-store" } });
  },

  /** Step two: makes the import `checking` and enqueues its check; the owner then waits for the report at /admin/import/<id>. The file is not read here. */
  async check(ctx: ActionContext) {
    const page = await shell(ctx);
    const kind = ctx.form.get("kind");
    if (!isKind(kind)) return invalid(page.locale, ctx.form, { kind: "import.err.bad_kind" });
    const key = ctx.form.get("file_key");
    if (!isUploadKey(key)) return invalid(page.locale, ctx.form, { file_key: "import.err.no_file" });
    try {
      await ctx.storage.get(key);
    } catch {
      return invalid(page.locale, ctx.form, { file_key: "import.err.no_file" });
    }
    const id = await startImport(ctx, kind, key);
    await ctx.jobs.enqueue("import-check", { import_id: id });
    return redirect(`/admin/import/${id}`);
  },
};
