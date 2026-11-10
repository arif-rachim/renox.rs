/* home-services: the platform stylesheet (renox-ui.css, copied unchanged) plus
   this app's layer. --brand comes from app__settings.brand_color (layout).
   Fonts (#729): /fonts/*.woff2 are the Arabic subset of Noto Sans Arabic from
   @fontsource/noto-sans-arabic 5.3.0 (SIL OFL 1.1, NotoSansArabic-OFL.txt), copied unchanged:
   noto-sans-arabic-arabic-400-normal.woff2 sha256 4e2ca0745c908761dc5c5db951662873887c59366fa1a5693ad22c0864abf1bd
   noto-sans-arabic-arabic-700-normal.woff2 sha256 d2bf5ac762d07f769e4e644a1f919649317cb5b62e20ab9ae02918862627b723
   tests/typography.test.ts compares them with node_modules. Logical properties only (no physical
   sides), so the page mirrors in Arabic. */
:root { --brand: #e8634a; --brand-ink: #000; --brand-line: #e16048; }
/* Accessibility (#727). --brand-ink (the text on a brand button) and --brand-line
   (the brand colour as a ring or line, 3:1 against the page) come from /theme,
   computed from the client's colour; the values above are the coral's. */
:focus-visible { outline: 3px solid var(--brand-line); outline-offset: 2px; }
@media (prefers-color-scheme: dark) { :root { --brand-line: #e8634a; } }
.skip { position: absolute; inset-inline-start: .5rem; inset-block-start: 0; z-index: 10; display: inline-flex; align-items: center; min-block-size: 44px; padding: .5rem 1rem; background: var(--rx-pill); color: var(--rx-pill-ink); border-radius: 0 0 .5rem .5rem; transform: translateY(-120%); }
.skip:focus { transform: none; }
.site-header { display: flex; gap: 1rem; align-items: center; padding: .75rem 1.5rem; border-bottom: 3px solid var(--brand-line); }
.site-header a, .site-header strong { text-decoration: none; display: inline-flex; align-items: center; min-block-size: 44px; min-inline-size: 44px; justify-content: center; }
/* The organisation switcher and the notification badge come from modules into the header: the same 44 px. */
.site-header :is(select, button, input) { min-block-size: 44px; }
.brand-link { display: inline-flex; gap: .5rem; align-items: center; justify-content: flex-start; }
/* The logo is an upload of any shape: a fixed 32 x 32 box (the width and height attributes), so the header never shifts when it arrives (#728). */
.brand-logo { block-size: 2rem; inline-size: 2rem; object-fit: contain; }
.site-header .spacer { flex: 1; }
.i18n-language { display: flex; gap: .5rem; }
main { padding: 1.5rem; max-inline-size: 72rem; margin-inline: auto; }
footer { padding: 1rem 1.5rem; text-align: center; }
.btn-brand { background: var(--brand); color: var(--brand-ink); padding: .5rem 1rem; border-radius: 999px; text-decoration: none; display: inline-block; }
/* The root only: an element with dir="ltr" (a number, a phone) keeps its own direction (#729). */
:root:lang(ar) { direction: rtl; }

/* Jobs and the dispatch board. */
.board { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; align-items: start; }
.board-column h2 { font-size: 1rem; border-block-end: 3px solid var(--brand-line); padding-block-end: .25rem; }
.board-cards { display: flex; flex-direction: column; gap: .5rem; min-block-size: 3rem; }
.job-card { display: flex; flex-wrap: wrap; gap: .25rem .5rem; padding: .5rem .75rem; border: 1px solid var(--rx-rule-strong); border-inline-start: 4px solid var(--rx-muted); border-radius: .5rem; }
.job-card.priority-high { border-inline-start-color: var(--rx-warn); }
.job-card.priority-urgent { border-inline-start-color: var(--rx-bad); }
/* The priority is also written out, so colour is never the only signal. */
.job-card .priority { font-size: .8125rem; font-weight: 600; }
.job-card.priority-high .priority { color: var(--rx-warn); }
.job-card.priority-urgent .priority { color: var(--rx-bad); }
.job-card em { font-style: normal; font-weight: 600; }
.timeline { list-style: none; padding: 0; display: flex; flex-direction: column; gap: .25rem; }
.work-links { display: flex; gap: 1rem; }

/* The technician's visit (phone first). */
.btn-big { font-size: 1.125rem; padding: .75rem 1.5rem; }
.visit-list { list-style: none; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
.visit-item { display: flex; flex-wrap: wrap; gap: .25rem .75rem; padding: .75rem; border: 1px solid var(--rx-rule-strong); border-inline-start: 4px solid var(--brand-line); border-radius: .5rem; align-items: baseline; }
.photos { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
.photos li { display: flex; flex-direction: column; gap: .125rem; max-inline-size: 10rem; }
.thumb { max-inline-size: 100%; block-size: auto; border-radius: .25rem; }
.sig-canvas { inline-size: 100%; max-inline-size: 20rem; aspect-ratio: 2 / 1; border: 2px dashed var(--rx-ink-2); border-radius: .25rem; background: #fff; touch-action: none; }
.parts-table { inline-size: 100%; }
form.inline { display: inline; }
@media (max-width: 40rem) { main { padding: 1rem; } .site-header { padding: .5rem 1rem; flex-wrap: wrap; } }

/* The back office (pages/_layouts/back-office.html): a side menu and the page. */
.backoffice { display: flex; gap: 1.5rem; align-items: flex-start; }
.backoffice-nav { display: flex; flex-direction: column; gap: .5rem; padding-block: 1rem; padding-inline: 1.5rem 0; min-inline-size: 11rem; }
.backoffice-nav a { text-decoration: none; }
.backoffice main { flex: 1; min-inline-size: 0; }
.tiles { display: flex; gap: 1rem; flex-wrap: wrap; }
.tile { border: 1px solid var(--rx-rule-strong); border-block-start: 3px solid var(--brand-line); border-radius: .25rem; padding: .75rem 1rem; min-inline-size: 10rem; }
.tile strong { display: block; font-size: 1.75rem; }
@media (max-width: 40rem) { .backoffice { flex-direction: column; align-items: stretch; gap: 0; } .backoffice main { margin-inline: 0; inline-size: 100%; box-sizing: border-box; } .backoffice-nav { flex-direction: row; flex-wrap: wrap; padding: .5rem 1rem; } }

/* The technician's pages: every link, button and field is at least 44 x 44 CSS px (WCAG 2.2, 2.5.8). */
.touch :is(a, button, input:not([type="hidden"]), select, textarea, summary) { min-block-size: 44px; min-inline-size: 44px; }
.touch :is(a, button) { display: inline-flex; align-items: center; justify-content: center; }

/* Arabic (#729): Noto Sans Arabic from this origin (the CSP allows no CDN); the unicode-range makes the browser fetch a file only
   when the page holds Arabic. Digits stay Western: no font-variant-numeric, no locale that switches them. */
@font-face { font-family: "Noto Sans Arabic"; font-style: normal; font-weight: 400; font-display: swap; src: url(/fonts/noto-sans-arabic-arabic-400-normal.woff2) format("woff2"); unicode-range: U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0898-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC; }
@font-face { font-family: "Noto Sans Arabic"; font-style: normal; font-weight: 700; font-display: swap; src: url(/fonts/noto-sans-arabic-arabic-700-normal.woff2) format("woff2"); unicode-range: U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0898-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC; }
:lang(ar) { font-family: "Noto Sans Arabic", system-ui, sans-serif; line-height: 1.8; letter-spacing: 0; text-transform: none; }
:lang(ar) :is(h1, h2, h3, h4, h5, h6) { line-height: 1.5; letter-spacing: 0; }
:lang(ar) :is(em, i) { font-style: normal; font-weight: 700; }
/* Code keeps its monospace face; a control inherits the Arabic face and keeps its own, shorter line height. */
:lang(ar) :is(code, kbd, samp, pre, .mono) { font-family: var(--rx-font-mono); }
:lang(ar) :is(button, input, select, textarea) { font-family: inherit; line-height: 1.4; }
.num, td.money, time { font-variant-numeric: tabular-nums; }
/* A number, a phone or a code is read in Latin order (dir="ltr" on its element), but its box still sits at the reading start:
   the reading edge of an Arabic page, under its label. */
:lang(ar) :is(dd, td, th, h1, h2, p, li, div)[dir="ltr"] { text-align: end; }

/* A table wider than the phone scrolls inside its own box (it takes focus, so a keyboard reaches the columns); the box starts
   at the reading edge, so in Arabic it starts at the reading edge. Fields never outgrow their row. */
.table-scroll { position: relative; overflow-x: auto; max-inline-size: 100%; margin-block-end: var(--rx-4, 1rem); }
.table-scroll > table { margin-block-end: 0; }
main :is(select, input:not([type="checkbox"], [type="radio"]), textarea) { max-inline-size: 100%; box-sizing: border-box; }
main label { min-inline-size: 0; max-inline-size: 100%; }
main fieldset { min-inline-size: 0; }
main :is(li, dd, p) { overflow-wrap: anywhere; }
/* An outside bullet sticks out of the page by 2 px at the reading edge of a phone in Arabic (it made the page scroll): inside keeps it on the line. */
main :is(ul, ol):not([class]) { list-style-position: inside; padding-inline-start: 0; }
