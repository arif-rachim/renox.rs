-- Chapter 6: a task belongs to a team. Migrations only move forward, so
-- the column is added here, not written into 001.
alter table app__tasks add column team_id text not null default '';
create index app__tasks_team on app__tasks (team_id, id);
