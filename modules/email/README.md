# email (#328)

Transactional email for apps and modules.
- Templates in English and Arabic, side by side in one message.
- Sent through **Resend** or **Amazon SES**, queued through the outbox with retries.
- A suppression list fed by bounces and complaints.
- A message log page for admins.

Bodies are never logged.

## Install

```sh
bunx renox add email          # needs auth and i18n
bunx renox secrets set EMAIL_RESEND_KEY re_…                       # provider = resend
bunx renox secrets set EMAIL_SES_ACCESS_KEY …; bunx renox secrets set EMAIL_SES_SECRET_KEY …   # provider = ses
bunx renox secrets set EMAIL_WEBHOOK_SECRET …                      # the bounce and complaint relay
```

`renox.toml`:

```toml
email = { version = "^1.0", mount = "/email", config = { provider = "resend", from = "orders@yourshop.ae" } }
```

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `resend` | `resend` or `ses` |
| `from` | (empty) | The From address, on a domain verified with the provider. Until it is set, nothing is sent and messages end as `failed` with `not_configured` |
| `ses_region` | `me-central-1` | The SES region |
| `sends_per_minute` | 120 | Past it, `send` refuses (`RATE_LIMITED`) |
| `base_path` | `/email` | Where the log page is mounted |

## Services

| Service | What it does |
| --- | --- |
| `send(to, template, data, { locale?, reply_to? })` | Queues one of the templates below in the recipient's locale (`en` or `ar`); the other language follows in the same message. Answers `{ id }`, or `{ id: null, cancelled: true }` when `email.before_send` halts. A suppressed address is refused with `SUPPRESSED` |
| `sendRaw({ to, subject, text?, html?, reply_to? })` | Queues a message the caller wrote itself |
| `status(id)` | `{ status, attempts, error }`, where status is `queued`, `sent`, `failed` or `suppressed` |
| `suppress(address, reason)`, `unsuppress(address)`, `isSuppressed(address)` | Manage the suppression list |

**Templates** (`lib/templates.ts`): `verify_email`, `password_reset`, `magic_link`, `account_exists`, `welcome`.
- The values are `display_name`, `url` (only `https`, or `http` on localhost) and `expires_minutes`.
- Every value is escaped, and the HTML is a two-column table: one column `lang="en" dir="ltr"`, the other `lang="ar" dir="rtl"`.
- A different wording means a new template here.

## Adapters

| Provider | How it sends | Retries |
| --- | --- | --- |
| Resend | `POST https://api.resend.com/emails` with `EMAIL_RESEND_KEY` | A 5xx, a 429 or a network failure throws, so the outbox retries with backoff and dead-letters after its last attempt. A 4xx is final (`failed`) |
| SES v2 | `POST https://email.<region>.amazonaws.com/v2/email/outbound-emails`, signed with SigV4 using `EMAIL_SES_ACCESS_KEY` and `EMAIL_SES_SECRET_KEY` | Same as Resend |
| SMTP | Not available: an isolate has no raw sockets. Use a provider's HTTP API, or an HTTP relay in front of SMTP | — |

## Events and hooks

| Name | Kind | What it is |
| --- | --- | --- |
| `email.send_requested` | event (own) | A message was queued; the module's handler sends it after the commit |
| `email.bounced`, `email.complained` | events | `{ address }`: the address is now suppressed |
| `email.before_send` | hook point | `{ template, locale, to_domain }`, never the body: a filler that halts stops the message (the app's own sending policy) |
| `auth.send_mail` | hook filled | auth's confirmation, reset, magic-link and account-exists emails, from the templates |
| `auth.user_registered` | event handled | The `welcome` email, to the address in `auth__public_users_v1` |
| `notifications.deliver` | hook filled | The `email` channel of the notifications module |

## Feedback

The provider's bounce and complaint notifications are relayed to `POST <mount>/webhooks/feedback`, checked with the generic HMAC scheme of `webhook.verify` and `EMAIL_WEBHOOK_SECRET`.

Resend's own scheme (Svix) and SES's (SNS) are not in the `webhook.verify` contract (`ops.md` 1.7.0 section 22), so they need a relay that re-signs, until a contract version adds them.

## The log page

`<mount>` (`/email`) needs `email.read_log`. It lists the latest 100 messages (recipient, subject, template, state, attempts) and the suppressed addresses, never a body. **Allow again** needs `email.manage`.

The default policy (`policies/email.cedar`) grants both actions to the `admin` role, which the app assigns. `email.manage` is sensitive, so every decision on it is audited.

## Owner steps

- Verify the sending domain with the provider: DKIM, SPF, and a DMARC record. Set `from` to an address on that domain.
- Create the provider key (Resend, or an SES IAM user with `ses:SendEmail` only) and set the secrets above.
- Point the provider's bounce and complaint notifications at the relay that signs for `EMAIL_WEBHOOK_SECRET`.

## Tests

- `bun test` in this directory runs the unit tests on SQLite:
  - each adapter's request against a fake;
  - suppression, retries, the bounce path;
  - the bilingual snapshots in `ltr` and `rtl`;
  - `email.before_send`, `reply_to`, and the `auth.send_mail` filler.
- With `RENOX_WORKER_PATH`, `tests/app.test.ts` runs in an app on the worker. It checks the confirmation and welcome emails of a registration, and the log page refused without the role and shown to an admin with no body.
- `examples/shop/tests/email.test.ts` installs the module on the shop.
