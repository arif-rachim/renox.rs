-- Custom domains through Cloudflare for SaaS (#419, ADR D25; deploy-api.md
-- 0.6 section 10). Cloudflare proves ownership with its own pre-validation
-- TXT record, issues and renews the edge certificate and serves the hostname
-- through the tunnel's fallback origin. The control plane keeps the claim
-- (one owner, the 30-day hold, the route mirror) and the custom hostname's
-- id and last reported status; it stores no certificate, no key and no ACME
-- account any more, and no TXT token of its own.

drop table certificates;
drop table acme_accounts;
drop table platform_keys;
drop sequence certificate_version_seq;

-- Our own TXT record, the DNS checks and the certificate orders are gone;
-- so is the TXT miss count of 0027, replaced by the status poll's own count
-- below (the same rule: never detach on one negative answer, #398).
-- Dropping next_txt_check_at also drops the index domains_next_txt_check.
alter table domains
  drop column verify_token,
  drop column dns,
  drop column cert_state,
  drop column cert_retry_at,
  drop column cert_failures,
  drop column txt_checked_at,
  drop column next_txt_check_at,
  drop column txt_misses,
  drop column txt_first_miss_at;

-- cf_hostname_id: the custom hostname on the zone (unique: one row owns it).
-- cf_status / cf_ssl_status: as Cloudflare last reported them ('unknown'
-- before the first answer). cf_verification: the records the customer
-- creates ([{purpose, type, name, value}]). cf_errors: Cloudflare's
-- verification and validation errors as text. cf_checked_at: the last answer.
-- cf_misses / cf_first_miss_at: consecutive negative answers (moved, deleted,
-- blocked, not found) of a verified domain and when the run started; a
-- verified domain is detached only after several over a grace period.
alter table domains
  add column cf_hostname_id   text,
  add column cf_status        text not null default 'unknown' check (cf_status ~ '^[a-z_]{1,40}$'),
  add column cf_ssl_status    text not null default 'unknown' check (cf_ssl_status ~ '^[a-z_]{1,40}$'),
  add column cf_verification  jsonb not null default '[]'::jsonb,
  add column cf_errors        jsonb not null default '[]'::jsonb,
  add column cf_checked_at    bigint,
  add column cf_misses        integer not null default 0 check (cf_misses >= 0),
  add column cf_first_miss_at bigint;

create unique index domains_cf_hostname_id on domains (cf_hostname_id) where cf_hostname_id is not null;

-- Rows claimed before this migration have no custom hostname: released ones
-- stay history; any other is polled once a hostname exists (the domain job
-- creates it, src/domains/jobs.ts).
