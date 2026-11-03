# packages/ui — renox-ui v2 "dot matrix", the Renoxium design system

`renox-ui.css` is the one stylesheet behind Renoxium's own pages: the dashboard (`control/dashboard`) and the site (`www`). It is plain CSS: no build step, no JavaScript, nothing loaded from another origin. The one file it loads is the display font beside it, served from the app's own `public/` folder, so it works under the CSP every Renox app gets (`default-src 'self'`) and in an app with no `package.json` dependencies. ADR D24 chose an in-house system; ADR D27 set this visual language and allowed the one font.

## Using it

Copy three files into the app's `public/` folder unchanged, and load the stylesheet before the app's own layer:

| File | What it is |
| --- | --- |
| `renox-ui.css` | The system |
| `doto-black.woff2` | The display face: Doto Black, subset to capitals, digits and basic punctuation (1.7 KB) |
| `doto-OFL.txt` | Its licence, the SIL Open Font License 1.1 |

```html
<link rel="stylesheet" href="/renox-ui.css">
<link rel="stylesheet" href="/app.css">
```

Each app has a test that its copies equal these files (`control/dashboard/tests/ui.test.ts`, `www/tests/pages.test.ts`). To change the system, edit here and copy again; the tests fail until every copy matches. `demo.html` shows every component; serve this folder at a root to view it (the comment at its top says how).

## Principles

- **The dot matrix is the brand's voice.** A node is a matrix of cells; a lit cell is a dot. Headlines (`.dot`) and big numbers (`.stat`) are set in a dot-matrix face, uppercase, very large; everything else is quiet so they can speak. The mark is a soft tile with a 2 × 2 matrix inside it, one cell lit.
- **A warm light ground.** Paper, surface and sunken are three warm greys, not white; ink is near-black. Dark mode is the counterpart (the same three steps, lit from below), not an inversion.
- **Light, modern text.** The system sans at weight 400, headings included; hierarchy from size and tight tracking on the large sizes. A headline mixes ink and muted words inside one sentence (`<span class="muted">`). Monospace is for small pill labels and code only. Labels are sentence case.
- **One accent, used sparingly.** Coral is the icon square of the primary button, a live dot, and one highlight per view. It is never body text (it does not reach AA on paper), so no `.accent` text class exists. Green, amber and red are states, always with a word or a glyph.
- **Thin lines and soft cards.** Hairlines split rows and columns; cards are large rounded surfaces with a faint shadow; a diagram is thin lines leaving the mark's tile, ending in dots and pill tags.
- **Right to left for free.** Every direction is a logical property; a page with `<html dir="rtl">` mirrors without an override (the diagram included, through flex order). Under `:lang(ar)` the dot face is never used: display text falls back to the system Arabic face at a heavier weight.
- **Motion once.** The lit cells of a dot field pulse slowly; nothing else moves, and `prefers-reduced-motion` stops it.
- **Contrast is checked, not hoped.** `lint.ts` lists every text-on-ground pair the tokens promise and fails the apps' tests when one falls under WCAG 2.2 AA, in light or in dark.

A note on the face: Doto draws a period as a small cross, so a dot-matrix number should be whole (`107 KB`, not `0.1 MB`), and a sentence set in `.dot` should end in a word, or use the period knowingly.

## Tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--rx-paper`, `--rx-surface`, `--rx-sunken` | `#efeeea`, `#f7f7f5`, `#e6e5e0` | `#121211`, `#1a1a19`, `#0d0d0c` | Page; cards and panels; code, fields, the boxed icon |
| `--rx-ink`, `--rx-ink-2`, `--rx-muted` | `#141414`, `#3d3d3a`, `#66655f` | `#f1f0ec`, `#c9c8c2`, `#9a9993` | Text: primary, secondary, quiet. Each reaches AA on each ground |
| `--rx-rule`, `--rx-rule-strong`, `--rx-field` | `#d9d8d2`, `#c2c1ba` | `#2b2b29`, `#3d3d3a` | Hairlines; diagram lines and pill borders; field borders |
| `--rx-accent`, `--rx-accent-ink` | `#e8634a` | `#f07a62` | The coral: the icon square, a live dot, one highlight per view; what sits on it |
| `--rx-pill`, `--rx-pill-ink` | `#141414` / `#ffffff` | `#f1f0ec` / `#121211` | The primary button's pill and its text |
| `--rx-idle` | `#cfcec8` | `#3d3d3a` | An idle cell of a dot field |
| `--rx-ok`, `--rx-warn`, `--rx-bad` and their `-bg` | green, amber, red | lighter | State text and its tint |
| `--rx-font-dot`, `--rx-font-sans`, `--rx-font-mono` | | | Doto (self-hosted); the system sans and mono stacks, Latin and Arabic |
| `--rx-1` … `--rx-8` | | | Spacing, 4 px to 72 px |
| `--rx-r-pill`, `--rx-r-card`, `--rx-r-control`, `--rx-r-icon`, `--rx-r-cell` | 999, 18, 10, 7, 2 px | | Radius by rank |
| `--rx-grid`, `--rx-shadow`, `--rx-measure` | | | The faint grid behind a hero; the shadow that raises a tile; the longest comfortable line |

An app re-themes by overriding tokens in its own layer, never by editing a copy of this file.

## Components

| Class or element | What it is |
| --- | --- |
| `.top`, `.top-links`, `.chev`, `.brand`, `.spacer` | The floating rounded top bar: the mark, centred links (a chevron is text), the account actions at the end |
| `.frame`, `.side`, `.side-group`, `.side-title`, `main` | Side navigation and the main column; `a.current` carries the accent dot; `.side-group` is a small mono heading |
| `.hero`, `.lede`, `.actions` | A centred hero on a faint grid; its subtitle; its buttons |
| `.dot`, `.dot-small` | A dot-matrix headline, uppercase, `clamp(48–96 px)`; a smaller one |
| `.stat` with `.value` and `.caption` | A big dot-matrix number over a small sans caption; a unit goes in `<small>` inside the value and keeps its own case in the text face (`45 ms`, never `45 MS`). Only true, measured numbers |
| `.pill` (`.ok`, `.warn`, `.bad`, `.quiet`, `.live`), `.tag` | A small monospace label in a hairline capsule; the states; a live dot |
| `.flow`, `.flow-start`, `.flow-end`, `.flow-tile`, `.line`, `.pt` | A diagram: the tile with the mark in the centre, thin lines to pill tags on both sides; `.flow-small` for an app page |
| `.dots` | A decorative field of cells drawn as an inline SVG: `circle.dot-idle`, `rect.cell`, `rect.lit` (coral, a slow pulse). `aria-hidden`; drawn rather than typed, so it is not text to be read |
| `button`, `.button`, `.primary`, `.go`, `.danger`, `button.link` | Pills: the black primary with a coral icon square; a white pill with a dark icon square; quiet; red outline; text |
| `label`, `input`, `select`, `textarea`, `fieldset` | Fields; a radio or checkbox in a fieldset gets a soft card with its description |
| `table.list` | A hairline table with quiet sentence-case headers; `th.n` and `td.n` right-align figures; `tr.bad` marks a failing row |
| `.notice`, `.problem`, `.warning`, `.problem-inline` | Messages with a start-edge rule in the state's colour |
| `.banner`, `.banner.impersonation` | A full-width bar above the page |
| `.ok`, `.bad`, `.warn` | State text |
| `.meta`, `.stats`, `.cards`, `.card`, `.card-text` | Facts in a line; one rounded surface split into columns by hairlines (numbers over names, or any cards); a text column |
| `.panel`, `.detail`, `.review`, `.tabs`, `.checklist`, `.codes`, `.chart`, `.console` | Soft cards; segmented links (`a.current` filled); the steps of a sequence; a grid of codes; a `<figure>` with `<svg>` bars; log lines in a sunken panel |
| `pre[data-lang]` | A code block with a language pill |
| `.legal`, `.prose` | Long-form text at a reading measure |
| `.muted`, `.small`, `.mono`, `.num`, `.n`, `.ar`, `.visually-hidden` | Utilities |

## The lint (`lint.ts`)

`physicalLines(css)` lists lines with a physical direction (`margin-left`, `left:`, `width:` …). `loadsAnything(css)` is true for `@import`, an absolute URL, or a `url()` that is not a root-relative path of this origin. `contrastFailures(css)` reads the tokens of `:root` and of the dark block and checks the pairs in `PAIRS` against WCAG 2.2 AA (4.5:1 for text, 3:1 for the accent's icon). The apps' tests run all three on the system and on their own layer.

## Not yet

- Modules (`modules/*`) render their own pages for tenants and do not use this file yet. Offering it to tenant apps is a later decision.
- There is no dark-mode switch in the page: the reader's system setting decides.
