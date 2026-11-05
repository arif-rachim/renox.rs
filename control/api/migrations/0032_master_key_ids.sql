-- The id of the master key that sealed each stored value (#451;
-- ops/security/keys.md "Master key"): `mk-` and 16 hex characters of the
-- key's SHA-256, never the key. `tenant_keys.master_key_id` already exists
-- (always `env-1` before #451). A null id here, like `env-1`, is a value from
-- before ids: it opens with the current key, else the previous one, and the
-- re-seal job (src/secrets/reseal.ts) gives it an id.
alter table account_mfa_totp add column secret_key_id text;
alter table workers add column callback_token_key_id text;
