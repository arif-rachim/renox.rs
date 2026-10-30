# email (#328)

Transactional email for apps and modules: `email.send({ to, subject, text?, html? })` queues a row in `email__messages` and emits `email.send_requested`; the module's own handler sends it after the commit through **Resend** (`EMAIL_RESEND_KEY`) or **Amazon SES** v2 (`EMAIL_SES_ACCESS_KEY`, `EMAIL_SES_SECRET_KEY`, SigV4 in `lib/core.ts`). A provider 5xx, 429 or network failure throws, so the outbox retries it with backoff; a 4xx is final (`failed`). Addresses that bounced or complained are in `email__suppressions` and are never sent to again; the bounce/complaint relay posts to `functions/webhooks/feedback.ts` with a generic HMAC signature (`EMAIL_WEBHOOK_SECRET`). The module fills `notifications.deliver` for the `email` channel. Bodies are never logged.

Not here yet: SMTP (the isolate has no raw sockets; use a provider's HTTP API), templates rendered through the platform renderer, and the provider-native signature schemes (Resend's svix, SNS) on the feedback route.
