-- Notifications (#289). Both tables are owned by user_id ([authz.ownership]):
-- every statement of the module goes through db.scoped().
create table notifications__items (
  id         text    primary key,
  user_id    text    not null,
  category   text    not null,
  title      text    not null,
  body       text    not null default '',
  link       text    not null default '',
  read_at    integer,
  created_at integer not null           -- Unix ms
) strict;
create index notifications__items_user on notifications__items (user_id, created_at);

create table notifications__prefs (
  user_id  text    not null,
  category text    not null,
  channel  text    not null,           -- 'inapp' or a configured channel
  enabled  integer not null,
  primary key (user_id, category, channel)
) strict;
