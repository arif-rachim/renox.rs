// The back office's guard (#335): the locale, a signed-in user, then
// admin.access (403 otherwise).
import { auth, i18n } from "renox:modules";

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export type Page = {
  db: Db;
  url: URL;
  form: FormData;
  config: { title?: string; base_path?: string };
  principal?: { kind: string; id: string } | null;
  authz: {
    require(action: string, resource?: unknown): Promise<void>;
    roles: { assign(user: string, role: string): Promise<void>; revoke(user: string, role: string): Promise<boolean>; list(user: string): Promise<{ role: string }[]> };
  };
  setLocale?: (locale: string, dir?: "ltr" | "rtl") => void;
};

const redirect = (location: string): Response => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

export function admin<T>(fn: (ctx: Page) => Promise<T>): (ctx: Page) => Promise<T | Response> {
  return async (ctx) => {
    const r = (await i18n.detectLocale({ user_id: ctx.principal?.id ?? null })) as { locale: string; dir: "ltr" | "rtl"; halt?: Response };
    ctx.setLocale?.(r.locale, r.dir);
    if (r.halt) return r.halt;
    if (!ctx.principal || ctx.principal.kind === "anonymous") return redirect((await auth.loginUrl(ctx.url.pathname + ctx.url.search)) as string);
    await ctx.authz.require("admin.access");
    return fn(ctx);
  };
}

export const base = (ctx: Page): string => (ctx.config.base_path ?? "/admin").replace(/\/+$/u, "");
export const iso = (t: number): string => new Date(t).toISOString().replace(/\.\d{3}Z$/u, "Z");
