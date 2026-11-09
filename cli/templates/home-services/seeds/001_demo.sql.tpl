-- Demo data for `renox test --seed seeds/001_demo.sql` and `renox dev`.
-- Idempotent: running it twice changes nothing more.
insert or replace into app__settings (key, value) values
  ('brand_name', 'FixIt Services'),
  ('brand_color', '#1f6f5c'),
  ('brand_footer_en', 'FixIt Services LLC, Dubai'),
  ('brand_footer_ar', 'فيكس إت للخدمات ذ.م.م، دبي'),
  ('accounts_email', 'accounts@fixit.example');

insert or ignore into org__orgs (id, slug, name, created_by, created_at) values
  ('org_dubai', 'dubai', 'Dubai', 'seed', 1793000000),
  ('org_sharjah', 'sharjah', 'Sharjah', 'seed', 1793000000);

-- slug is the branch's name in the dispatch socket's URL (/ws/dispatch/dubai).
insert or ignore into app__branches (id, org_id, name_en, name_ar, phone, address, emirate, area, slug, created_at) values
  ('br_dubai', 'org_dubai', 'Dubai', 'دبي', '+97140000001', 'Al Quoz, Dubai', 'dubai', 'Al Quoz', 'dubai', 1793000000),
  ('br_sharjah', 'org_sharjah', 'Sharjah', 'الشارقة', '+97160000002', 'Al Nahda, Sharjah', 'sharjah', 'Al Nahda', 'sharjah', 1793000000);

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

-- Technicians: two per branch (password as above). Their role is the global
-- `technician` assignment; org__members puts them in their branch.
insert or ignore into auth__users (id, email, display_name, password_hash, email_verified_at, created_at, updated_at) values
  ('u_dxb_ali', 'ali.dubai@fixit.example', 'Ali Hassan', '$argon2id$v=19$m=65536,t=3,p=1$wLwjVB+5qkEDlrTxtpHDs3mOt0NVYBbZ414OyYoMD2U$w/w6yMsymLOZLviGXl11wl7jN2RhFbMxY2434LC8LsU', 1793000000, 1793000000, 1793000000),
  ('u_dxb_bilal', 'bilal.dubai@fixit.example', 'Bilal Raza', '$argon2id$v=19$m=65536,t=3,p=1$wLwjVB+5qkEDlrTxtpHDs3mOt0NVYBbZ414OyYoMD2U$w/w6yMsymLOZLviGXl11wl7jN2RhFbMxY2434LC8LsU', 1793000000, 1793000000, 1793000000),
  ('u_shj_hamad', 'hamad.sharjah@fixit.example', 'Hamad Saeed', '$argon2id$v=19$m=65536,t=3,p=1$wLwjVB+5qkEDlrTxtpHDs3mOt0NVYBbZ414OyYoMD2U$w/w6yMsymLOZLviGXl11wl7jN2RhFbMxY2434LC8LsU', 1793000000, 1793000000, 1793000000),
  ('u_shj_imran', 'imran.sharjah@fixit.example', 'Imran Khan', '$argon2id$v=19$m=65536,t=3,p=1$wLwjVB+5qkEDlrTxtpHDs3mOt0NVYBbZ414OyYoMD2U$w/w6yMsymLOZLviGXl11wl7jN2RhFbMxY2434LC8LsU', 1793000000, 1793000000, 1793000000);

insert or ignore into org__members (org_id, user_id, role, created_at) values
  ('org_dubai', 'u_dxb_ali', 'member', 1793000000),
  ('org_dubai', 'u_dxb_bilal', 'member', 1793000000),
  ('org_sharjah', 'u_shj_hamad', 'member', 1793000000),
  ('org_sharjah', 'u_shj_imran', 'member', 1793000000);

insert or ignore into renox__role_assignments (user_id, role, scope_type, scope_id, granted_by, at) values
  ('u_dxb_ali', 'technician', 'global', '', 'seed', 1793000000000),
  ('u_dxb_bilal', 'technician', 'global', '', 'seed', 1793000000000),
  ('u_shj_hamad', 'technician', 'global', '', 'seed', 1793000000000),
  ('u_shj_imran', 'technician', 'global', '', 'seed', 1793000000000);

-- Working hours of both branches, in minutes from midnight (weekday 0 is
-- Sunday, closed): Monday to Thursday and Saturday 08:00 to 18:00, Friday 14:00 to 18:00.
insert or ignore into app__branch_hours (branch_id, weekday, open_min, close_min) values
  ('br_dubai', 1, 480, 1080),
  ('br_dubai', 2, 480, 1080),
  ('br_dubai', 3, 480, 1080),
  ('br_dubai', 4, 480, 1080),
  ('br_dubai', 5, 840, 1080),
  ('br_dubai', 6, 480, 1080),
  ('br_sharjah', 1, 480, 1080),
  ('br_sharjah', 2, 480, 1080),
  ('br_sharjah', 3, 480, 1080),
  ('br_sharjah', 4, 480, 1080),
  ('br_sharjah', 5, 840, 1080),
  ('br_sharjah', 6, 480, 1080);

-- What lib/booking-sync.ts would hand to the `booking` module the first time a
-- branch is used, written here so the demo's visits have their bookings: the
-- catalogue as booking services (minutes as in lib/booking-sync.ts), each
-- technician as booking staff with the branch's hours, and the marks that
-- keep the app from adding them a second time.
insert or ignore into booking__services (id, name, minutes, buffer, deposit_fils, cancel_hours) values
  ('ac-service', (select name_en from app__services where code = 'AC-SERVICE'), 60, 0, 0, 24),
  ('ac-repair', (select name_en from app__services where code = 'AC-REPAIR'), 90, 0, 0, 24),
  ('deep-clean', (select name_en from app__services where code = 'DEEP-CLEAN'), 180, 0, 0, 24),
  ('pest', (select name_en from app__services where code = 'PEST'), 90, 0, 0, 24),
  ('plumbing', (select name_en from app__services where code = 'PLUMBING'), 90, 0, 0, 24),
  ('electrical', (select name_en from app__services where code = 'ELECTRICAL'), 90, 0, 0, 24),
  ('handyman', (select name_en from app__services where code = 'HANDYMAN'), 60, 0, 0, 24),
  ('amc-visit', (select name_en from app__services where code = 'AMC-VISIT'), 60, 0, 0, 24);

insert or ignore into booking__staff (id, name, user_id) values
  ('u_dxb_ali', 'Ali Hassan', 'u_dxb_ali'),
  ('u_dxb_bilal', 'Bilal Raza', 'u_dxb_bilal'),
  ('u_shj_hamad', 'Hamad Saeed', 'u_shj_hamad'),
  ('u_shj_imran', 'Imran Khan', 'u_shj_imran');

insert or ignore into booking__staff_services (staff_id, service_id) values
  ('u_dxb_ali', 'ac-service'),
  ('u_dxb_ali', 'ac-repair'),
  ('u_dxb_ali', 'deep-clean'),
  ('u_dxb_ali', 'pest'),
  ('u_dxb_ali', 'plumbing'),
  ('u_dxb_ali', 'electrical'),
  ('u_dxb_ali', 'handyman'),
  ('u_dxb_ali', 'amc-visit'),
  ('u_dxb_bilal', 'ac-service'),
  ('u_dxb_bilal', 'ac-repair'),
  ('u_dxb_bilal', 'deep-clean'),
  ('u_dxb_bilal', 'pest'),
  ('u_dxb_bilal', 'plumbing'),
  ('u_dxb_bilal', 'electrical'),
  ('u_dxb_bilal', 'handyman'),
  ('u_dxb_bilal', 'amc-visit'),
  ('u_shj_hamad', 'ac-service'),
  ('u_shj_hamad', 'ac-repair'),
  ('u_shj_hamad', 'deep-clean'),
  ('u_shj_hamad', 'pest'),
  ('u_shj_hamad', 'plumbing'),
  ('u_shj_hamad', 'electrical'),
  ('u_shj_hamad', 'handyman'),
  ('u_shj_hamad', 'amc-visit'),
  ('u_shj_imran', 'ac-service'),
  ('u_shj_imran', 'ac-repair'),
  ('u_shj_imran', 'deep-clean'),
  ('u_shj_imran', 'pest'),
  ('u_shj_imran', 'plumbing'),
  ('u_shj_imran', 'electrical'),
  ('u_shj_imran', 'handyman'),
  ('u_shj_imran', 'amc-visit');

insert into booking__hours (staff_id, weekday, open_min, close_min)
select s.id, h.weekday, h.open_min, h.close_min from booking__staff s join app__branch_hours h on h.branch_id = case s.id when 'u_dxb_ali' then 'br_dubai' when 'u_dxb_bilal' then 'br_dubai' else 'br_sharjah' end
where s.id in ('u_dxb_ali', 'u_dxb_bilal', 'u_shj_hamad', 'u_shj_imran') and not exists (select 1 from booking__hours x where x.staff_id = s.id);

-- Twenty jobs across the states and both branches. Times are relative to the
-- day the seed runs (Dubai time), so the board always has today's and
-- tomorrow's work: a job of the past stays in the past. J-000001 to
-- J-000020 are drawn from app__job_numbers. No job is made from a quotation,
-- so the approved Q-000004 can be turned into one by hand.
insert or ignore into app__job_numbers (n, job_id) values
  (1, 'jb_seed_01'),
  (2, 'jb_seed_02'),
  (3, 'jb_seed_03'),
  (4, 'jb_seed_04'),
  (5, 'jb_seed_05'),
  (6, 'jb_seed_06'),
  (7, 'jb_seed_07'),
  (8, 'jb_seed_08'),
  (9, 'jb_seed_09'),
  (10, 'jb_seed_10'),
  (11, 'jb_seed_11'),
  (12, 'jb_seed_12'),
  (13, 'jb_seed_13'),
  (14, 'jb_seed_14'),
  (15, 'jb_seed_15'),
  (16, 'jb_seed_16'),
  (17, 'jb_seed_17'),
  (18, 'jb_seed_18'),
  (19, 'jb_seed_19'),
  (20, 'jb_seed_20');

insert or ignore into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at) values
  ('jb_seed_01', 'br_dubai', 'cu_dxb_01', 'st_dxb_01a', null, 'J-000001', 'new', 'urgent', (select id from app__services where code = 'AC-REPAIR'), 'AC not cooling in the bedroom.', null, null, null, null, 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_02', 'br_dubai', 'cu_dxb_02', 'st_dxb_02b', null, 'J-000002', 'new', 'normal', (select id from app__services where code = 'ELECTRICAL'), 'Replace three light fittings.', null, null, null, null, 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_03', 'br_dubai', 'cu_dxb_04', 'st_dxb_04a', null, 'J-000003', 'new', 'high', (select id from app__services where code = 'PLUMBING'), 'Pantry leak, level 12.', null, null, null, null, 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_04', 'br_dubai', 'cu_dxb_05', 'st_dxb_05a', null, 'J-000004', 'new', 'low', (select id from app__services where code = 'HANDYMAN'), 'Fix two doors and a shelf.', null, null, null, null, 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_05', 'br_dubai', 'cu_dxb_01', 'st_dxb_01a', null, 'J-000005', 'scheduled', 'normal', (select id from app__services where code = 'AC-SERVICE'), 'Yearly service of three units.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 36000), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 36000) + 3600), 'u_dxb_ali', 'bk_seed_05', 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_06', 'br_dubai', 'cu_dxb_02', 'st_dxb_02a', null, 'J-000006', 'scheduled', 'normal', (select id from app__services where code = 'PEST'), 'Ants in the kitchen.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 118800), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 118800) + 5400), 'u_dxb_ali', 'bk_seed_06', 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_07', 'br_dubai', 'cu_dxb_04', 'st_dxb_04b', null, 'J-000007', 'scheduled', 'high', (select id from app__services where code = 'PLUMBING'), 'Tower B, water heater.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 126000), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 126000) + 5400), 'u_dxb_bilal', 'bk_seed_07', 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_08', 'br_dubai', 'cu_dxb_03', 'st_dxb_03a', null, 'J-000008', 'scheduled', 'normal', (select id from app__services where code = 'DEEP-CLEAN'), 'Move-out cleaning.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 140400), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 140400) + 10800), 'u_dxb_bilal', 'bk_seed_08', 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_09', 'br_dubai', 'cu_dxb_04', 'st_dxb_04a', null, 'J-000009', 'en_route', 'high', (select id from app__services where code = 'ELECTRICAL'), 'Corridor lights out on level 7.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 30600), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 30600) + 5400), 'u_dxb_bilal', 'bk_seed_09', 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_10', 'br_dubai', 'cu_dxb_05', 'st_dxb_05a', null, 'J-000010', 'in_progress', 'normal', (select id from app__services where code = 'AC-REPAIR'), 'Building 9, compressor noise.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 28800), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 28800) + 5400), 'u_dxb_ali', 'bk_seed_10', 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_11', 'br_dubai', 'cu_dxb_02', 'st_dxb_02a', null, 'J-000011', 'done', 'normal', (select id from app__services where code = 'HANDYMAN'), 'Mount a TV and fix a curtain rail.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 46800), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 46800) + 3600), 'u_dxb_bilal', 'bk_seed_11', 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_12', 'br_dubai', 'cu_dxb_03', 'st_dxb_03a', null, 'J-000012', 'done', 'normal', (select id from app__services where code = 'AC-SERVICE'), 'Service of two units.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -54000), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -54000) + 3600), 'u_dxb_ali', 'bk_seed_12', 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_13', 'br_dubai', 'cu_dxb_01', 'st_dxb_01a', null, 'J-000013', 'invoiced', 'normal', (select id from app__services where code = 'PLUMBING'), 'Kitchen tap replaced.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -226800), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -226800) + 5400), 'u_dxb_bilal', 'bk_seed_13', 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_14', 'br_dubai', 'cu_dxb_02', 'st_dxb_02a', null, 'J-000014', 'cancelled', 'low', (select id from app__services where code = 'HANDYMAN'), 'Customer found someone else.', null, null, null, null, 'u_dxb_dispatcher', 1793400000, 1793400000),
  ('jb_seed_15', 'br_sharjah', 'cu_shj_01', 'st_shj_01a', null, 'J-000015', 'new', 'normal', (select id from app__services where code = 'AC-SERVICE'), 'Two split units.', null, null, null, null, 'u_shj_dispatcher', 1793400000, 1793400000),
  ('jb_seed_16', 'br_sharjah', 'cu_shj_04', 'st_shj_04b', null, 'J-000016', 'new', 'high', (select id from app__services where code = 'ELECTRICAL'), 'Car park lighting, level P2.', null, null, null, null, 'u_shj_dispatcher', 1793400000, 1793400000),
  ('jb_seed_17', 'br_sharjah', 'cu_shj_02', 'st_shj_02a', null, 'J-000017', 'scheduled', 'normal', (select id from app__services where code = 'PLUMBING'), 'Leaking bathroom mixer.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 118800), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 118800) + 5400), 'u_shj_hamad', 'bk_seed_17', 'u_shj_dispatcher', 1793400000, 1793400000),
  ('jb_seed_18', 'br_sharjah', 'cu_shj_05', 'st_shj_05a', null, 'J-000018', 'in_progress', 'normal', (select id from app__services where code = 'PEST'), 'Block C, quarterly treatment.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 32400), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 32400) + 5400), 'u_shj_imran', 'bk_seed_18', 'u_shj_dispatcher', 1793400000, 1793400000),
  ('jb_seed_19', 'br_sharjah', 'cu_shj_03', 'st_shj_03a', null, 'J-000019', 'done', 'normal', (select id from app__services where code = 'DEEP-CLEAN'), 'Deep clean before guests.', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -36000), ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -36000) + 10800), 'u_shj_hamad', 'bk_seed_19', 'u_shj_dispatcher', 1793400000, 1793400000),
  ('jb_seed_20', 'br_sharjah', 'cu_shj_04', 'st_shj_04a', null, 'J-000020', 'cancelled', 'normal', (select id from app__services where code = 'AC-REPAIR'), 'Duplicate request.', null, null, null, null, 'u_shj_dispatcher', 1793400000, 1793400000);

-- The bookings of the visits that were scheduled (confirmed, as `booking.confirm` leaves them).
insert or ignore into booking__bookings (id, service_id, staff_id, customer, start_at, end_at, status, expires_at, created_at) values
  ('bk_seed_05', 'ac-service', 'u_dxb_ali', 'cu_dxb_01', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 36000) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 36000) + 3600) * 1000, 'confirmed', null, 1793400000000),
  ('bk_seed_06', 'pest', 'u_dxb_ali', 'cu_dxb_02', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 118800) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 118800) + 5400) * 1000, 'confirmed', null, 1793400000000),
  ('bk_seed_07', 'plumbing', 'u_dxb_bilal', 'cu_dxb_04', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 126000) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 126000) + 5400) * 1000, 'confirmed', null, 1793400000000),
  ('bk_seed_08', 'deep-clean', 'u_dxb_bilal', 'cu_dxb_03', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 140400) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 140400) + 10800) * 1000, 'confirmed', null, 1793400000000),
  ('bk_seed_09', 'electrical', 'u_dxb_bilal', 'cu_dxb_04', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 30600) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 30600) + 5400) * 1000, 'confirmed', null, 1793400000000),
  ('bk_seed_10', 'ac-repair', 'u_dxb_ali', 'cu_dxb_05', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 28800) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 28800) + 5400) * 1000, 'confirmed', null, 1793400000000),
  ('bk_seed_11', 'handyman', 'u_dxb_bilal', 'cu_dxb_02', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 46800) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 46800) + 3600) * 1000, 'confirmed', null, 1793400000000),
  ('bk_seed_12', 'ac-service', 'u_dxb_ali', 'cu_dxb_03', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -54000) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -54000) + 3600) * 1000, 'confirmed', null, 1793400000000),
  ('bk_seed_13', 'plumbing', 'u_dxb_bilal', 'cu_dxb_01', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -226800) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -226800) + 5400) * 1000, 'confirmed', null, 1793400000000),
  ('bk_seed_17', 'plumbing', 'u_shj_hamad', 'cu_shj_02', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 118800) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 118800) + 5400) * 1000, 'confirmed', null, 1793400000000),
  ('bk_seed_18', 'pest', 'u_shj_imran', 'cu_shj_05', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 32400) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 32400) + 5400) * 1000, 'confirmed', null, 1793400000000),
  ('bk_seed_19', 'deep-clean', 'u_shj_hamad', 'cu_shj_03', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -36000) * 1000, ((cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + -36000) + 10800) * 1000, 'confirmed', null, 1793400000000);

-- The timeline: every job was created by its branch's dispatcher, and the ones past `new` moved once.
insert or ignore into app__job_events (id, job_id, branch_id, at, by_user_id, from_status, to_status, note) values
  (1, 'jb_seed_01', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (2, 'jb_seed_02', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (3, 'jb_seed_03', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (4, 'jb_seed_04', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (5, 'jb_seed_05', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (6, 'jb_seed_05', 'br_dubai', 1793400100, 'u_dxb_dispatcher', 'new', 'scheduled', ''),
  (7, 'jb_seed_06', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (8, 'jb_seed_06', 'br_dubai', 1793400100, 'u_dxb_dispatcher', 'new', 'scheduled', ''),
  (9, 'jb_seed_07', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (10, 'jb_seed_07', 'br_dubai', 1793400100, 'u_dxb_dispatcher', 'new', 'scheduled', ''),
  (11, 'jb_seed_08', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (12, 'jb_seed_08', 'br_dubai', 1793400100, 'u_dxb_dispatcher', 'new', 'scheduled', ''),
  (13, 'jb_seed_09', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (14, 'jb_seed_09', 'br_dubai', 1793400100, 'u_dxb_dispatcher', 'new', 'en_route', ''),
  (15, 'jb_seed_10', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (16, 'jb_seed_10', 'br_dubai', 1793400100, 'u_dxb_dispatcher', 'new', 'in_progress', ''),
  (17, 'jb_seed_11', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (18, 'jb_seed_11', 'br_dubai', 1793400100, 'u_dxb_dispatcher', 'new', 'done', ''),
  (19, 'jb_seed_12', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (20, 'jb_seed_12', 'br_dubai', 1793400100, 'u_dxb_dispatcher', 'new', 'done', ''),
  (21, 'jb_seed_13', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (22, 'jb_seed_13', 'br_dubai', 1793400100, 'u_dxb_dispatcher', 'new', 'invoiced', ''),
  (23, 'jb_seed_14', 'br_dubai', 1793400000, 'u_dxb_dispatcher', null, 'new', 'created'),
  (24, 'jb_seed_14', 'br_dubai', 1793400100, 'u_dxb_dispatcher', 'new', 'cancelled', ''),
  (25, 'jb_seed_15', 'br_sharjah', 1793400000, 'u_shj_dispatcher', null, 'new', 'created'),
  (26, 'jb_seed_16', 'br_sharjah', 1793400000, 'u_shj_dispatcher', null, 'new', 'created'),
  (27, 'jb_seed_17', 'br_sharjah', 1793400000, 'u_shj_dispatcher', null, 'new', 'created'),
  (28, 'jb_seed_17', 'br_sharjah', 1793400100, 'u_shj_dispatcher', 'new', 'scheduled', ''),
  (29, 'jb_seed_18', 'br_sharjah', 1793400000, 'u_shj_dispatcher', null, 'new', 'created'),
  (30, 'jb_seed_18', 'br_sharjah', 1793400100, 'u_shj_dispatcher', 'new', 'in_progress', ''),
  (31, 'jb_seed_19', 'br_sharjah', 1793400000, 'u_shj_dispatcher', null, 'new', 'created'),
  (32, 'jb_seed_19', 'br_sharjah', 1793400100, 'u_shj_dispatcher', 'new', 'done', ''),
  (33, 'jb_seed_20', 'br_sharjah', 1793400000, 'u_shj_dispatcher', null, 'new', 'created'),
  (34, 'jb_seed_20', 'br_sharjah', 1793400100, 'u_shj_dispatcher', 'new', 'cancelled', '');

-- The visits of the jobs that are done or invoiced (jb_seed_11, 12, 13, 19): check-in and check-out,
-- notes, a summary in both languages, two photos each and one part. The photo files are stored by
-- POST /api/dev/seed-visit-photos (dev only); width and height stay null until then.
insert or ignore into app__visits (id, branch_id, job_id, technician_user_id, checkin_at, checkout_at, notes, summary_en, summary_ar, signed_by_name) values
  ('vs_seed_11', 'br_dubai', 'jb_seed_11', 'u_dxb_bilal', (select scheduled_start from app__jobs where id = 'jb_seed_11') + 300, (select scheduled_start from app__jobs where id = 'jb_seed_11') + 3300, 'TV mounted on the living-room wall and the curtain rail fixed. Customer asked for a cable cover next time.', 'The TV was mounted on the living-room wall and the curtain rail was fixed. A cable cover can be added at the next visit.', 'تم تركيب التلفاز على جدار غرفة المعيشة وإصلاح سكة الستائر. يمكن إضافة غطاء للكابلات في الزيارة القادمة.', 'Customer'),
  ('vs_seed_12', 'br_dubai', 'jb_seed_12', 'u_dxb_ali', (select scheduled_start from app__jobs where id = 'jb_seed_12') + 240, (select scheduled_start from app__jobs where id = 'jb_seed_12') + 3500, 'Two split units serviced: filters washed, coils cleaned, gas level checked.', 'Both split units were serviced, with the filters washed and the coils cleaned. The gas level is normal.', 'تمت صيانة الوحدتين، مع غسل المرشحات وتنظيف الملفات. مستوى الغاز طبيعي.', 'Customer'),
  ('vs_seed_13', 'br_dubai', 'jb_seed_13', 'u_dxb_bilal', (select scheduled_start from app__jobs where id = 'jb_seed_13') + 600, (select scheduled_start from app__jobs where id = 'jb_seed_13') + 5000, 'Kitchen tap replaced with a new mixer; the old washer was worn out.', 'The kitchen tap was replaced with a new mixer. The old one had a worn washer.', 'تم استبدال صنبور المطبخ بخلاط جديد. كان الصنبور القديم يحتوي على حشية متآكلة.', 'Customer'),
  ('vs_seed_19', 'br_sharjah', 'jb_seed_19', 'u_shj_hamad', (select scheduled_start from app__jobs where id = 'jb_seed_19') + 300, (select scheduled_start from app__jobs where id = 'jb_seed_19') + 10500, 'Deep clean of the whole flat; kitchen and two bathrooms descaled.', 'The whole flat was deep cleaned. The kitchen and both bathrooms were descaled.', 'تم تنظيف الشقة بالكامل بعمق. وأُزيلت الترسبات من المطبخ والحمّامين.', 'Customer');

insert or ignore into app__visit_photos (id, branch_id, visit_id, phase, file_key, caption, created_at) values
  (1, 'br_dubai', 'vs_seed_11', 'before', 'app/visits/vs_seed_11/before/seed.png', 'The bare wall', 1793400100),
  (2, 'br_dubai', 'vs_seed_11', 'after', 'app/visits/vs_seed_11/after/seed.png', 'The mounted TV', 1793400100),
  (3, 'br_dubai', 'vs_seed_12', 'before', 'app/visits/vs_seed_12/before/seed.png', 'A dirty filter', 1793400100),
  (4, 'br_dubai', 'vs_seed_12', 'after', 'app/visits/vs_seed_12/after/seed.png', 'The cleaned filter', 1793400100),
  (5, 'br_dubai', 'vs_seed_13', 'before', 'app/visits/vs_seed_13/before/seed.png', 'The old tap', 1793400100),
  (6, 'br_dubai', 'vs_seed_13', 'after', 'app/visits/vs_seed_13/after/seed.png', 'The new mixer', 1793400100),
  (7, 'br_sharjah', 'vs_seed_19', 'before', 'app/visits/vs_seed_19/before/seed.png', 'The kitchen before', 1793400100),
  (8, 'br_sharjah', 'vs_seed_19', 'after', 'app/visits/vs_seed_19/after/seed.png', 'The kitchen after', 1793400100);

insert or ignore into app__visit_parts (id, branch_id, visit_id, description, qty, unit_price_fils) values
  (1, 'br_dubai', 'vs_seed_11', 'Wall bracket', 1, 4500),
  (2, 'br_dubai', 'vs_seed_12', 'Filter set', 2, 2500),
  (3, 'br_dubai', 'vs_seed_13', 'Kitchen mixer tap', 1, 18000),
  (4, 'br_sharjah', 'vs_seed_19', 'Descaling kit', 1, 3500);

-- The technician's name on each visit (what the customer's report page shows).
update app__visits set technician_name = (select display_name from auth__users where id = technician_user_id) where technician_name = '';

-- Invoicing: the invoiced job J-000013 has its tax invoice INV-000001, issued by
-- the tax_gcc module (its document, written here the way the module does), and
-- a first cheque of 150.00 against its 357.00: part-paid. The sequence goes on
-- at INV-000002. Dates are relative to the day the seed is loaded, so the
-- invoice is never overdue in a test.
insert or ignore into tax_gcc__sequences (prefix, next) values ('INV', 2);
insert or ignore into tax_gcc__documents (number, kind, against, body, standard, zero, exempt, vat, issued_at) values
  ('INV-000001', 'invoice', null,
   json_object(
     'kind', 'invoice',
     'title', json_object('en', 'Tax Invoice', 'ar', 'فاتورة ضريبية'),
     'number', 'INV-000001',
     'issued_at', (cast(strftime('%s', 'now', '-5 days') as integer) * 1000),
     'seller', json_object('name', 'FixIt Services LLC', 'trn', '100000000000003', 'address', 'Dubai'),
     'buyer', json_object('name', 'Layla Haddad', 'trn', null, 'address', 'Apartment, Dubai Marina, Marina Crown, flat 1203'),
     'lines', json_array(
       json_object('description', 'Plumbing', 'quantity', 1, 'unit_fils', 16000, 'rate', 'standard', 'net_fils', 16000, 'vat_fils', 800),
       json_object('description', 'Kitchen mixer tap', 'quantity', 1, 'unit_fils', 18000, 'rate', 'standard', 'net_fils', 18000, 'vat_fils', 900)),
     'totals', json_object('standard', 34000, 'zero', 0, 'exempt', 0, 'vat', 1700, 'total', 35700, 'vat_rate', 5, 'currency', 'AED',
       'display', json_object('standard', '340.00', 'zero', '0.00', 'exempt', '0.00', 'vat', '17.00', 'total', '357.00'))),
   34000, 0, 0, 1700, (cast(strftime('%s', 'now', '-5 days') as integer) * 1000));

insert or ignore into app__job_invoices (job_id, branch_id, customer_id, invoice_id, total_fils, due_at, credit_note_id, created_by, created_at) values
  ('jb_seed_13', 'br_dubai', 'cu_dxb_01', 'INV-000001', 35700, (cast(strftime('%s', 'now', '+25 days') as integer)), null, 'u_dxb_accountant', (cast(strftime('%s', 'now', '-5 days') as integer)));

insert or ignore into app__payments (id, branch_id, invoice_id, method, amount_fils, received_at, reference, cheque_number, cheque_date, recorded_by, created_at) values
  (1, 'br_dubai', 'INV-000001', 'cheque', 15000, (cast(strftime('%s', 'now', '-3 days') as integer)), 'First instalment', '000123', '2026-11-05', 'u_dxb_accountant', (cast(strftime('%s', 'now', '-3 days') as integer)));

-- Maintenance contracts (F7-126): one active contract per branch, a property
-- manager each. Days are Dubai days relative to the day the seed is loaded, and
-- every next visit is more than 14 days away, so the visits job makes no job
-- until a test (or the calendar) brings one due. No upfront invoice is seeded.
-- The Dubai contract is 300 days into its year, so it ends in 64 days: the AMC
-- report (renewals due in the next 90 days) lists it.
insert or ignore into app__contract_numbers (n, contract_id) values (1, 'ct_seed_01'), (2, 'ct_seed_02');

insert or ignore into app__contracts (id, branch_id, customer_id, number, status, starts_on, ends_on, price_fils, vat_rate, billing, notes, invoice_id, renewed_from, renewal_notified_on, created_by, created_at, activated_at) values
  ('ct_seed_01', 'br_dubai', 'cu_dxb_04', 'AMC-000001', 'active', date('now', '+4 hours', '-300 days'), date('now', '+4 hours', '-300 days', '+364 days'), 480000, 5, 'upfront', 'Monthly AC service of Tower A, quarterly pest control of Tower B.', null, null, null, 'u_dxb_dispatcher', cast(strftime('%s', 'now', '-300 days') as integer), cast(strftime('%s', 'now', '-300 days') as integer)),
  ('ct_seed_02', 'br_sharjah', 'cu_shj_04', 'AMC-000002', 'active', date('now', '+4 hours', '-30 days'), date('now', '+4 hours', '-30 days', '+364 days'), 240000, 5, 'upfront', 'Twice a year deep cleaning of the main tower.', null, null, null, 'u_shj_dispatcher', cast(strftime('%s', 'now', '-30 days') as integer), cast(strftime('%s', 'now', '-30 days') as integer));

insert or ignore into app__contract_items (id, contract_id, branch_id, site_id, service_id, visits_per_year, next_visit_on) values
  (1, 'ct_seed_01', 'br_dubai', 'st_dxb_04a', (select id from app__services where code = 'AC-SERVICE'), 12, date('now', '+4 hours', '+20 days')),
  (2, 'ct_seed_01', 'br_dubai', 'st_dxb_04b', (select id from app__services where code = 'PEST'), 4, date('now', '+4 hours', '+50 days')),
  (3, 'ct_seed_02', 'br_sharjah', 'st_shj_04a', (select id from app__services where code = 'DEEP-CLEAN'), 2, date('now', '+4 hours', '+40 days'));
