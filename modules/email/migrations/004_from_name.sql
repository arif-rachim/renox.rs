-- The email module (#611): a display name for the sender, per message.
alter table email__messages add column from_name text;
