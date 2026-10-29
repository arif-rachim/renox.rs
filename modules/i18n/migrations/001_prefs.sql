-- Stored locale choices (#244): `user:<auth user id>` when the caller
-- passes the user, else `session:<page session id>`.
create table i18n__prefs (
  subject text primary key,
  locale text not null,
  updated_at integer not null
);
