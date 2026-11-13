-- Self-booking on /book (#775). Where a job came from: made by staff, booked by
-- the customer on /book, made for a maintenance contract (jobs/amc-visits.ts)
-- or by an agent (the App MCP tool create_job).
alter table app__jobs add column source text not null default 'staff' check (source in ('staff', 'self_booking', 'contract', 'agent'));

-- Whether /book offers the service (editable on /services); on by default.
alter table app__services add column self_booking integer not null default 1 check (self_booking in (0, 1));

-- A booking a visitor made on /book before they confirmed it with their
-- WhatsApp code: the slot is held in `booking` (hold_id) until expires_at
-- (unix seconds, the hold's own expiry); /book/confirm/<id> turns it into a
-- job, and jobs/booking-drafts.ts releases the hold and deletes the row once
-- it expired. Not an owned table: it is found by its random id, and its phone
-- must be the signed-in user's. ip_hash is the sha256 of the client address
-- (never the address itself).
create table app__booking_drafts (
  id text primary key,
  service_id integer not null,
  emirate text not null,
  area text not null,
  address text not null,
  makani text,
  slot_start integer not null,
  slot_end integer not null,
  technician_user_id text not null,
  branch_id text not null,
  hold_id text,
  name text not null,
  phone text not null,
  language text not null,
  notes text not null default '',
  ip_hash text not null default '',
  created_at integer not null,
  expires_at integer not null
);
create index app__booking_drafts_phone on app__booking_drafts (phone, expires_at);
create index app__booking_drafts_expiry on app__booking_drafts (expires_at);

-- One row per draft made, by the hashed client address: the limit of 5 drafts
-- an hour per address counts these (a confirmed draft is deleted; its row
-- here stays). jobs/booking-drafts.ts deletes the rows older than a day.
create table app__booking_draft_log (
  id integer primary key autoincrement,
  ip_hash text not null,
  created_at integer not null
);
create index app__booking_draft_log_ip on app__booking_draft_log (ip_hash, created_at);
