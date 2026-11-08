-- Invoicing (F7-125): the tax invoice of a done job (issued by the tax_gcc
-- module, which keeps the document and its gapless number), the payments
-- recorded against it, and its status.

-- One invoice per job. invoice_id is the tax_gcc number ('INV-000001'). The
-- branch, customer, total and due date are kept here so the lists and the
-- statement do not parse the module's documents; the document itself stays in
-- tax_gcc__documents, immutable. credit_note_id is the tax_gcc credit note
-- ('CN-000001') that cancelled the invoice, when there is one.
create table app__job_invoices (
  job_id text primary key references app__jobs (id),
  branch_id text not null references app__branches (id),
  customer_id text not null references app__customers (id),
  invoice_id text not null unique,
  total_fils integer not null check (total_fils >= 0),
  due_at integer not null,
  credit_note_id text,
  created_by text not null,
  created_at integer not null
);
create index app__job_invoices_branch on app__job_invoices (branch_id, created_at);
create index app__job_invoices_customer on app__job_invoices (customer_id, created_at);

-- Cash, a bank transfer or a cheque. A cheque names its number and its date.
-- amount_fils is positive and never takes the invoice past its total (the
-- action checks); received_at is unix seconds.
create table app__payments (
  id integer primary key autoincrement,
  branch_id text not null references app__branches (id),
  invoice_id text not null references app__job_invoices (invoice_id),
  method text not null check (method in ('cash', 'transfer', 'cheque')),
  amount_fils integer not null check (amount_fils > 0),
  received_at integer not null,
  reference text not null default '',
  cheque_number text,
  cheque_date text,
  recorded_by text not null,
  created_at integer not null,
  check (method != 'cheque' or (cheque_number is not null and cheque_date is not null))
);
create index app__payments_invoice on app__payments (invoice_id, received_at);

-- issued, part-paid, paid or credited. "Overdue" is not a status: it is an
-- issued or part-paid invoice past due_at, which the list works out. A view
-- cannot be owned (build check V26), so a statement on it names the branch
-- itself (lib/invoices.ts always does), on top of the fence of its tables.
create view app__invoice_status as
select
  i.invoice_id,
  i.job_id,
  i.branch_id,
  i.customer_id,
  i.total_fils,
  i.due_at,
  i.credit_note_id,
  i.created_at,
  coalesce(p.paid_fils, 0) as paid_fils,
  case
    when i.credit_note_id is not null then 'credited'
    when coalesce(p.paid_fils, 0) >= i.total_fils then 'paid'
    when coalesce(p.paid_fils, 0) > 0 then 'part-paid'
    else 'issued'
  end as status
from app__job_invoices i
left join (select invoice_id, sum(amount_fils) as paid_fils from app__payments group by invoice_id) p on p.invoice_id = i.invoice_id;
