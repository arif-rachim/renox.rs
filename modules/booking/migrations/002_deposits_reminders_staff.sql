-- The booking module (#334): deposits and the cancellation window per
-- service, the staff member's user (their calendar), no-shows, reminders
-- sent once, and one live booking per staff member and start (the second
-- writer of a race gets a constraint error, never a double booking).
alter table booking__services add column deposit_fils integer not null default 0;
alter table booking__services add column cancel_hours integer not null default 24;
alter table booking__staff add column user_id text;
alter table booking__bookings add column deposit_order text;
alter table booking__bookings add column no_show_at integer;
create unique index booking__bookings_live on booking__bookings (staff_id, start_at) where status != 'cancelled';

create table booking__reminders (
  booking_id text    not null references booking__bookings (id),
  kind       text    not null check (kind in ('24h', '2h')),
  sent_at    integer not null,
  primary key (booking_id, kind)
) strict;
