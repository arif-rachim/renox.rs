// GET /docs/:slug: one document of docs/ rendered from its markdown, with
// the sidebar in AGENTS.md's reading order (#326). The markdown renderer
// escapes every text run and passes no raw HTML (lib/markdown.ts), so the
// result goes into the page with r-html.
import type { LoaderContext } from "renox";

import { doc, REPO, sidebar } from "../../lib/docs.ts";

export function load({ params }: LoaderContext) {
  const slug = typeof params.slug === "string" ? params.slug : "";
  const d = doc(slug);
  if (d === null) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return {
    title: d.title,
    html: d.html,
    source: `${REPO}${d.path}`,
    nav: sidebar().map((s) => ({ slug: s.slug, title: s.title, current: s.slug === slug })),
  };
}
