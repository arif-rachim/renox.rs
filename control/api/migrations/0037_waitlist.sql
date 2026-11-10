-- The site's waitlists (deploy-api.md 0.10 section 21, #691): one row per
-- address and list, double opt-in. `email` is lower-cased. `confirm_token_hash`
-- is the SHA-256 of the emailed token (the token itself is never stored) and is
-- cleared when the link is used, so it works once. `confirm_sent_at` is when the
-- last confirmation mail left: it limits a re-send to one per hour and starts
-- the token's 7 days. `ip_hash` is a SHA-256 of the client address, never the
-- address. The table belongs to no tenant.
create table waitlist (
  id bigserial primary key,
  email text not null,
  interest text not null check (interest in ('connector', 'email')),
  locale text not null default 'en' check (locale in ('en', 'ar')),
  created_at bigint not null,
  confirmed_at bigint,
  confirm_token_hash text,
  confirm_sent_at bigint not null,
  ip_hash text,
  source text not null default 'site',
  unique (email, interest)
);
create index waitlist_confirm_token on waitlist (confirm_token_hash) where confirm_token_hash is not null;
create index waitlist_confirmed on waitlist (interest, confirmed_at) where confirmed_at is not null;
