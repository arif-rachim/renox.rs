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

-- Staff. Everyone signs in with the password `correct horse battery` (an
-- argon2id hash of it, with the platform's parameters). A user works in the
-- branch they belong to (org__members); their role is a global assignment.
-- The owner belongs to both branches and starts in Dubai (the first joined).
insert or ignore into auth__users (id, email, display_name, password_hash, email_verified_at, created_at, updated_at) values
  ('u_owner', 'owner@fixit.example', 'Omar Owner', '$argon2id$v=19$m=65536,t=3,p=1$wLwjVB+5qkEDlrTxtpHDs3mOt0NVYBbZ414OyYoMD2U$w/w6yMsymLOZLviGXl11wl7jN2RhFbMxY2434LC8LsU', 1793000000, 1793000000, 1793000000),
  ('u_dxb_manager', 'manager.dubai@fixit.example', 'Mona Manager', '$argon2id$v=19$m=65536,t=3,p=1$wLwjVB+5qkEDlrTxtpHDs3mOt0NVYBbZ414OyYoMD2U$w/w6yMsymLOZLviGXl11wl7jN2RhFbMxY2434LC8LsU', 1793000000, 1793000000, 1793000000),
  ('u_dxb_dispatcher', 'dispatcher.dubai@fixit.example', 'Dina Dispatcher', '$argon2id$v=19$m=65536,t=3,p=1$wLwjVB+5qkEDlrTxtpHDs3mOt0NVYBbZ414OyYoMD2U$w/w6yMsymLOZLviGXl11wl7jN2RhFbMxY2434LC8LsU', 1793000000, 1793000000, 1793000000),
  ('u_dxb_accountant', 'accountant.dubai@fixit.example', 'Aziz Accountant', '$argon2id$v=19$m=65536,t=3,p=1$wLwjVB+5qkEDlrTxtpHDs3mOt0NVYBbZ414OyYoMD2U$w/w6yMsymLOZLviGXl11wl7jN2RhFbMxY2434LC8LsU', 1793000000, 1793000000, 1793000000),
  ('u_shj_dispatcher', 'dispatcher.sharjah@fixit.example', 'Sami Dispatcher', '$argon2id$v=19$m=65536,t=3,p=1$wLwjVB+5qkEDlrTxtpHDs3mOt0NVYBbZ414OyYoMD2U$w/w6yMsymLOZLviGXl11wl7jN2RhFbMxY2434LC8LsU', 1793000000, 1793000000, 1793000000);

insert or ignore into org__members (org_id, user_id, role, created_at) values
  ('org_dubai', 'u_owner', 'owner', 1793000000),
  ('org_sharjah', 'u_owner', 'owner', 1793000001),
  ('org_dubai', 'u_dxb_manager', 'admin', 1793000000),
  ('org_dubai', 'u_dxb_dispatcher', 'member', 1793000000),
  ('org_dubai', 'u_dxb_accountant', 'member', 1793000000),
  ('org_sharjah', 'u_shj_dispatcher', 'member', 1793000000);

insert or ignore into renox__role_assignments (user_id, role, scope_type, scope_id, granted_by, at) values
  ('u_owner', 'owner', 'global', '', 'seed', 1793000000000),
  ('u_dxb_manager', 'branch_manager', 'global', '', 'seed', 1793000000000),
  ('u_dxb_dispatcher', 'dispatcher', 'global', '', 'seed', 1793000000000),
  ('u_dxb_accountant', 'accountant', 'global', '', 'seed', 1793000000000),
  ('u_shj_dispatcher', 'dispatcher', 'global', '', 'seed', 1793000000000);

-- Ten customers: six households and four property managers (with a TRN).
insert or ignore into app__customers (id, branch_id, kind, name, trn, phone, email, language, created_at) values
  ('cu_dxb_01', 'br_dubai', 'household', 'Layla Haddad', null, '+971501110001', 'layla.haddad@example.com', 'ar', 1793100000),
  ('cu_dxb_02', 'br_dubai', 'household', 'Peter Nowak', null, '+971521110002', 'peter.nowak@example.com', 'en', 1793100100),
  ('cu_dxb_03', 'br_dubai', 'household', 'Fatima Al Suwaidi', null, '+971551110003', null, 'ar', 1793100200),
  ('cu_dxb_04', 'br_dubai', 'company', 'Marina Heights Property Management', '100123456700003', '+97144110004', 'ops@marinaheights.example', 'en', 1793100300),
  ('cu_dxb_05', 'br_dubai', 'company', 'Al Barsha Facilities LLC', '100123456700011', '+971561110005', 'fm@albarsha.example', 'en', 1793100400),
  ('cu_shj_01', 'br_sharjah', 'household', 'Khalid Mansoor', null, '+971501220001', 'khalid.mansoor@example.com', 'ar', 1793100500),
  ('cu_shj_02', 'br_sharjah', 'household', 'Priya Nair', null, '+971541220002', 'priya.nair@example.com', 'en', 1793100600),
  ('cu_shj_03', 'br_sharjah', 'household', 'Noura Al Qasimi', null, '+971581220003', null, 'ar', 1793100700),
  ('cu_shj_04', 'br_sharjah', 'company', 'Nahda Towers Management', '100123456700029', '+97165220004', 'office@nahdatowers.example', 'en', 1793100800),
  ('cu_shj_05', 'br_sharjah', 'company', 'Majaz Real Estate Services', '100123456700037', '+971521220005', 'info@majaz.example', 'ar', 1793100900);

insert or ignore into app__sites (id, customer_id, branch_id, label, emirate, area, address, makani, lat, lng, access_notes) values
  ('st_dxb_01a', 'cu_dxb_01', 'br_dubai', 'Apartment', 'AE-DU', 'Dubai Marina', 'Marina Crown, flat 1203', '3012345678', 25.0805, 55.1403, 'Ring the bell twice.'),
  ('st_dxb_02a', 'cu_dxb_02', 'br_dubai', 'Villa', 'AE-DU', 'Al Barsha', 'Street 14, villa 22', null, null, null, 'Gate code at the guard post.'),
  ('st_dxb_02b', 'cu_dxb_02', 'br_dubai', 'Office', 'AE-DU', 'Business Bay', 'Executive Tower, office 504', '3098765432', null, null, ''),
  ('st_dxb_03a', 'cu_dxb_03', 'br_dubai', 'Home', 'AE-DU', 'Jumeirah', 'Jumeirah 1, villa 7', null, 25.2048, 55.2308, ''),
  ('st_dxb_04a', 'cu_dxb_04', 'br_dubai', 'Tower A', 'AE-DU', 'Dubai Marina', 'Marina Heights A', '3011122233', 25.0770, 55.1380, 'Technicians sign in at reception.'),
  ('st_dxb_04b', 'cu_dxb_04', 'br_dubai', 'Tower B', 'AE-DU', 'Dubai Marina', 'Marina Heights B', '3011122244', 25.0772, 55.1383, 'Technicians sign in at reception.'),
  ('st_dxb_05a', 'cu_dxb_05', 'br_dubai', 'Building 9', 'AE-DU', 'Al Barsha', 'Al Barsha 1, building 9', null, null, null, ''),
  ('st_shj_01a', 'cu_shj_01', 'br_sharjah', 'Villa', 'AE-SH', 'Al Majaz', 'Al Majaz 2, villa 3', null, 25.3240, 55.3850, ''),
  ('st_shj_02a', 'cu_shj_02', 'br_sharjah', 'Apartment', 'AE-SH', 'Al Nahda', 'Nahda Residence, flat 410', null, null, null, 'Parking at the side entrance.'),
  ('st_shj_03a', 'cu_shj_03', 'br_sharjah', 'Home', 'AE-SH', 'Muwaileh', 'Muwaileh, house 18', null, null, null, ''),
  ('st_shj_04a', 'cu_shj_04', 'br_sharjah', 'Main tower', 'AE-SH', 'Al Nahda', 'Nahda Towers', null, 25.3010, 55.3700, ''),
  ('st_shj_04b', 'cu_shj_04', 'br_sharjah', 'Car park', 'AE-SH', 'Al Nahda', 'Nahda Towers, level P2', null, null, null, 'Needs a permit from the office.'),
  ('st_shj_05a', 'cu_shj_05', 'br_sharjah', 'Block C', 'AE-SH', 'Al Majaz', 'Majaz Block C', null, null, null, '');

-- The catalogue: company-wide (branch_id null). Prices in fils, VAT 5 %.
insert or ignore into app__services (code, name_en, name_ar, unit, price_fils, vat_rate, active) values
  ('AC-SERVICE', 'AC service', 'صيانة المكيف', 'unit', 15000, 5, 1),
  ('AC-REPAIR', 'AC repair', 'إصلاح المكيف', 'hour', 18000, 5, 1),
  ('DEEP-CLEAN', 'Deep cleaning', 'تنظيف شامل', 'visit', 45000, 5, 1),
  ('PEST', 'Pest control', 'مكافحة الحشرات', 'visit', 25000, 5, 1),
  ('PLUMBING', 'Plumbing', 'سباكة', 'hour', 16000, 5, 1),
  ('ELECTRICAL', 'Electrical', 'كهرباء', 'hour', 16000, 5, 1),
  ('HANDYMAN', 'Handyman', 'أعمال صيانة عامة', 'hour', 12000, 5, 1),
  ('AMC-VISIT', 'AMC visit', 'زيارة عقد الصيانة السنوي', 'visit', 20000, 5, 1);

-- Six quotations of the Dubai branch, one per state (two are sent), written by
-- the dispatcher. Amounts are fils with 5 % VAT per line, rounded half up.
-- valid_until of the open ones is far ahead so the demo does not age.
insert or ignore into app__quote_numbers (n, quote_id) values
  (1, 'qt_seed_01'), (2, 'qt_seed_02'), (3, 'qt_seed_03'), (4, 'qt_seed_04'), (5, 'qt_seed_05'), (6, 'qt_seed_06');

insert or ignore into app__quotes (id, branch_id, customer_id, site_id, number, status, valid_until, notes, subtotal_fils, vat_fils, total_fils, created_by, created_at, approved_at, approved_ip) values
  ('qt_seed_01', 'br_dubai', 'cu_dxb_01', 'st_dxb_01a', 'Q-000001', 'draft', 2000000000, 'Three split units, access after 4 pm.', 45000, 2250, 47250, 'u_dxb_dispatcher', 1793300000, null, null),
  ('qt_seed_02', 'br_dubai', 'cu_dxb_02', 'st_dxb_02a', 'Q-000002', 'sent', 2000000000, '', 70000, 3500, 73500, 'u_dxb_dispatcher', 1793310000, null, null),
  ('qt_seed_03', 'br_dubai', 'cu_dxb_04', 'st_dxb_04a', 'Q-000003', 'sent', 2000000000, 'Tower A, level 12 pantry leak.', 48000, 2400, 50400, 'u_dxb_dispatcher', 1793320000, null, null),
  ('qt_seed_04', 'br_dubai', 'cu_dxb_03', 'st_dxb_03a', 'Q-000004', 'approved', 2000000000, '', 36000, 1800, 37800, 'u_dxb_dispatcher', 1793330000, 1793340000, '203.0.113.7'),
  ('qt_seed_05', 'br_dubai', 'cu_dxb_05', 'st_dxb_05a', 'Q-000005', 'rejected', 2000000000, '', 48000, 2400, 50400, 'u_dxb_dispatcher', 1793350000, 1793360000, '203.0.113.8'),
  ('qt_seed_06', 'br_dubai', 'cu_dxb_01', 'st_dxb_01a', 'Q-000006', 'expired', 1793000100, '', 20000, 1000, 21000, 'u_dxb_dispatcher', 1792900000, null, null);

insert or ignore into app__quote_lines (id, quote_id, branch_id, service_id, description_en, description_ar, qty, unit_price_fils, vat_rate, line_total_fils) values
  (1, 'qt_seed_01', 'br_dubai', (select id from app__services where code = 'AC-SERVICE'), 'AC service', 'صيانة المكيف', 3, 15000, 5, 45000),
  (2, 'qt_seed_02', 'br_dubai', (select id from app__services where code = 'DEEP-CLEAN'), 'Deep cleaning', 'تنظيف شامل', 1, 45000, 5, 45000),
  (3, 'qt_seed_02', 'br_dubai', (select id from app__services where code = 'PEST'), 'Pest control', 'مكافحة الحشرات', 1, 25000, 5, 25000),
  (4, 'qt_seed_03', 'br_dubai', (select id from app__services where code = 'PLUMBING'), 'Plumbing', 'سباكة', 2, 16000, 5, 32000),
  (5, 'qt_seed_03', 'br_dubai', (select id from app__services where code = 'ELECTRICAL'), 'Electrical', 'كهرباء', 1, 16000, 5, 16000),
  (6, 'qt_seed_04', 'br_dubai', (select id from app__services where code = 'AC-REPAIR'), 'AC repair', 'إصلاح المكيف', 2, 18000, 5, 36000),
  (7, 'qt_seed_05', 'br_dubai', (select id from app__services where code = 'HANDYMAN'), 'Handyman', 'أعمال صيانة عامة', 4, 12000, 5, 48000),
  (8, 'qt_seed_06', 'br_dubai', (select id from app__services where code = 'AMC-VISIT'), 'AMC visit', 'زيارة عقد الصيانة السنوي', 1, 20000, 5, 20000);

-- Approval links of the demo: only the SHA-256 is stored. The tokens, for the
-- demo and the tests only, are `demo-q00000N-` followed by x up to 43 characters:
-- /l/approve/demo-q000002-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx opens Q-000002.
-- Q-000004's link is used (the quotation is approved); Q-000006's has expired.
insert or ignore into app__links (token_hash, kind, ref_id, expires_at, used_at) values
  ('ebdc84017359a3692d7a92d3d2d388e90cfb83a278519a097f81ec905a89c025', 'approve', 'qt_seed_02', 2000000000, null),
  ('82f6868fa96d8f7215cde1ded92d41d09a5360e3d172f657924ed1bab1e6b190', 'approve', 'qt_seed_03', 2000000000, null),
  ('a2ba054280b1c9b65b7af7af382ee634160dfa4050d60d30dcde935cc2b25cc0', 'approve', 'qt_seed_04', 2000000000, 1793340000),
  ('b7112cf3d15ad0bc22c8f6a6569695c3dc68c5342b1f3852b32083ed85f76c0d', 'approve', 'qt_seed_06', 1793000100, null);
