-- The technician's visit (F7-123): one visit per job, opened by the check-in.
-- Photos, parts and the drawn signature belong to it. Each table repeats the
-- branch_id of its job so it carries its own ownership rule (renox.toml
-- [authz.ownership]).
--
-- checkin_lat and checkin_lng are the browser's position, when the technician
-- allowed it. summary_en and summary_ar are the report's two-sentence summary:
-- drafted by `ctx.ai` at check-out (empty when no AI is configured) and
-- editable until the report is sent. signature_key and report_key are keys in
-- the platform store (`visits/<visit id>/...`); report_key is the PDF in the
-- customer's language.
create table app__visits (
  id text primary key,
  branch_id text not null references app__branches (id),
  job_id text not null unique references app__jobs (id),
  technician_user_id text not null,
  checkin_at integer not null,
  checkin_lat real check (checkin_lat is null or checkin_lat between -90 and 90),
  checkin_lng real check (checkin_lng is null or checkin_lng between -180 and 180),
  checkout_at integer,
  notes text not null default '',
  summary_en text not null default '',
  summary_ar text not null default '',
  signature_key text,
  signed_by_name text not null default '',
  report_key text
);
create index app__visits_technician on app__visits (technician_user_id, checkin_at);

-- file_key is the stored photo; width and height (null until known) let
-- `<x-image>` emit its dimensions without a storage call per render.
create table app__visit_photos (
  id integer primary key autoincrement,
  branch_id text not null references app__branches (id),
  visit_id text not null references app__visits (id),
  phase text not null check (phase in ('before', 'after')),
  file_key text not null,
  caption text not null default '',
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  created_at integer not null
);
create index app__visit_photos_visit on app__visit_photos (visit_id, id);

create table app__visit_parts (
  id integer primary key autoincrement,
  branch_id text not null references app__branches (id),
  visit_id text not null references app__visits (id),
  description text not null check (length(description) between 1 and 200),
  qty real not null check (qty > 0),
  unit_price_fils integer not null check (unit_price_fils >= 0)
);
create index app__visit_parts_visit on app__visit_parts (visit_id, id);
