-- deploy-api.md 0.12 section 8 (#818, #826): the config values the platform computes for a module
-- (`{ "email": { "app_url": "https://..." } }`), carried on the route entry. null = none.
alter table route_entries add column module_config jsonb;
