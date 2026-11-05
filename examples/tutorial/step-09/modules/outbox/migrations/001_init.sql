create table outbox__mail (
  id         integer primary key,
  mail_to    text    not null,
  template   text    not null,
  url        text    not null,
  org_name   text    not null,
  created_at integer not null
) strict;
