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
insert into public.buildings (name, display_order) values
  ('Photocopy Center', 1),
  ('Administration',   2),
  ('Building 1',       3),
  ('Building 2',       4),
  ('Building 3',       5),
  ('Building 4',       6),
  ('IT Office',        7)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------
insert into public.tasks (name, display_order) values
  ('Photocopying',      1),
  ('Printer repair',    2),
  ('Computer repair',   3),
  ('School system',     4),
  ('Projector',         5),
  ('Network / WiFi',    6),
  ('Administration',    7),
  ('Helping employee',  8),
  ('Meeting',           9),
  ('Equipment setup',  10),
  ('Other',            11)
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
