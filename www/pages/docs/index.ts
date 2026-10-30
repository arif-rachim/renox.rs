// GET /docs?q=: the documentation in reading order, searched by title (#326).
import type { LoaderContext } from "renox";

import { search, sidebar } from "../../lib/docs.ts";

export function load({ url }: LoaderContext) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const list = q === "" ? sidebar() : search(q);
  return { q, docs: list.map((d) => ({ slug: d.slug, title: d.title, path: d.path })) };
}
