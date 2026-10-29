# i18n

Chooses the locale of each page and keeps each user's choice. Ships the right-to-left CSS baseline. The official modules (`auth`, `org`, `gcc`) ship English and Arabic catalogs that work with it (`docs/08-template-engine.md`, RTL; `docs/21-uae-gcc-strategy.md`).

It has no dependencies, no network, and no secrets.

## Install

```sh
renox add i18n
```

```toml
[modules]
i18n = { version = "^1.0", config = { locales = "en,ar", default_locale = "en" } }
```

| Config | Default | |
| --- | --- | --- |
| `locales` | `en,ar` | The locales the app offers, comma separated |
| `default_locale` | `en` | Used when nothing else decides |
| `digits` | `latin` | `arabic_indic` for Eastern Arabic digits on Arabic pages. `detectLocale` returns it, but the renderer cannot use it yet (below) |

`auth` and `org` depend on i18n. Installing either installs nothing implicitly, so add i18n first.

## Choosing the locale

`detectLocale({ user_id?, org_locale? })` takes the first offered locale from this list:

1. `?lang=` in the URL. It is stored for the user, or for the page session when there is no user.
2. The user's stored choice.
3. The page session's stored choice.
4. The organisation's default (`org_locale`).
5. `Accept-Language`, by quality.
6. `default_locale`.

A candidate counts only when it is offered (`ar-AE` matches `ar`). The result is `{ locale, dir, digits, source, alternates }`. `alternates` has one link per offered locale: this page with `?lang=`.

i18n never sets the page locale itself (`ops.md` 1.3.0 section 14, "Locale"). The loader does:

```ts
import { auth, i18n, org } from "renox:modules";

export async function load(ctx) {
  const user = await auth.currentUser();
  const current = await org.currentOrg();
  const r = await i18n.detectLocale({ user_id: user?.id ?? null, org_locale: current?.locale ?? null });
  ctx.setLocale(r.locale, r.dir);
  return { i18n_links: r.alternates /* , ... */ };
}
```

i18n takes the user and the organisation default as arguments; it does not look them up itself. `auth` and `org` call i18n from their own pages, so i18n cannot depend on them: the dependency graph has no cycles (`docs/10-modules.md`, rule 1), and a manifest has no optional dependencies.

`setLocale(locale, { user_id? })` stores a choice without a `?lang=` link, for example from an account page.

The hook `i18n.detect` runs before the choice. A module may fill it and halt with its own response, such as a redirect to a canonical address. Apps cannot fill hooks (`docs/contracts/manifest.md`).

## Language links

```html
<i18n:language :links="i18n_links" />
```

The partial renders the current locale as text and the others as links to this page with `?lang=`.

## Catalogs

Each module ships `i18n/<locale>.json`. Nested objects are flattened to dotted keys, and messages use the ICU subset of `docs/08-template-engine.md`. Use `<r-t key="…" />`, or the `t` filter in an attribute: `:placeholder="'shop.list.search' | t"`.

- **A module's keys** start with the module's name (`auth.login.title`).
- **The app's catalogs** go in `i18n/<locale>.json` at the app's root. They override any module's key, so an app re-words a module without overriding a template.
- **Adding a locale** to an app:
  1. Add it to `locales`.
  2. Add `i18n/<locale>.json` with the keys of your templates.
  3. Add the official modules' keys you want translated; missing keys fall back to English.
- **Machine translation:** a catalog that was machine translated says so under `_meta`. The Arabic catalogs of `auth`, `org`, `shop` and this module are, until a native speaker reviews them (an owner task).

## RTL baseline

`public/i18n.css` uses logical properties (`margin-inline`, `padding-inline`, `text-align: start`). It keeps numbers, phone numbers, emails and codes left to right inside Arabic text, and places htmx indicators after their control. Modules cannot serve public files yet (artifact 1.1), so copy it into the app's `public/`. The shop's own fixes are in `examples/shop/public/app.css`.

## Arabic digits

The renderer shows Eastern Arabic digits for a locale tag with `-u-nu-arab`. `ctx.setLocale` only accepts tags that match `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$` (`ops.md` 1.3.0), and the one-letter `u` extension does not match. So `digits = "arabic_indic"` is returned by `detectLocale` but cannot reach the renderer until the ops contract allows the extension.

## Tables

`i18n__prefs`: `subject` (`user:<id>` or `session:<page session id>`), `locale`, `updated_at`.
