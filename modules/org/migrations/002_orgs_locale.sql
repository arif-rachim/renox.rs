-- The organisation's default locale (#244): the i18n module uses it when
-- the user and the page session have no stored choice. Null = none.
alter table org__orgs add column locale text;
