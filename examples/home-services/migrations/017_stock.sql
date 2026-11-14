-- Stock per branch and its moves (#813, wave D, inventory). `app__stock` holds how many of a part a branch has and
-- the average cost of them; `app__stock_moves` is the history of every change of that number: who, why, and the
-- balance after. lib/stock.ts is the only code that writes either table, so the number is never edited directly.
-- Both are owned by branch ([authz.ownership] in renox.toml): every statement goes through `branchDb`.
-- `qty` of a stock row may be negative (a technician used what the books did not have); a move's `qty` is always
-- the absolute amount and `kind` gives the direction (an `adjust` carries it in `reason`, "count: was 7, is 5").
-- `ref_kind` / `ref_id` say what caused a move: a visit (its id), a purchase order, one transfer (both of its
-- moves share the id), or `manual`. Quantities have at most three decimals; costs are in fils.
create table app__stock (
  branch_id text not null references app__branches (id),
  part_id text not null references app__parts (id),
  qty real not null default 0,
  avg_cost_fils integer not null default 0,
  updated_at integer not null,
  primary key (branch_id, part_id)
);

create table app__stock_moves (
  id text primary key,
  branch_id text not null,
  part_id text not null,
  kind text not null check (kind in ('in','out','adjust','transfer_out','transfer_in')),
  qty real not null check (qty > 0),
  unit_cost_fils integer,
  reason text not null default '',
  ref_kind text check (ref_kind in ('visit','purchase','transfer','manual')),
  ref_id text,
  balance_after real not null,
  created_by text not null,
  created_at integer not null
);
create index app__stock_moves_part on app__stock_moves (branch_id, part_id, created_at);
