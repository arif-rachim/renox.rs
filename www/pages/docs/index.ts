// GET /docs?q=: the published pages by group, or the titles and sections
// matching `q` (server-side, no script; #326, #428).
import type { LoaderContext } from "renox";

import { nav, search } from "../../lib/docs.ts";

export function load({ url }: LoaderContext) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  return {
    q,
    groups: nav(null),
    hits: q === "" ? [] : search(q).map((h) => ({ href: h.section?.href ?? `/docs/${h.slug}`, title: h.title, section: h.section?.text ?? null, group: h.group })),
  };
}
