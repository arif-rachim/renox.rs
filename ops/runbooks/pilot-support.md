# Pilot support

The runbook for the first weeks of a pilot company on the `home-services` app (`docs/reference-app.md`, "Onboarding a pilot"). It needs no tooling beyond the `renox` CLI and the app's own pages. Every command below is in `cli/README.md` or the CLI's `--help`; run them from the pilot app's folder, or add `--app <name>`.

## Who answers what

| Question | Where to look | Who |
| --- | --- | --- |
| How do I do X in the app (quote, job, invoice, contract)? | `docs/reference-app.md`, "The flow, end to end" and "Roles" | The company's owner first, then us |
| Someone cannot sign in | "Someone cannot sign in" below; `/admin/people` | The company's owner, then us |
| A page shows an error | "A page shows an error" below | Us |
| WhatsApp messages do not arrive | "WhatsApp messages do not arrive" below | Us, with the company's Meta Business account owner for template approval |
| A wrong import, or data deleted by mistake | "Undo a mistake" and "A wrong import" below | Us, with the owner's decision |
| Email (invitations, nightly summary) does not arrive | `/admin/settings` (sender name, accounts email), the `email` module's `from` and the provider's sending-domain status | Us |
| A custom domain does not work | `renox domains status <hostname>`; `docs/12-developer-experience.md` | Us |
| The platform is down or slow | `ops/single-host.md` | The platform owner |
| Invoices, VAT, the company's TRN | Their accountant; `tax_gcc` config in `renox.toml` | The company |
| Price, contract, offer terms | Not a support question | The platform owner |

## Read a tenant's logs

```sh
renox logs                         # the last 100 lines
renox logs --since 30m             # 30s, 10m, 2h, 1d, or Unix milliseconds
renox logs --follow                # keep streaming
renox logs --source server         # all | server | client (browser errors)
renox logs --deployment <hash>     # one deployment
renox logs --json                  # one raw JSON line per entry
renox logs --raw
```

A plain line is `time level [browser] module message (request id)`. `renox logs` has no filter flags of its own: filter with the shell.

```sh
renox logs --since 1d | grep '<request id>'            # everything one request logged
renox logs --since 1d --json | grep RENOX_RENDER_LIMIT  # by error code
renox logs --since 2h | grep -i ' error '              # by level
```

Secrets never reach the logs. If a line shows a value that looks like one, stop and report it as a security issue.

## A page shows an error

1. The error page prints the status, a message and a line `<CODE> · request id <id>`. Ask the user for the line or a screenshot.
2. Find the request: `renox logs --since 1d | grep '<request id>'`. The line with the cause (the stack is redacted) is the one to read.
3. Look the code up in `docs/contracts/errors.md`, section 3, "Catalogue". The five most likely:

| Code | Status | Meaning here | First move |
| --- | --- | --- | --- |
| `RENOX_FORBIDDEN` | 403 | A policy denied the action: the role may not do it, or a sensitive action needs a recent second factor | Check the person's role on `/admin/people`; ask them to confirm the second factor at `/2fa/verify` and retry |
| `RENOX_INTERNAL` | 500 | The page's code threw | Read the logged cause and stack; escalate with the request id |
| `RENOX_RENDER_LIMIT` | 500 | A page template ran out of fuel, iterations or output, usually a very long list | Note which page and how many rows; escalate (the page must paginate) |
| `RENOX_CSRF` | 403 | A form was submitted from a stale page | Reload the page and try again; if it repeats on a fresh page, escalate |
| `RENOX_CPU_LIMIT` or `RENOX_DEADLINE` | 503 / 504 | The request used too much CPU or took too long, often a large report or import | Narrow the date range or split the file; escalate if it repeats |

Others you may meet: `RENOX_DB_QUOTA` (the free tier's database is full: writes fail, reads work), `RENOX_BUSY` and `RENOX_UNAVAILABLE` (try again in a minute; if it persists, the platform's side, `ops/single-host.md`), `RENOX_TENANT_SUSPENDED` (billing or abuse hold on the tenant).

## WhatsApp messages do not arrive

1. **The outbox page.** `/admin/whatsapp` (the owner) shows the last 50 messages the app sent: time, recipient (last four digits), template or text, status. Filter it with `?status=failed`, or with `?phone=` and the customer's number. A message that is not in the list was never queued (the customer has no phone, or the action did not send one); `queued` that stays queued points to the provider or the secrets (below); `failed` is final. The page does not show the provider's failure reason yet (#771): for that, use the logs as in step 4.
2. **The sandbox flag.** In `renox.toml` the `whatsapp` module's `config = { sandbox = true }` records every message as sent and calls no API. With it on, nothing reaches a phone by design. Going live is `sandbox = false` and `renox deploy`.
3. **The secrets.** `renox secrets list` must show `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET`. A missing one is set with `renox secrets set <NAME>` (the value comes from stdin); then deploy again.
4. **The logs.** Search around the time of the action: `renox logs --since 2h | grep -i whatsapp`. A 5xx or 429 from the provider is retried by the outbox with backoff; a 4xx is final and is logged with its reason.
5. **The provider's template status.** In Meta's WhatsApp Manager, each of the nine templates (`quote_sent`, `visit_scheduled`, `technician_on_the_way`, `report_ready`, `invoice_due`, `amc_renewal`, `booking_received`, `visit_moved`, `visit_cancelled`) must be approved in the customer's language. A template that is pending, rejected or has a different parameter count fails.
6. **The customer.** A customer with no phone gets the email instead; a phone must be a valid UAE number (stored as `+971...`).
7. **`public_url`** in `app__settings` must be the app's real address, or links in the messages are wrong.

## Someone cannot sign in

1. **Invitation.** `/admin/people`, "Pending invitations": is the person's email there? An invitation expires after 7 days, works once and only for the address it was sent to. Send a new one with the right email. "The invitation was refused" means the person is already a member.
2. **Role.** In the staff table the person must have a role. A member with no role signs in and sees nothing. Set one with "Set role".
3. **Second factor.** The "Second factor" column shows whether it is on. A user who lost their device first uses one of their recovery codes (each works once). With no device and no recovery code left, the owner resets it: on `/admin/people`, "Reset second factor" on the person's row, then confirm. The owner needs a recent second factor of their own (an owner without one gets 403; sign in again with the code), and reaches only the people of the branch that is active (switch branch first for someone in another branch). The person's authenticator, passkeys and recovery codes are deleted, they get a notice ("Your second factor was reset by …") in the app, by WhatsApp when their number is linked, and by email, and their next sign-in asks them to set it up again. Each reset is a `twofa.reset` row on `/admin/audit` (who reset whom). An owner cannot reset their own second factor this way; an owner who lost both device and codes is an escalation (see "Escalate"), and never a database edit.
4. **Password or email.** The sign-in page's reset link; check that the `email` module's `from` is set and the sending domain is verified, or the reset mail never leaves.

## Undo a mistake

Never restore in place. Restore into a new app, check it, then decide.

1. Find the last good time (ISO 8601 with a zone, or Unix milliseconds), for example from the audit trail at `/admin/audit` or the logs.
2. Restore into a new app:

```sh
renox db restore --at 2026-11-12T09:30:00+04:00 --as acme-fm-restore
```

A time that no backup generation covers is refused (`RENOX_RESTORE_POINT_UNKNOWN`) and nothing is created.

3. Open the new app and check the rows that were wrong. You can also download its database: `renox db export --app acme-fm-restore --out restore.db`.
4. Decide with the owner: usually copy the few rows back by hand through the app's pages, because restoring replaces everything done after that time. If they want to switch to the restored copy as a whole, that is an escalation (domain and secrets move), not a command here.
5. Remove the copy when done: `renox apps rm acme-fm-restore`.

## An import stays "Checking" or ends "Failed"

The check and the import run as background jobs; the import's page reloads itself until they are done.

- **Failed, "This is not an Excel .xlsx file."** The file is not a workbook (a `.xls`, a renamed file, a broken download). Save it again from Excel as `.xlsx` and upload again.
- **Failed, "too large to check on the current plan".** A job has the CPU of one request on the free tier (50 ms): about 900 customer rows to check and about 250 to import per file. Split the file and import the parts one after another. A larger job budget is an open decision (#768).
- **Still "Checking" or "Importing" after a minute.** The job did not run: `renox logs --since 1h | grep -i import` shows its attempts. A first attempt that fails is retried about 10 seconds later, and the retry ends the import as failed; an import left working for longer is an escalation (see "Escalate").

## A wrong import

An import cannot be undone from `/admin/import`. If a wrong file was committed:

1. Note the time of the commit (the "last imports" list on `/admin/import`, or `/admin/audit`, row `import.committed`).
2. Restore to the minute before it into a new app, as in "Undo a mistake".
3. Look at what was entered in the real app after that minute (jobs, quotations, invoices). If nothing, the owner may prefer to work in the restored app; otherwise fix the rows by hand. Re-importing the corrected file adds only what is not there (`exists` rows are skipped), and an existing service code is updated.

## Escalate

Before filing an issue collect:

- the app name (`renox apps list`) and the person's role;
- the time, with the time zone, of what went wrong;
- the request id from the error page, and `renox logs --since 1d | grep '<request id>'`;
- the page address and what the person did just before;
- a screenshot of the page, error line included;
- for a data problem, the time of the last good state.

Never put a secret, a token, a password or a customer's personal data into an issue.
