-- The digits of a stored choice (#266): `arab` when it was made with
-- `?lang=ar-u-nu-arab`, `latn` with `-u-nu-latn`, null without an extension.
-- With `digits = "auto"` an Arabic page follows it.
alter table i18n__prefs add column digits text;
