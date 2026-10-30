-- OAuth 2.1 for agents (#286): registered public clients, single-use
-- authorization codes, and agent tokens. Codes and tokens are stored as
-- SHA-256 only.
create table auth__oauth_clients (
  client_id     text primary key,
  client_name   text not null,
  redirect_uris text not null,          -- JSON array
  created_at    integer not null
);

create table auth__oauth_codes (
  code_hash      text primary key,
  client_id      text not null references auth__oauth_clients (client_id),
  user_id        text not null references auth__users (id),
  redirect_uri   text not null,
  code_challenge text not null,          -- PKCE S256
  scopes         text not null,          -- JSON array
  expires_at     integer not null,
  used_at        integer
);

create table auth__agent_tokens (
  id           text primary key,
  token_hash   text not null unique,
  user_id      text not null references auth__users (id),
  client_id    text not null,
  client_name  text not null,
  scopes       text not null,            -- JSON array
  created_at   integer not null,
  expires_at   integer not null,
  last_used_at integer,
  revoked_at   integer
);
create index auth__agent_tokens_user on auth__agent_tokens (user_id);
