-- The company's settings: branding and the accounts address. One row per key.
create table app__settings (
  key text primary key,
  value text not null
);

insert into app__settings (key, value) values
  ('brand_name', 'Home Services'),
  ('brand_logo_key', ''),
  ('brand_color', '#e8634a'),
  ('brand_footer_en', ''),
  ('brand_footer_ar', ''),
  ('accounts_email', ''),
  ('whatsapp_sandbox', '1');

-- A branch of the company. Each branch is an `org` organisation (org_id).
create table app__branches (
  id text primary key,
  org_id text not null unique,
  name_en text not null,
  name_ar text not null,
  phone text not null default '',
  address text not null default '',
  emirate text not null default '',
  area text not null default '',
  created_at integer not null
);
