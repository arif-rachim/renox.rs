// GET <mount>: the signed-in user's files (images through <x-image>, the
// others with a signed link), the quota, and the upload form. With
// storage.manage, ?owner= browses another owner's folder. POST ?/upload
// (multipart: file, public) and ?/remove (name), on the folder shown.
import { auth, i18n } from "renox:modules";

import * as core from "../lib/core.ts";

type Page = core.StorageCtx & {
  url: URL;
  form: FormData;
  principal?: { kind: string; id: string } | null;
  authz: { require(action: string, resource?: unknown): Promise<void> };
  setLocale?: (locale: string, dir?: "ltr" | "rtl") => void;
};

const redirect = (location: string): Response => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

function guarded<T>(fn: (ctx: Page) => Promise<T>): (ctx: Page) => Promise<T | Response> {
  return async (ctx) => {
    const r = (await i18n.detectLocale({ user_id: ctx.principal?.id ?? null })) as { locale: string; dir: "ltr" | "rtl"; halt?: Response };
    ctx.setLocale?.(r.locale, r.dir);
    if (r.halt) return r.halt;
    if (!ctx.principal || ctx.principal.kind === "anonymous") return redirect((await auth.loginUrl(ctx.url.pathname + ctx.url.search)) as string);
    return fn(ctx);
  };
}

/** The folder shown: the user's own, or another owner's with storage.manage. Owner ids are folder names (lower case). */
async function ownerOf(ctx: Page, source: string | null): Promise<string> {
  const me = (ctx.principal as { id: string }).id.toLowerCase();
  if (source === null || source === "" || source === me) return me;
  await ctx.authz.require("storage.manage");
  return source;
}

const IMAGE = /^image\/(jpeg|png|webp|avif|gif)$/u;

async function view(ctx: Page, owner: string, notice: string | null, error: string | null) {
  const page = await core.list(ctx, owner, { limit: 200 });
  const q = await core.quota(ctx, owner);
  const files = [];
  for (const f of page.items) {
    const name = f.key.split("/").pop() as string;
    files.push({ name, file: f, image: IMAGE.test(f.content_type), size: `${Math.ceil(f.bytes / 1024)} KB`, type: f.content_type, link: IMAGE.test(f.content_type) ? null : (await core.link(ctx, owner, name, 600)).url });
  }
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  return { owner, files, used: mb(q.used_bytes), limit: q.limit_bytes === null ? null : mb(q.limit_bytes), max_bytes: String(ctx.config.max_upload_bytes ?? 10485760), notice, error };
}

export const load = guarded(async (ctx) => view(ctx, await ownerOf(ctx, ctx.url.searchParams.get("owner")), null, null));

export const actions = {
  upload: guarded(async (ctx) => {
    const owner = await ownerOf(ctx, ctx.url.searchParams.get("owner"));
    const file = ctx.form.get("file");
    if (!(file instanceof File) || file.size === 0) return view(ctx, owner, null, "no_file");
    const name = file.name.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^[^a-z0-9]+/u, "").slice(0, 100) || "file";
    try {
      await core.uploadWithin(ctx, owner, name, new Uint8Array(await file.arrayBuffer()), file.type || "application/octet-stream", { public: ctx.form.get("public") === "1" });
    } catch (e) {
      if (e instanceof core.UploadError) return view(ctx, owner, null, e.code.toLowerCase());
      throw e;
    }
    return view(ctx, owner, "uploaded", null);
  }),
  remove: guarded(async (ctx) => {
    const owner = await ownerOf(ctx, ctx.url.searchParams.get("owner"));
    await core.remove(ctx, owner, ctx.form.get("name"));
    return view(ctx, owner, "removed", null);
  }),
};
