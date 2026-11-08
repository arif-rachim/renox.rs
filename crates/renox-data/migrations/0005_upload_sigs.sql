-- Platform table of spent tenant upload signatures (docs/contracts/ops.md
-- 1.10.0 section 21, "Tenant uploads"; #580). The cell records the SHA-256 of
-- the `sig` of a `PUT /_files/<key>` that stored its file, and refuses a second
-- PUT with it (409). Written through the platform handle only. A signature is
-- valid for 1 hour at most, so rows older than 2 hours are deleted on each insert.
create table if not exists renox__upload_sigs (
  sig_hash text    not null primary key,
  used_at  integer not null                 -- Unix ms
) strict;
