-- The email module (#328): which template and locale a message was made
-- from (the log page shows them, never the body), and its Reply-To.
alter table email__messages add column template text;
alter table email__messages add column locale text;
alter table email__messages add column reply_to text;
