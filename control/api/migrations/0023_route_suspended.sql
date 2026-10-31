-- deploy-api.md 0.5.1 section 5 (#346, #325): a suspended tenant's hostnames
-- keep a `suspended` route entry carrying the tenant's name, so the gateway
-- answers the neutral suspension page instead of an unknown host.
alter table route_entries drop constraint route_entries_status_check;
alter table route_entries add constraint route_entries_status_check check (status in ('active', 'draining', 'suspended'));
alter table route_entries add column display_name text check (display_name is null or (status = 'suspended' and length(display_name) between 1 and 128));
