-- #794: the sign-in method each auth.after_login run was told.
create table otpbox__logins (seq integer primary key autoincrement, user_id text not null, method text not null);
