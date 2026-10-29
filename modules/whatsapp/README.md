# whatsapp

The WhatsApp Cloud API for a Renox app (`docs/18-build-plan.md` M15; `docs/21-uae-gcc-strategy.md`). It covers notifications, one-time codes, approved templates, a signed inbound webhook into a light inbox, and a chat-to-order link. The module calls only `graph.facebook.com`, and the platform's fetch rules apply: the allowlist, DNS resolved in Rust, private ranges blocked.

## Setup with Meta (owner steps)

1. In Meta for Developers, create an app of type **Business**, then add the **WhatsApp** product.
2. Under WhatsApp > API Setup, add and verify the business phone number. Note its **Phone number ID**.
3. Create a **System User** in Business Settings, assign it the app with `whatsapp_business_messaging`, and generate a permanent **access token**.
4. Note the app's **App Secret** (App Settings > Basic). Choose a random **verify token** of your own.
5. Store the four secrets in the app:

   ```
   renox secrets set WHATSAPP_TOKEN <system user token>
   renox secrets set WHATSAPP_PHONE_ID <phone number id>
   renox secrets set WHATSAPP_VERIFY_TOKEN <your verify token>
   renox secrets set WHATSAPP_APP_SECRET <app secret>
   ```

6. Under WhatsApp > Configuration, set the **callback URL** to `https://<your host><mount>/webhook/whatsapp` (for example `https://shop.example/whatsapp/webhook/whatsapp`) and the verify token from step 4. Subscribe to the `messages` field.
7. Submit the templates you will send (order updates, an authentication template for codes) and wait for approval. Business-initiated messages outside the 24-hour window must be templates.

## Install

```toml
[modules]
notifications = { version = "^1.0", mount = "/notifications", config = { channels = "whatsapp" } }
whatsapp = { version = "^1.0", mount = "/whatsapp", config = { otp_template = "login_code", otp_language = "en" } }
```

whatsapp fills `notifications.deliver` and `auth.send_otp`, so `notifications` and `auth` must be installed with it (`manifest.md` MF8). `renox add whatsapp` asks to approve:

- the single network host `graph.facebook.com`;
- the four secrets;
- the two hooks.

| Config | Default | Meaning |
| --- | --- | --- |
| `api_version` | `v21.0` | The Graph API version |
| `sends_per_minute` | 60 | Outgoing messages per minute for the tenant; past it, the send services reject |
| `otp_template` | `""` | An approved authentication template with one parameter, the code. When empty, codes go as plain text, which works only inside a 24-hour window |
| `otp_language` | `en` | That template's language |

## Services

| Service | Result |
| --- | --- |
| `send(to, text)` | `{ id }`. Queues a text |
| `sendTemplate(to, name, params, language?)` | `{ id }`. Queues an approved template. A template recorded as `pending`, `rejected` or `paused` in `whatsapp__templates` is refused |
| `sendOtp(phone)` | `{ sent: true, expires_in: 300 }`, the same answer for every valid phone. Another call within 30 s sends nothing new |
| `verifyOtp(phone, code)` | `{ ok }`. A code is 6 digits, lasts 5 minutes, allows 5 attempts and works once. A wrong, expired, used or exhausted code, an unknown phone and a malformed code all give `{ ok: false }` |
| `linkPhone(userId, phone)` | `{ ok }`. Makes the phone the user's WhatsApp contact, but only within 10 minutes after `verifyOtp` succeeded for it |
| `inbox({ phone?, direction?, limit? })` | Messages newest first. An OTP's body shows as `[otp]` |
| `chatLink(phone, text)` | `{ url }`, a `wa.me` link with a prefilled message |

Phones are E.164 (`+9715…`). Spaces, dashes and a leading `00` are accepted.

**Sending never blocks a request.**

- A send service writes a row of `whatsapp__messages` and emits `whatsapp.send_requested`, in the request's transaction.
- After the commit, the outbox runs the module's own handler, which calls the Cloud API.
- A 5xx, a 429 or a network failure makes the handler throw, so the outbox retries it with its backoff.
- A 4xx marks the message `failed` for good.
- Status webhooks move a sent message to `delivered`, `read` or `failed`, never backwards.

**One-time codes.**

- `whatsapp__otp` keeps an HMAC of the code (keyed with `WHATSAPP_APP_SECRET`), never the code.
- The queued message carries the code sealed with AES-GCM under a key derived from the same secret.
- Its body is cleared once the message is sent or fails.

## Webhook

The webhook is at `<mount>/webhook/whatsapp`.

- `GET` is Meta's verification handshake. It answers `hub.challenge` when `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`, else 403.
- `POST` carries inbound messages and status updates. `X-Hub-Signature-256` is checked against the raw body with `WHATSAPP_APP_SECRET`, in constant time. A missing or wrong signature is 401 and stores nothing.
- An inbound message is stored once (by its `wa_id`) and emits `whatsapp.message_received`.
- The gateway's body limit applies, as for every function route.

## auth's codes

whatsapp fills `auth.send_otp` (#291). auth's phone sign-in and phone verification send their codes as OTP messages, sealed in the queue like the module's own. auth keeps its codes and their checks, and whatsapp only delivers them.

## Notifications

As the `notifications.deliver` filler, the module sends the item's title, body and link to the user's linked phone, for the channel `whatsapp`. A user without a linked phone gets nothing on WhatsApp. When auth exposes verified phones (#291), they replace `whatsapp__contacts`.

## Chat to order

`partials/chat-to-order.html` is a `wa.me` button. No module exposes a `product.actions` slot yet, so the app includes the partial where it wants the button. It sets `wa_order` in the page data:

```ts
import { whatsapp } from "renox:modules";

export async function load({ params }) {
  return { wa_order: await whatsapp.chatLink("+971501234567", `I would like product #${params.id}`) };
}
```

## Hooks and events

- `whatsapp.sms_fallback` (`{ to, text }`): declared for F7, unfilled.
- `whatsapp.send_requested`: the queue.
- `whatsapp.message_received` (`{ message_id, from }`).

## Tests and the fake API

Tenant `fetch` refuses private addresses, so the worker cannot reach a fake Cloud API on localhost. The tests are split in two:

- **`tests/cloud-api.test.ts`** runs the client and the send handler in the test process against a fake Cloud API (`fakeApi()`) and an in-memory copy of the schema. It covers:
  - the request shapes and the bearer token;
  - a 5xx that throws (the outbox retries it) and a 4xx that is final;
  - the webhook signature;
  - parsing, and statuses only moving forward;
  - the sealed code.
- **`tests/whatsapp.test.ts`** runs on the worker through `renox test`, with test secrets from `tests/app/.env.test`. It covers:
  - the handshake, and a wrong or missing signature refused with nothing stored;
  - the inbox;
  - a template queued at once and carried by the outbox;
  - the OTP flow, with a known code planted in the file: the same answer for every phone, attempts, expiry, single use, and no code at rest;
  - the `notifications.deliver` filler;
  - the per-minute limit;
  - the chat link;
  - no token or secret in the logs or the database file.
