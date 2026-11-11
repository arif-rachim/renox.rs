-- Test only: what the app's whatsapp.message_received handler read (#705).
create table app__seen (message_id text primary key, body text not null);
