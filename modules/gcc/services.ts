// The gcc module's services: the validators of lib/validators.ts, and the
// area lookups (one indexed query each).
import * as v from "./lib/validators.ts";

interface Ctx {
  db: { query<T>(sql: string, params?: unknown[]): Promise<T[]> };
}

export interface Area {
  id: number;
  emirate: v.Emirate;
  name_en: string;
  name_ar: string;
  makani: number;
}

export const validatePhone = async (_ctx: Ctx, s: unknown) => v.phone(s);
export const validateEmiratesId = async (_ctx: Ctx, s: unknown) => v.emiratesId(s);
export const validateTrn = async (_ctx: Ctx, s: unknown) => v.trn(s);
export const validateTradeLicence = async (_ctx: Ctx, s: unknown, emirate: unknown) => v.tradeLicence(s, emirate);
export const validateMakani = async (_ctx: Ctx, s: unknown) => v.makani(s);
export const validatePoBox = async (_ctx: Ctx, s: unknown) => v.poBox(s);

export async function listAreas(ctx: Ctx, emirate: unknown): Promise<Area[]> {
  if (!v.isEmirate(emirate)) return [];
  return ctx.db.query<Area>("select id, emirate, name_en, name_ar, makani from gcc__areas where emirate = ? order by name_en", [emirate]);
}

/** LIKE pattern for a prefix: `%` and `_` in the text are literal. */
export const prefix = (q: string): string => `${q.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;

export async function findAreas(ctx: Ctx, q: unknown, emirate?: unknown): Promise<Area[]> {
  const text = typeof q === "string" ? q.trim().slice(0, 50) : "";
  if (text.length === 0) return [];
  const e = v.isEmirate(emirate) ? emirate : null;
  return ctx.db.query<Area>(
    `select id, emirate, name_en, name_ar, makani from gcc__areas
     where (name_en like ?1 escape '\\' or name_ar like ?1 escape '\\') and (?2 is null or emirate = ?2)
     order by name_en limit 20`,
    [prefix(text), e],
  );
}
