-- The owner connector's bridge (#698): a token minted by `mintAgentToken`
-- (client `renoxium-platform`) keeps the connector's grant, the access-token
-- id on the control plane, for the audit trail. Null for every other token.
alter table auth__agent_tokens add column grant_id text;
