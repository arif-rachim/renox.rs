// GET /api/products/:id -> one product, or 404
import type { Handler } from "renox";

import { badRequest, json, notFound, positiveInt, type Product } from "../../../lib/http.ts";

export const GET: Handler = async ({ db, params }) => {
  const id = positiveInt(params.id);
  if (id === null) return badRequest("id must be a positive integer");
  const product = await db.queryOne<Product>(
    "select id, name, description, price_fils, stock, category, image from app__products where id = ?",
    [id],
  );
  return product ? json(product) : notFound("product");
};
