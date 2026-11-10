-- Refresh tokens for the remote MCP's OAuth connections (#688;
-- docs/20-ai-agents-mcp.md section 1b, "Sessions: refresh tokens").
--
-- A refresh token is a row of this table with `kind = 'refresh'`: it is never
-- a bearer token (the deploy API and /mcp look up `kind = 'access'` only), and
-- `GET /v1/tokens` does not list it. `family_id` ties the access tokens and
-- the refresh tokens of one connection together (the id of the first access
-- token), so revoking one revokes all of them. `used_at` is set when a refresh
-- token is rotated; a second use of it is a reuse and revokes the family.
alter table tokens add column kind text not null default 'access' check (kind in ('access', 'refresh'));
alter table tokens add column family_id text;
alter table tokens add column used_at bigint;
create index tokens_family on tokens (family_id) where family_id is not null;
