-- Messages to customers become real (F7-124): the channel each one took, the
-- preview of what WhatsApp would have sent while it is in sandbox, the
-- dispatcher's tasks from a customer's "cancel" / "reschedule" reply, and the
-- inbox messages already handled.

-- Which channel carried the message: 'whatsapp', 'email', 'preview' (sandbox: a
-- row of app__outbox_preview and nothing sent), 'none' (the customer has no
-- phone and no email) or 'staff' (told to the staff only: the customer's own
-- answer to a quotation). template is the WhatsApp template's name.
alter table app__customer_messages add column channel text not null default 'none';
alter table app__customer_messages add column template text;

-- What WhatsApp would have sent, written instead of a send while
-- app__settings.whatsapp_sandbox is '1' (the whatsapp module has no sandbox mode).
create table app__outbox_preview (
  id integer primary key autoincrement,
  branch_id text not null references app__branches (id),
  customer_id text not null references app__customers (id),
  channel text not null check (channel in ('whatsapp', 'email')),
  to_address text not null,
  template text not null,
  body text not null,
  created_at integer not null
);
create index app__outbox_preview_customer on app__outbox_preview (customer_id, created_at);

-- Work a customer's reply made for the dispatcher. job_id is the customer's next
-- scheduled job, or null when the customer has none.
create table app__tasks (
  id integer primary key autoincrement,
  branch_id text not null references app__branches (id),
  kind text not null check (kind in ('cancel', 'reschedule')),
  job_id text references app__jobs (id),
  message text not null,
  created_at integer not null,
  done_at integer
);
create index app__tasks_branch on app__tasks (branch_id, done_at, created_at);

-- Inbound WhatsApp messages (the module's inbox) that jobs/inbox-sweep.ts has
-- handled, by the inbox row's id: a message is handled once.
create table app__inbox_seen (
  message_id text primary key,
  seen_at integer not null
);

-- The technician's name, kept on the visit when the technician checks in: the
-- customer's report page and PDF (a link, no sign-in) cannot ask the org module
-- for the members of the branch. Empty for a visit before this column existed:
-- the signed-in views read the name from the organisation as before.
alter table app__visits add column technician_name text not null default '';
