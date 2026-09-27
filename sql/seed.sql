-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  seed.sql
--  Run LAST. Safe to re-run: every statement is idempotent.
--
--  This file contains real starting configuration, not demo data.
--  There are no fake requests, no fake status history and no fake users.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Application settings
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value) values
  -- Show the status board to visitors who are not signed in.
  -- Set to false to require an employee login before anything is visible.
  ('public_dashboard',   'true'::jsonb),
  -- Anyone who is not signed in can still SEE the board, but sending a
  -- request always requires an account.
  ('org_timezone',       '"Asia/Beirut"'::jsonb),
  ('org_name',           '"Our Organisation"'::jsonb),
  ('tracked_person',     '"Haitham"'::jsonb),
  -- Quick duration buttons on the status screen, in minutes.
  ('quick_durations',    '[5, 10, 15, 20, 30, 45, 60, 120]'::jsonb),
  -- Working hours, used only to make reports readable.
  ('workday_start_hour', '7'::jsonb),
  ('workday_end_hour',   '16'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Buildings / locations
-- ---------------------------------------------------------------------
insert into public.buildings (name, name_ar, display_order) values
  ('Rihab Zahraa HS',        'مبنى الثانوية',        1),
  ('Rihab Zahraa BE',        'مبنى التعليم الأساسي', 2),
  ('KG Building',            'مبنى الروضات',         3),
  ('Papyrus',                'بابيروس',              4),
  ('AFAAK Vocational',       'معهد الآفاق',          5),
  ('Headquarters',           'مبنى الإدارات',        6),
  ('Rihab Zahraa Orphanage', 'المبرة',               7),
  ('Photocopy Center',       'مركز التصوير',         8),
  ('IT Office',              'مكتب المعلوماتية',     9)
on conflict do nothing;

-- Somewhere off site is not a building row: the location dropdown ends
-- with "+ Other / custom location", which records free text for that one
-- event without adding it to this list.

-- ---------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------
insert into public.tasks (name, name_ar, display_order) values
  ('Photocopying',     'التصوير',            1),
  ('Printer repair',   'تصليح الطابعة',      2),
  ('Computer repair',  'تصليح الكمبيوتر',    3),
  ('School system',    'النظام المدرسي',     4),
  ('Projector',        'جهاز العرض',         5),
  ('Network / WiFi',   'الشبكة / الواي فاي', 6),
  ('Administration',   'الإدارة',            7),
  ('Helping employee', 'مساعدة موظف',        8),
  ('Meeting',          'اجتماع',             9),
  ('Equipment setup',  'تجهيز المعدات',     10),
  ('Other',            'أخرى',              11)
on conflict do nothing;

-- =====================================================================
--  MAKE HAITHAM AN ADMINISTRATOR
--  ---------------------------------------------------------------
--  Roles are never self-assigned, so the very first admin has to be
--  promoted here by hand:
--
--    1. Create the account through the app's sign-up page (or in
--       Supabase Studio -> Authentication -> Users -> Add user).
--    2. Replace the address below with that account's e-mail.
--    3. Run just this statement.
--
--  update public.profiles
--     set role = 'admin', active = true
--   where lower(email) = lower('haitham@example.com');
--
--  Verify with:
--    select full_name, email, role, active from public.profiles order by created_at;
-- =====================================================================
