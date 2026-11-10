-- A busy day for the Lighthouse runs (#728): applied by `bench/lighthouse/run.ts --busy`
-- after examples/home-services/seeds/001_demo.sql, never part of the app's template.
-- 200 jobs of the Dubai branch spread over the board's columns and six technicians,
-- and a visit with 12 photos (6 before, 6 after) on the technician's first scheduled
-- job (jb_seed_05, Ali's). Deterministic: fixed ids and numbers; dates are computed
-- from the day the seed is loaded (local midnight, UTC+4, as the demo seed does).
--
-- Columns: 80 new (no technician, no time), 60 scheduled, 12 en route, 18 in progress,
-- 30 done (today). Every scheduled job starts after 10:00, so Ali's first scheduled
-- job stays jb_seed_05 (10:00) and the visit page the run measures does not move.
-- The photos use the demo seed's placeholder: a file key with no stored object and
-- width and height null, which the page renders as "not stored".

insert or ignore into auth__users (id, email, display_name, password_hash, email_verified_at, created_at, updated_at)
select 'u_dxb_busy_' || t.n, 'tech' || t.n || '.dubai@fixit.example', t.name, (select password_hash from auth__users where id = 'u_dxb_ali'), 1793000000, 1793000000, 1793000000
from (select 3 as n, 'Carlos Mendes' as name union all select 4, 'Dmitri Volkov' union all select 5, 'Emeka Obi' union all select 6, 'Farid Nasser') t;

insert or ignore into org__members (org_id, user_id, role, created_at)
select 'org_dubai', 'u_dxb_busy_' || n, 'member', 1793000000 from (select 3 as n union all select 4 union all select 5 union all select 6);

insert or ignore into renox__role_assignments (user_id, role, scope_type, scope_id, granted_by, at)
select 'u_dxb_busy_' || n, 'technician', 'global', '', 'seed', 1793000000000 from (select 3 as n union all select 4 union all select 5 union all select 6);

with recursive n(i) as (select 1 union all select i + 1 from n where i < 200)
insert or ignore into app__jobs (id, branch_id, customer_id, site_id, quote_id, number, status, priority, service_id, description, scheduled_start, scheduled_end, technician_user_id, booking_id, created_by, created_at, updated_at)
select
  'jb_busy_' || printf('%03d', i),
  'br_dubai',
  'cu_dxb_0' || (1 + i % 5),
  (select id from app__sites where customer_id = 'cu_dxb_0' || (1 + i % 5) order by id limit 1),
  null,
  'J-1' || printf('%05d', i),
  case when i <= 80 then 'new' when i <= 140 then 'scheduled' when i <= 152 then 'en_route' when i <= 170 then 'in_progress' else 'done' end,
  case i % 4 when 0 then 'low' when 1 then 'normal' when 2 then 'high' else 'urgent' end,
  (select s.id from app__services s where (select count(*) from app__services s2 where s2.id < s.id) = i % 6),
  'Busy-day job ' || printf('%03d', i),
  case when i <= 80 then null
       when i <= 170 then (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 39600 + ((i - 81) / 6) * 1200)
       else (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 28800 + ((i - 171) / 6) * 1200) end,
  case when i <= 80 then null
       when i <= 170 then (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 39600 + ((i - 81) / 6) * 1200 + 3600)
       else (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 28800 + ((i - 171) / 6) * 1200 + 3600) end,
  case when i <= 80 then null else case i % 6 when 0 then 'u_dxb_ali' when 1 then 'u_dxb_bilal' when 2 then 'u_dxb_busy_3' when 3 then 'u_dxb_busy_4' when 4 then 'u_dxb_busy_5' else 'u_dxb_busy_6' end end,
  null,
  'u_dxb_dispatcher',
  1793400000,
  1793400000
from n;

-- The technician's first visit (Ali's jb_seed_05), checked in, with 12 photos.
insert or ignore into app__visits (id, branch_id, job_id, technician_user_id, checkin_at, notes, technician_name)
values ('vs_busy_05', 'br_dubai', 'jb_seed_05', 'u_dxb_ali', (cast(strftime('%s','now','+4 hours','start of day','-4 hours') as integer) + 36300), 'Three units to service.', 'Ali Hassan');

with recursive n(i) as (select 1 union all select i + 1 from n where i < 12)
insert into app__visit_photos (branch_id, visit_id, phase, file_key, caption, created_at)
select 'br_dubai', 'vs_busy_05', case when i <= 6 then 'before' else 'after' end,
  'app/visits/vs_busy_05/' || case when i <= 6 then 'before' else 'after' end || '/busy-' || printf('%02d', i) || '.png',
  case when i <= 6 then 'Unit ' || i || ' before' else 'Unit ' || (i - 6) || ' after' end, 1793400100
from n
where not exists (select 1 from app__visit_photos where visit_id = 'vs_busy_05');
