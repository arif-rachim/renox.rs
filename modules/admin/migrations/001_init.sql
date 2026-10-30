-- The admin module (#335): its settings (the dashboard's notes, a pinned
-- message); everything else is read through the other modules.
create table admin__settings (
  key        text    primary key,
  value      text    not null,
  updated_at integer not null
) strict;
