-- The organisation an agent acts in (#590): chosen on the consent page from
-- the auth.agent_orgs hook's list (the only one without a choice), stored on
-- the code and copied onto the token; the auth.principal hook's fillers turn
-- it into `principal.org` while the user is still a member. Null: none.
alter table auth__oauth_codes add column org_id text;
alter table auth__agent_tokens add column org_id text;
