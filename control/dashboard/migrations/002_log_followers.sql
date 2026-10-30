-- Open live Logs pages (#307): one row per SSE connection of /sse/logs.
-- The follower job (jobs/log-follower.ts) reads new lines for the row's app
-- with the row's session token and publishes them to the row's topic; the
-- connection's close deletes the row, which stops the job. `topic` holds
-- 128 random bits, so a topic name is never guessable or shared.
create table app__log_followers (
  topic text primary key,
  conn_id text not null,
  session_id text not null,
  app text not null,
  filters text not null,
  since integer not null,
  started_at integer not null
) strict;
create index app__log_followers_conn on app__log_followers (conn_id);
