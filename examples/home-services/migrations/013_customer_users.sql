-- Customer identity (#774): a person who signs in with their phone is tied to
-- their customer records, one per branch with the same phone. `user_id` is the
-- auth user (no foreign key: auth__* belongs to the auth module); it is set by
-- lib/portal.ts when it links a phone-only user. app__customer_users records
-- the link once: the user and the phone it was made for.
alter table app__customers add column user_id text;
create index app__customers_user on app__customers (user_id);

create table app__customer_users (
  user_id    text primary key,
  phone      text not null,
  created_at integer not null
);
