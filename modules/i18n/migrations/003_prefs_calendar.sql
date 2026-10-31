-- The calendar of a stored choice (#336): `islamic-umalqura` (or another
-- calendar of ops.md 1.4.0) when it was made with
-- `?lang=ar-u-ca-islamic-umalqura`, null without one. With
-- `calendar = "auto"` an Arabic page follows it.
alter table i18n__prefs add column calendar text;
