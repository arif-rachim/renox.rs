-- The booking module (#572): setHours replaces instead of appending. Keep
-- the newest row per staff member and weekday, and per staff member and
-- day, then make that a rule the database enforces.
delete from booking__hours where weekday is not null and rowid not in (
  select max(rowid) from booking__hours where weekday is not null group by staff_id, weekday);
delete from booking__hours where day is not null and rowid not in (
  select max(rowid) from booking__hours where day is not null group by staff_id, day);
create unique index booking__hours_weekly on booking__hours (staff_id, weekday) where weekday is not null;
create unique index booking__hours_daily on booking__hours (staff_id, day) where day is not null;
