-- Tenant erasure (#308; deploy-api.md 0.4 section 3, deleteTenant and the
-- erasure state machine). One row per tenant: it outlives the tenant's data
-- as the tombstone getTenant answers, with the audit rows.
create table tenant_erasures (
  tenant_id    text    primary key references tenants (id),
  state        text    not null check (state in ('pending', 'erasing', 'done', 'failed')),
  requested_at bigint  not null,
  requested_by text    not null,
  completed_at bigint,
  -- The step that still failed when the time box ran out (state failed).
  failure      text,
  -- Steps confirmed so far, in order (routes, tokens, node_drop, replica, exports, records).
  steps        jsonb   not null default '[]'::jsonb,
  attempts     integer not null default 0,
  next_at      bigint  not null
);
create index tenant_erasures_due on tenant_erasures (next_at) where state in ('pending', 'erasing');
