// GET /docs/:slug: one published page rendered from its markdown, with the
// grouped navigation, the on-page contents and previous/next (#326, #428).
// A slug outside the allowlist of lib/docs.ts is 404. The markdown renderer
// escapes every text run and passes no raw HTML (lib/markdown.ts), so the
// result goes into the page with r-html.
import type { LoaderContext } from "renox";

import { doc, nav, REPO } from "../../lib/docs.ts";

export function load({ params }: LoaderContext) {
  const slug = typeof params.slug === "string" ? params.slug : "";
  const d = doc(slug);
  if (d === null) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return {
    title: d.title,
    group: d.group,
    html: d.html,
    source: `${REPO}${d.path}`,
    nav: nav(slug),
    // The contents list earns its place on a long page.
    contents: d.contents.length >= 3 ? d.contents : null,
    previous: d.previous,
    next: d.next,
  };
}
