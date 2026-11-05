-- The board's tasks. Every table of the app starts with app__.
create table app__tasks (
  id         integer primary key,
  title      text    not null,
  done       integer not null default 0,
  created_at integer not null
) strict;
