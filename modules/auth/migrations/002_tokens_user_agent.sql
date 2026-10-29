-- One-time tokens are bound to the user agent family that asked for them (#240).
alter table auth__tokens add column user_agent text;
