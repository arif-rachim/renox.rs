-- #446: the dashboard's /device page can deny a `renox login` request.
-- A denied code is used up (`used_at`) and remembered as denied, so the
-- CLI's next poll is told "denied" instead of waiting for the code to expire.
alter table device_codes add column denied_at bigint;
