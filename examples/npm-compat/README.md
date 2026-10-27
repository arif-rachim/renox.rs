# examples/npm-compat

The app behind B17 (`docs/14-benchmarks.md`): it imports each package from the compatibility list and makes one real call that needs no network. B17 (issue #8) runs it inside the Edge Runtime isolate. If a core package fails there, the direction is re-evaluated (`docs/16-risks.md`, "npm libraries that do not run on Deno").

- `checks/<package>.ts`: one check per package. Each is an `async` function that throws on failure and finishes within 2 seconds.
- `checks/_registry.ts`: the list. Add a package by writing its file and adding one line here.
- `functions/api/check.ts`: `GET /api/check` runs every check and returns `{ results: [{ package, version, ok, error?, ms }] }`.
- `checks/_all.ts`: the same checks under Bun, one line per package, exit 1 on any failure.
- `_spike/index.ts`: the Edge Runtime user worker entry for the F0 spike (as in `examples/hello`).

## Packages

| Package | Version | Kind | What the check does |
| --- | --- | --- | --- |
| `stripe` | 23.0.1 | Official SDK | Builds a test webhook signature header and verifies it with `constructEventAsync` using the SubtleCrypto provider. A tampered payload is rejected. |
| `checkout-sdk-node` (Checkout.com) | 5.7.0 | Official SDK | Builds a sandbox client with a merchant subdomain and checks the host and the `payments` and `hostedPayments` APIs. Nothing is sent. |
| Telr | — | Hand-written helper | Builds the Hosted Payment Page `create` order request. Computes and verifies a transaction advice check (SHA-1 over the secret and fields joined with `:`), and rejects a tampered amount. |
| PayTabs | — | Hand-written helper | Signs a callback with HMAC-SHA256 of the raw body using the server key, through `crypto.subtle`, and cross-checks it against `node:crypto`. Also signs return-page fields, sorted with `signature` excluded. |
| Tabby | — | Hand-written helper | Builds the checkout session request (Bearer key, `amount` as a string, `lang: ar`). Verifies the webhook header value with a constant-time compare. |
| `arctic` | 3.7.0 | Official | Google provider authorization URL with state and PKCE (S256). |
| `@oslojs/crypto`, `@oslojs/encoding` | 1.0.1, 1.1.0 | Official | SHA-256 test vector, hex and base64url encoding. |
| WhatsApp Cloud API | — | Hand-written builder | Builds the template message request to `graph.facebook.com/<ver>/<phone-id>/messages` and validates its shape, including an Arabic parameter. An invalid recipient is rejected. |
| `resend` | 6.34.1 | Official SDK | Constructs the client and a bilingual email object. Nothing is sent. |
| `nodemailer` | 10.2.1 | Official | Sends one message to a `streamTransport` and checks the generated MIME headers. |
| `zod` | 4.6.7 | Official | Parses a nested order. An invalid order reports every issue. |
| `date-fns` | 4.4.0 | Official | `addDays` across a month boundary, `format`, weekday name. |
| `Intl` | built-in | Runtime | Formats `1234567.891` in `en-AE` and `ar-AE`. Checks that `nu=arab` gives Eastern Arabic digits, that the `islamic-umalqura` calendar resolves for `ar-AE`, and that AED currency formats. Needs full ICU. |

Telr, PayTabs, Tabby and WhatsApp have no official JavaScript SDK that targets edge runtimes, so their helpers are written here with `fetch`/`Request` and `crypto.subtle`. They exercise the same runtime primitives a real integration would use. Field lists and header names must be confirmed against each provider's current docs before the `payments-gcc` module (M17) relies on them. Telr's advice field order is the least certain.

`oslo` is deprecated upstream in favour of `@oslojs/*`, which `arctic` itself depends on, so the check uses `@oslojs/*`.

All keys and secrets in the checks are obviously fake strings. No check makes a network call.

## Running

```
bun run examples/npm-compat/checks/_all.ts         # all checks under Bun
bun test examples/npm-compat                       # registry, runner, GET /api/check
bun run --filter @renox-examples/npm-compat check  # tsc --noEmit
```

Imports are bare specifiers resolved from the exact pins in `package.json`. Deno 2 (and so the Edge Runtime) resolves them from `package.json` and `node_modules` the same way Bun does.
