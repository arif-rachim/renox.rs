# billing (#329)

Payments for an app's own customers:
- plans and subscriptions;
- one-off checkouts, one per order;
- invoices, refunds and metered usage;
- a PSP adapter, with Stripe UAE first and the GCC providers in #330;
- Stripe's webhooks, verified by the platform.

Amounts are integers in minor units (fils for AED). Card data never reaches the app: the customer pays on the provider's page.

## Install

```sh
bunx renox add billing                                   # needs auth and i18n
bunx renox secrets set BILLING_STRIPE_KEY sk_live_…      # or sk_test_… while testing
bunx renox secrets set BILLING_WEBHOOK_STRIPE_SECRET whsec_…
```

```toml
billing = { version = "^1.0", mount = "/billing", config = { currency = "AED", success_url = "/orders", cancel_url = "/cart" } }
```

In the Stripe dashboard, point a webhook endpoint at `https://<app host>/billing/webhooks/stripe`. Send it these events:
- `checkout.session.completed`
- `invoice.finalized`
- `invoice.paid`
- `invoice.payment_failed`
- `payment_intent.payment_failed`
- `customer.subscription.deleted`
- `charge.refunded`

## Services

| Service | What it does |
| --- | --- |
| `createPlan({ id, name, amount, interval })`, `plans()` | Define and list plans; `interval` is `month` or `year` |
| `createCheckout({ order_id, customer_id, plan_id })` or `({ order_id, customer_id, amount, description })` | A subscription, or a one-off payment. One checkout per `order_id`: asking again for an open session answers the same session (`reused: true`, no second charge); a paid order is `CONFLICT`. `billing.fraud_signal` runs first |
| `checkout(customer_id, plan_id)` | A subscription checkout whose order is the customer and the plan |
| `getSubscription(customer_id)`, `listInvoices(customer_id)` | Read a customer's state |
| `recordUsage(customer_id, metric, quantity)`, `usage(customer_id, metric, since)` | Metered usage |
| `refund(invoice_id, amount)` | Needs `billing.refund`. Never more than was paid less what was already refunded; the PSP call is idempotent |

Errors are `BillingError` with a code: `INVALID`, `NOT_FOUND`, `NOT_CONFIGURED`, `PSP`, `CONFLICT` or `REFUSED`.

## Events and hooks

| Name | Kind | What it means |
| --- | --- | --- |
| `billing.checkout_completed` | event | A checkout was paid |
| `billing.payment_received` | event | Money arrived for an invoice |
| `billing.payment_failed` | event | A payment failed; the subscription is now `past_due`. Dunning emails are the app's handler of this event (through `email.send`) |
| `billing.invoice_issued` | event | The PSP issued an invoice; tax-gcc numbers its tax invoice from this (#331) |
| `billing.invoice_paid`, `billing.subscription_changed`, `billing.refunded` | events | Self-explanatory |
| `billing.fraud_signal` | hook point | Receives `{ customer_id, order_id, amount, currency, mode }` before a checkout session is created. A halt refuses the checkout; the card-testing limits are #123 |

The public view `billing__public_user_plans_v1` (`user_id`, `plan_id`, `status`, `current_period_end`) is what other modules read a user's plan through.

## Pages and roles

| Page | Who | What it shows |
| --- | --- | --- |
| `<mount>` | Signed-in users | The plans, the user's subscription and invoices, and **Subscribe** |
| `<mount>/invoices` | Needs `billing.manage` | Every invoice |
| Refund form | Needs `billing.refund` (`r-can`) | Shown on the invoices page |

The default policy (`policies/billing.cedar`):
- `admin` holds both actions;
- `finance` holds `billing.manage` only.

`billing.refund` is sensitive, so every decision on it is audited.

## The adapter

`lib/adapter.ts` defines the adapter interface:
- `createSession`: Stripe's call carries the idempotency key `checkout:<order_id>`;
- `capture`;
- `refund`;
- `parseWebhook`, which normalises the provider's events.

#330 adds the GCC providers behind the same interface.

## Owner steps

- A Stripe account, and the live and test keys.
- The webhook endpoint and its signing secret.
- 3DS left on, which is Stripe's default.

## Tests

- `bun test` runs the unit tests on SQLite, with the PSP replaced by a recording stand-in:
  - the Stripe requests, from recorded fixtures;
  - one checkout per order, and the double click;
  - `billing.fraud_signal`;
  - refunds and their limits;
  - every webhook path.
- With `RENOX_WORKER_PATH`, `tests/app.test.ts` runs in an app on the worker:
  - a bad signature gets 401, and a replay is answered `duplicate`;
  - the customer's page;
  - the invoices page per role (none, finance, admin).
- `examples/shop` has the module installed.
