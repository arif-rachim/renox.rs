-- Resuming a sign-in a filler of auth.after_login halted (#287: 2fa). The
-- ticket is handed to the fillers; only its SHA-256 is stored; 10 minutes,
-- single use.
create table auth__login_tickets (
  ticket_hash text    primary key,
  user_id     text    not null references auth__users (id),
  next        text,
  expires_at  integer not null,
  used_at     integer
);
