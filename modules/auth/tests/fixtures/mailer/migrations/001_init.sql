create table mailer__sent (seq integer primary key, mail_to text not null, template text not null, url text not null);
create table mailer__events (seq integer primary key, name text not null, user_id text not null);
