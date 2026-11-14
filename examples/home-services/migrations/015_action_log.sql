-- The visit page's action log (#806, wave C): one row per mutating visit action
-- that carried an `action_id` (lib/action-log.ts). A second post with the same
-- id and the same user is answered from the row (status and result) and changes
-- nothing; the same id from another user is a 409. `result` is the JSON the
-- device was answered, at most 4 KiB. `created_at` is the server's receive time
-- (unix seconds); jobs/action-log-sweep.ts deletes rows older than 30 days.
-- Not an owned table: it is found by its id, which only its user may replay.
create table app__action_log (
  action_id text primary key,
  user_id text not null,
  visit_job_id text not null,
  action text not null,
  status integer not null,
  result text not null check (length(result) <= 4096),
  created_at integer not null
);
create index app__action_log_user on app__action_log (user_id, created_at);
