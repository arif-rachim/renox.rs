-- Rooms and the members of private rooms (#282). Two rooms to start with:
-- `general` (open to every signed-in user) and `team` (members only).
create table app__rooms (
  id      text    primary key,          -- the URL segment and the topic room:<id>
  name    text    not null,
  private integer not null default 0
) strict;

create table app__members (
  room_id text not null references app__rooms (id),
  user_id text not null,
  primary key (room_id, user_id)
) strict;

insert into app__rooms (id, name, private) values ('general', 'General', 0), ('team', 'Team', 1);
