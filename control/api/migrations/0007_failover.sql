-- Node failover and tenant moves (docs/contracts/deploy-api.md 0.3
-- sections 15-17, #257).

-- The node listener a node announced at registration, and the callback
-- token the control plane presents there (wrapped under the master key,
-- never stored in the clear).
alter table workers add column listen_url text;
alter table workers add column callback_token_wrapped bytea;
alter table workers add column callback_token_nonce bytea;

-- A tenant pinned to the node failover or an operator moved it to (FO4),
-- overriding the rendezvous owner while that node is healthy.
create table tenant_pins (
  tenant_id text primary key references tenants (id),
  node_id   text not null,
  reason    text not null,
  pinned_at bigint not null
);

-- Every move attempt (FO5): getBackups reports the last `moved` one as
-- last_failover; `dropped_at` is set when the old node confirmed the drop.
create table failovers (
  id          bigserial primary key,
  tenant_id   text not null references tenants (id),
  from_node   text not null,
  to_node     text,
  reason      text not null check (reason in ('failover', 'move')),
  status      text not null check (status in ('moved', 'failed')),
  generation  text,
  restored_to bigint,
  elapsed_ms  bigint not null,
  at          bigint not null,
  dropped_at  bigint,
  error       text
);
create index failovers_tenant on failovers (tenant_id, at desc);
create index failovers_pending_drop on failovers (from_node) where status = 'moved' and dropped_at is null;

-- Platform alerts (docs/23-failure-modes.md "Node dies, restore fails").
create table alerts (
  id        bigserial primary key,
  at        bigint not null,
  kind      text not null,
  tenant_id text,
  node_id   text,
  detail    jsonb not null
);
