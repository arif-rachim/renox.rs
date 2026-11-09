-- Jobs and scheduling: a job is one piece of work for a customer at a site,
-- from an approved quotation or created directly. Jobs and their events belong
-- to one branch (branch_id) and are fenced by db.scoped() (renox.toml
-- [authz.ownership]); each table repeats branch_id so it carries its own rule.

-- A branch is found in the URL of its dispatch socket by its slug (`dubai`),
-- the part of the branch id after `br_`. The guard of that route loads the
-- branch by this column (renox.toml [authz.entities], `id = "slug"`).
alter table app__branches add column slug text;
update app__branches set slug = substr(id, 4) where slug is null;
create unique index app__branches_slug on app__branches (slug);

-- Numbers J-000001, J-000002, ... are company-wide and never reused, as the
-- quotation numbers are: not an owned table.
create table app__job_numbers (
  n integer primary key autoincrement,
  job_id text not null
);

-- scheduled_start and scheduled_end are unix seconds. booking_id is the
-- `booking` module's booking of the visit (`bk_...`); no foreign key: the
-- table belongs to the module.
create table app__jobs (
  id text primary key,
  branch_id text not null references app__branches (id),
  customer_id text not null references app__customers (id),
  site_id text not null references app__sites (id),
  quote_id text references app__quotes (id),
  number text not null unique,
  status text not null default 'new' check (status in ('new', 'scheduled', 'en_route', 'in_progress', 'done', 'invoiced', 'cancelled')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  service_id integer not null references app__services (id),
  description text not null default '',
  scheduled_start integer,
  scheduled_end integer,
  technician_user_id text,
  booking_id text,
  created_by text not null,
  created_at integer not null,
  updated_at integer not null
);
create index app__jobs_branch on app__jobs (branch_id, status);
create index app__jobs_technician on app__jobs (technician_user_id, scheduled_start);
-- One live job per quotation (a cancelled job frees it).
create unique index app__jobs_quote on app__jobs (quote_id) where quote_id is not null and status != 'cancelled';

-- The timeline of a job: every status change and the other things that happen
-- to it (scheduled, reassigned).
create table app__job_events (
  id integer primary key autoincrement,
  job_id text not null references app__jobs (id),
  branch_id text not null references app__branches (id),
  at integer not null,
  by_user_id text,
  from_status text,
  to_status text,
  note text not null default ''
);
create index app__job_events_job on app__job_events (job_id, id);

-- The branch's working hours, in minutes from local midnight; weekday 0 is
-- Sunday. lib/booking-sync.ts gives them to `booking` for each technician.
create table app__branch_hours (
  branch_id text not null references app__branches (id),
  weekday integer not null check (weekday between 0 and 6),
  open_min integer not null,
  close_min integer not null check (close_min >= open_min),
  primary key (branch_id, weekday)
);

-- What lib/booking-sync.ts has already handed to `booking`: `booking`
-- inserts a row of hours at every setHours call, so each branch and each
-- technician is registered once.
create table app__booking_sync (
  key text primary key,
  at integer not null
);
