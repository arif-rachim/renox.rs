-- The whatsapp module (#290).
create table whatsapp__templates (
  name     text not null,
  language text not null,
  status   text not null default 'approved' check (status in ('approved', 'pending', 'rejected', 'paused')),
  body     text not null default '',
  primary key (name, language)
) strict;

create table whatsapp__messages (
  id         text    primary key,
  direction  text    not null check (direction in ('in', 'out')),
  kind       text    not null check (kind in ('text', 'template', 'otp')),
  wa_id      text    unique,                  -- the Cloud API's message id
  phone      text    not null,                -- E.164
  body       text    not null default '',     -- text; a template's JSON; an OTP's sealed code until it is sent, then ''
  status     text    not null check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),
  error      text,
  attempts   integer not null default 0,
  at         integer not null,                -- Unix ms
  updated_at integer not null
) strict;
create index whatsapp__messages_phone on whatsapp__messages (phone, at);
create index whatsapp__messages_out on whatsapp__messages (direction, at);

create table whatsapp__otp (
  phone       text    primary key,
  code_hash   text    not null,               -- HMAC-SHA-256, never the code
  expires_at  integer not null,               -- Unix ms
  attempts    integer not null default 0,
  created_at  integer not null,
  verified_at integer
) strict;

create table whatsapp__contacts (
  user_id     text    primary key,
  phone       text    not null,
  verified_at integer not null
) strict;
