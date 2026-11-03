-- #398: a verified domain is detached only after consecutive TXT misses over
-- a grace period, not on one negative answer (a resolver's negative cache of
-- an NXDOMAIN from before the record existed). `txt_misses` counts the
-- consecutive misses, `txt_first_miss_at` is when the run started; a match
-- resets both.
alter table domains add column txt_misses integer not null default 0 check (txt_misses >= 0);
alter table domains add column txt_first_miss_at bigint;
