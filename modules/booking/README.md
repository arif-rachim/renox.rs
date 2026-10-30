# booking (#334)

Appointments for salons, clinics and other services:
- **Services and staff**, with weekly and dated hours (Ramadan hours, holidays). Slots are computed in the app's time zone; the UAE has no DST.
- **Holds** that expire.
- **Deposits** paid through `billing`.
- **Cancellation** with a window, and no-shows.
- **Reminders** 24 h and 2 h before, through `email`.
- **A staff calendar** that updates live over the change feed.

## Install

```sh
bunx renox add booking          # needs auth, i18n, billing and email
```

```toml
booking = { version = "^1.0", mount = "/booking", config = { slot_minutes = 15, hold_minutes = 10 } }
```

To set up the catalogue, an admin's app code calls:
- `booking.addService({ id, name, minutes, buffer?, deposit_fils?, cancel_hours? })`
- `booking.addStaff({ id, name, user_id, services })`
- `booking.setHours(staff, weekday | "YYYY-MM-DD", open_min, close_min)`

All three need `booking.manage`.

## Services and events

| Service | What it does |
| --- | --- |
| `slots(service, day, { staff? })` | The free starts of a day: weekly and dated hours, the service's length and buffer, live bookings, and holds not yet expired |
| `hold(service, staff, start, customer)` (also `book`) | Holds the slot. With a deposit it answers `pay_url`, the billing checkout of order `booking:<id>`; paying it confirms the booking. Otherwise `confirm` follows. A taken slot is `TAKEN` |
| `confirm(id)` | Confirms the booking, emits `booking.confirmed`, and queues the reminders |
| `cancel(id)` | Inside the service's `cancel_hours` before the start, a paid deposit is retained. `booking.cancelled` says which; the refund itself is `billing.refund` |
| `noShow(id)` | Marks a confirmed booking whose start has passed |

**No double booking.** The slot search refuses a taken start. A unique index allows one live booking per staff member and start, so the second writer of a race is answered "taken".

**Reminders.** `jobs/reminder.ts` runs are queued at confirmation for 24 h and 2 h before the start. Each kind is sent once (`booking__reminders`), and only while the booking is still confirmed. They go by email to the customer's address in auth's public view. WhatsApp templates are not wired; they are the `whatsapp` module's.

## Pages and roles

| Page | Who | What |
| --- | --- | --- |
| `<mount>?service=&day=` | Signed-in customers | The services, then a day's free slots; a slot holds and confirms, or goes to the deposit checkout |
| `<mount>/mine` | The customer | Their own bookings only, with cancel |
| `<mount>/calendar` | `booking.view_calendar` | The staff member's day |

The calendar's `<mount>/sse/calendar` subscribes the staff member to `calendar:<their staff id>`. `[realtime.feeds]` publishes each committed change of `booking__bookings` there.

Default policy:
- `admin` has `booking.manage` and `booking.view_calendar`;
- `staff` has `booking.view_calendar` and may subscribe to `calendar:*`.

## Not built

- WhatsApp reminders.
- The `org` scope for several branches.
- Classes with capacity.

## Tests

- `bun test` runs the unit tests:
  - slots from weekly and Ramadan hours, buffers, holds that expire;
  - the live-booking index;
  - a deposit confirming the booking and queueing both reminders, each sent once;
  - cancellation inside and outside the window, a reminder after a cancel not sent, and no-shows.
- With `RENOX_WORKER_PATH`, `tests/app.test.ts` runs in an app with billing and email on the worker:
  - a customer books through the page;
  - each customer sees only their own bookings;
  - both reminders are queued at 24 h and 2 h before;
  - two customers racing for one slot get one booking;
  - the calendar is refused without the role;
  - the staff member's open stream receives the next booking.
