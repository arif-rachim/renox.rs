/* home-services: the platform stylesheet (renox-ui.css, copied unchanged) plus
   this app's layer. --brand comes from app__settings.brand_color (layout). */
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
.brand-logo { block-size: 2rem; inline-size: auto; }
.site-header .spacer { flex: 1; }
.i18n-language { display: flex; gap: .5rem; }
main { padding: 1.5rem; max-inline-size: 72rem; margin-inline: auto; }
footer { padding: 1rem 1.5rem; text-align: center; }
.btn-brand { background: var(--brand); color: var(--brand-ink); padding: .5rem 1rem; border-radius: 999px; text-decoration: none; display: inline-block; }
:lang(ar) { direction: rtl; }

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
.backoffice-nav { display: flex; flex-direction: column; gap: .5rem; padding: 1rem 0 1rem 1.5rem; min-inline-size: 11rem; }
.backoffice-nav a { text-decoration: none; }
.backoffice main { flex: 1; min-inline-size: 0; }
.tiles { display: flex; gap: 1rem; flex-wrap: wrap; }
.tile { border: 1px solid var(--rx-rule-strong); border-top: 3px solid var(--brand-line); border-radius: .25rem; padding: .75rem 1rem; min-inline-size: 10rem; }
.tile strong { display: block; font-size: 1.75rem; }
@media (max-width: 40rem) { .backoffice { flex-direction: column; gap: 0; } .backoffice-nav { flex-direction: row; flex-wrap: wrap; padding: .5rem 1rem; } }

/* The technician's pages: every link, button and field is at least 44 x 44 CSS px (WCAG 2.2, 2.5.8). */
.touch :is(a, button, input:not([type="hidden"]), select, textarea, summary) { min-block-size: 44px; min-inline-size: 44px; }
.touch :is(a, button) { display: inline-flex; align-items: center; justify-content: center; }
