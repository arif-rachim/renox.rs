-- The booking module (#334). Times are Unix ms; `day` keys and hours are
-- local to the tenant's offset (hours as minutes from local midnight).
create table booking__services (
  id         text    primary key,
  name       text    not null,
  minutes    integer not null check (minutes between 5 and 600),
  buffer     integer not null default 0
) strict;

create table booking__staff (
  id    text primary key,
  name  text not null
) strict;

create table booking__staff_services (
  staff_id   text not null references booking__staff (id),
  service_id text not null references booking__services (id),
  primary key (staff_id, service_id)
) strict;

-- Weekly hours (weekday 0 = Sunday) and dated exceptions (Ramadan hours, holidays: open = close = 0).
create table booking__hours (
  staff_id  text    not null references booking__staff (id),
  weekday   integer check (weekday between 0 and 6),
  day       text,                               -- YYYY-MM-DD for an exception, else null
  open_min  integer not null,
  close_min integer not null
) strict;

create table booking__bookings (
  id          text    primary key,
  service_id  text    not null,
  staff_id    text    not null,
  customer    text    not null,
  start_at    integer not null,
  end_at      integer not null,
  status      text    not null check (status in ('held', 'confirmed', 'cancelled')),
  expires_at  integer,
  created_at  integer not null
) strict;
create index booking__bookings_staff on booking__bookings (staff_id, start_at);
