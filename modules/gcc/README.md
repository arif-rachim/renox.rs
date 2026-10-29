# gcc

UAE data and checks for any app or module (catalog label "gcc-data"; `docs/21-uae-gcc-strategy.md` row M23):

- the seven emirates and their areas;
- +971 phone numbers;
- Emirates ID (with its check digit), TRN, trade licence numbers, Makani numbers and P.O. Boxes;
- an address partial and a phone partial in English and Arabic.

It has no dependencies, no network, and no secrets.

## Install

```sh
renox add gcc
```

```toml
[modules]
gcc = { version = "^1.0" }          # mounted at /gcc: the area lookup is /gcc/areas
```

## Services

Through `import { gcc } from "renox:modules"`. Each validator answers `{ ok: true, value }` (the normalised form) or `{ ok: false, reason }`.

| Service | Checks | `value` |
| --- | --- | --- |
| `validatePhone(s)` | Mobile `5[024568]` + 7 digits, landline `[2-4679]` + 7 digits; accepts `+971`, `00971`, `971`, `0`, spaces, dashes, brackets | E.164, `+971501234567` |
| `validateEmiratesId(s)` | 15 digits, `784`, a year 1900–2100, the Luhn check digit | `784-1990-1234567-6` |
| `validateTrn(s)` | 15 digits (format only: the FTA register is not consulted) | the digits |
| `validateTradeLicence(s, emirate)` | The shape for the issuing emirate: Abu Dhabi `CN-` + 6–8 digits, Dubai 6–8 digits, Sharjah 5–8, Ajman 4–8, the others 4–20 letters, digits and dashes (format only) | upper case |
| `validateMakani(s)` | 10 digits | the digits |
| `validatePoBox(s)` | 1–6 digits, with or without "P.O. Box" | the digits |
| `listAreas(emirate)` | Areas of an emirate (`AE-AZ`, `AE-DU`, `AE-SH`, `AE-AJ`, `AE-UQ`, `AE-RK`, `AE-FU`, ISO 3166-2:AE), by English name | |
| `findAreas(q, emirate?)` | Areas whose English or Arabic name starts with `q`, at most 20, one indexed query | |

The same checks are pure functions in `lib/validators.ts`, with no I/O. Code that runs outside the isolate (a browser bundle, a script) imports that file directly.

## Partials

- `<gcc:address emirate area po_box makani areas_url>`: an emirate select, an area field that asks `/gcc/areas` for the `area_list` fragment as you type (htmx), a P.O. Box, and a Makani number.
- `<gcc:phone name value>`: a `tel` input that holds the E.164 value (`dir="ltr"`), with the number formatted for reading next to it by the platform's `phone_ae` filter. In Arabic the formatted text is wrapped in LTR isolates, which belong in text, never in an input value.

Labels come from `i18n/en.json` and `i18n/ar.json`, keys `gcc.*`. An app overrides a label with the same key in its own catalog.

## Tables and views

`gcc__areas` (`emirate`, `name_en`, `name_ar`, `makani`: 1 for Dubai, where Makani numbers are the address). Other modules read it through `gcc__public_areas_v1`.

## Data

The seed (`migrations/002_seed_areas.sql`, as of 2026-10-29) is a starter list of well-known areas per emirate, names in English and Arabic, written for this module. It is not an official registry, and it is not complete. For a full list, use the emirates' official address data (Dubai Municipality's community list and Makani, the Abu Dhabi and Sharjah municipalities). Add areas with your app's own migration through `gcc__public_areas_v1` consumers, or with a later version of this module.

## Permissions

| What | Value |
| --- | --- |
| Tables | `gcc__*` |
| Network, secrets, slots, hooks | none |

Policy: `gcc.read` is public (`policies/gcc.cedar`; files only until F5).

## Tests

`renox test` in this folder runs:

- `tests/validators.test.ts`: plain Bun, every branch, 100 % of the lines and functions of `lib/validators.ts` with `--coverage`;
- `tests/gcc.test.ts`: on the worker. The services through the broker; the `Dub` fragment (4 areas, one indexed query, median under 10 ms on the dev container); the partials in English and Arabic, snapshotted.
