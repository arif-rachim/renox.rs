# www

The public site, renox.app (#326): a Renox app deployed as the second internal tenant, after the dashboard.

| Route | Source |
| --- | --- |
| `/` | `pages/index.html` |
| `/docs`, `?q=` | Every document in reading order, searched by title (`lib/docs.ts`) |
| `/docs/:slug` | One document of `docs/` or `docs/contracts/`, rendered from its markdown at build time (`lib/markdown.ts`). Links to another document stay on the site; any other link goes to the repository |
| `/pricing` | `pricing.toml`, which must equal `control/billing/src/plans.ts` |
| `/legal/dpa`, `/legal/terms` | The drafts whose versions sign-up records (`control/api/src/signup/dpa.ts`) |

**Documents.** They are imported as text (`lib/docs.ts`, one import per file). When a document is added, add its import line; `tests/pages.test.ts` fails until you do. The sidebar follows the reading order of `AGENTS.md`, then the contracts.

**Markdown.** The renderer covers the subset the documents use. It escapes every text run and passes no raw HTML, so its output is safe for `r-html`.

**Tests.** Run `bun test` in this directory; with `RENOX_WORKER_PATH` it also builds, checks and serves the site. The tests check that:
- every document renders;
- every link to the site lands on a document and its heading;
- `.github/scripts/check-links.ts` passes;
- the renderer escapes HTML;
- the pricing page equals the billing plans;
- the legal pages carry the recorded versions.

**Deploy.** From this directory: `bunx renox deploy`. There is no database, no network and no secrets.
