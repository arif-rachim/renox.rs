# packages/ui — renox-ui, the Renoxium design system

`renox-ui.css` is the one stylesheet behind Renoxium's own pages: the dashboard (`control/dashboard`) and the site (`www`). It is plain CSS: no build step, no JavaScript, no web fonts, and nothing loaded from another origin, so it works under the CSP every Renox app gets (`default-src 'self'`) and in an app with no `package.json` dependencies.

## Using it

Copy the file into the app's `public/` folder unchanged, and load it before the app's own layer:

```html
<link rel="stylesheet" href="/renox-ui.css">
<link rel="stylesheet" href="/app.css">
```

Each app has a test that its copy equals this file (`control/dashboard/tests/ui.test.ts`, `www/tests/pages.test.ts`). To change the system, edit this file and copy it again; the tests fail until every copy matches.

## Principles

- **Paper and ink.** A warm paper background, near-black ink, rules instead of boxes and shadows. Corners are almost square (2 px).
- **One accent.** Vermilion (`--rx-accent`) marks action and position: the brand mark, the current navigation item, focus, link underlines. It is never decoration.
- **State is not decoration.** Green, amber and red (`--rx-ok`, `--rx-warn`, `--rx-bad`) mean live, attention and failure, and nothing else. The status glyph in the text (● ○ ✗) carries the shape, so colour is never the only signal.
- **Data in monospace.** Hashes, times, request ids and numbers use the system monospace face with tabular figures, so columns line up.
- **System faces only.** Each stack names Latin and Arabic faces. The site uses the serif stack for headlines.
- **Right to left for free.** Every direction is a logical property (`margin-inline-start`, `border-block-end`, `inset-block-start`); a page with `<html dir="rtl">` mirrors without an override. The tests refuse physical properties.
- **Light and dark.** The tokens switch with `prefers-color-scheme`.

## Tokens

| Token | Use |
| --- | --- |
| `--rx-paper`, `--rx-surface`, `--rx-sunken` | Page, raised panel (cards, fields), recessed area (code, hover) |
| `--rx-ink`, `--rx-ink-2`, `--rx-muted` | Text: primary, secondary, quiet |
| `--rx-rule`, `--rx-rule-strong`, `--rx-field` | Light rule, heavy rule (table headers, the top bar), field border |
| `--rx-accent`, `--rx-accent-ink` | Action and position; text on the accent |
| `--rx-ok`, `--rx-warn`, `--rx-bad` and their `-bg` | State text and its tint |
| `--rx-font-sans`, `--rx-font-serif`, `--rx-font-mono` | Type stacks |
| `--rx-1` … `--rx-7` | Spacing, 4 px to 48 px |
| `--rx-radius`, `--rx-measure` | Corner radius; the longest comfortable line |

An app re-themes by overriding tokens in its own layer, never by editing a copy of this file.

## Components

| Class or element | What it is |
| --- | --- |
| `.top`, `.brand`, `.spacer` | The top bar; the brand with its square mark; a flexible gap |
| `.frame`, `.side`, `.side-title`, `main` | Side navigation and the main column; `a.current` marks the page |
| `.narrow`, `.cols`, `.title-row`, `.row`, `.filters` | Layout helpers |
| `button`, `.button`, `.primary`, `.danger`, `button.link` | Outline buttons; one solid `.primary` per view |
| `label`, `input`, `select`, `textarea`, `fieldset` | Fields; a radio or checkbox in a fieldset gets a row with its description |
| `table.list` | A ruled table; `tr.bad` marks a failing row |
| `.notice`, `.problem`, `.warning`, `.problem-inline` | Messages with a start-edge rule |
| `.banner`, `.banner.impersonation` | A full-width bar above the page |
| `.ok`, `.bad`, `.warn`, `.tag` | State text; a small outlined label |
| `.tabs` | Segmented links; `a.current` is filled |
| `.cards`, `.card`, `.review`, `.detail` | Ruled panels |
| `.checklist` | A numbered to-do list; `li.done` stays visible |
| `.codes` | A grid of codes (recovery codes) |
| `.chart` | A `<figure>` with an `<svg>` of `<rect>` bars |
| `.legal`, `.prose` | Long-form text at a reading measure |
| `.muted`, `.small`, `.mono`, `.num`, `.n`, `.ar`, `.visually-hidden` | Utilities |

## Not yet

- Modules (`modules/*`) render their own pages for tenants and do not use this file yet. Offering it to tenant apps (for example as a stylesheet the modules' pages can opt into) is a later decision.
- There is no dark-mode switch in the page: the reader's system setting decides.
