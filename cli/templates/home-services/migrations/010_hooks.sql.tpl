-- The customer's WhatsApp reply is handled when the whatsapp module emits
-- whatsapp.message_received (hooks.ts), at least once: the inbox message a task
-- came from keeps a second delivery from making a second task. Null for the
-- tasks made before this column existed. (app__inbox_seen, of the minute sweep
-- this replaces, stays: migrations are forward-only.)
alter table app__tasks add column message_id text;
create unique index app__tasks_message on app__tasks (message_id) where message_id is not null;
