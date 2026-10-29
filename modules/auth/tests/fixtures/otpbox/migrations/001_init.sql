create table otpbox__codes (seq integer primary key autoincrement, phone text not null, code text not null, purpose text not null);
create table otpbox__halt (user_id text primary key);
