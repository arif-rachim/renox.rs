// Small JSON helpers shared by the shop functions.

export const json = (body: unknown, status = 200): Response => Response.json(body, { status });

export const notFound = (what: string): Response => json({ error: { code: "not_found", message: `${what} not found` } }, 404);

export const badRequest = (message: string, issues?: unknown): Response =>
  json({ error: { code: "bad_request", message, ...(issues === undefined ? {} : { issues }) } }, 400);

/** A positive integer route or query parameter, or null. */
export function positiveInt(v: string | string[] | null | undefined): number | null {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,15}$/u.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

export interface Product {
  [column: string]: string | number | null;
  id: number;
  name: string;
  description: string;
  price_fils: number;
  stock: number;
  category: string;
  /** The stored file's key (`storage/products/<category>.png`, #332) once seeded. */
  image: string;
  image_width: number | null;
  image_height: number | null;
}

export const PRODUCT_COLUMNS = "id, name, description, price_fils, stock, category, image";
