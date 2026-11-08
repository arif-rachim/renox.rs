-- Demo data for `renox test --seed seeds/001_demo.sql` and `renox dev`.
-- Idempotent: running it twice changes nothing more.
insert or replace into app__settings (key, value) values
  ('brand_name', 'FixIt Services'),
  ('brand_color', '#1f6f5c'),
  ('brand_footer_en', 'FixIt Services LLC, Dubai'),
  ('brand_footer_ar', 'فيكس إت للخدمات ذ.م.م، دبي'),
  ('accounts_email', 'accounts@fixit.example'),
  ('whatsapp_sandbox', '1');

insert or ignore into org__orgs (id, slug, name, created_by, created_at) values
  ('org_dubai', 'dubai', 'Dubai', 'seed', 1793000000),
  ('org_sharjah', 'sharjah', 'Sharjah', 'seed', 1793000000);

insert or ignore into app__branches (id, org_id, name_en, name_ar, phone, address, emirate, area, created_at) values
  ('br_dubai', 'org_dubai', 'Dubai', 'دبي', '+97140000001', 'Al Quoz, Dubai', 'dubai', 'Al Quoz', 1793000000),
  ('br_sharjah', 'org_sharjah', 'Sharjah', 'الشارقة', '+97160000002', 'Al Nahda, Sharjah', 'sharjah', 'Al Nahda', 1793000000);
