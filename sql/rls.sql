-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  rls.sql
--  Run AFTER schema.sql and functions.sql.
--
--  Security model
--  --------------
--  * Nothing that matters is writable directly from the browser. Every
--    state change goes through a SECURITY DEFINER function in
--    functions.sql that re-checks the caller's role. Table level INSERT/
--    UPDATE/DELETE grants are revoked from anon/authenticated for those
--    tables, so a stolen anon key cannot forge a status or a request.
--  * Employees can read: the public board, the building/task lists,
--    their own profile, their own requests and their own notifications.
--    Nothing else. They cannot enumerate other people's requests.
--  * Anonymous visitors can read the public board only, and only while
--    the "public_dashboard" setting is true.
-- =====================================================================

alter table public.profiles           enable row level security;
alter table public.app_settings       enable row level security;
alter table public.buildings          enable row level security;
alter table public.tasks              enable row level security;
alter table public.service_requests   enable row level security;
alter table public.request_history    enable row level security;
alter table public.status_history     enable row level security;
alter table public.current_status     enable row level security;
alter table public.notifications      enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.audit_log          enable row level security;
alter table public.public_board       enable row level security;
alter table public.request_counters   enable row level security;

-- ---------------------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------------------
drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- A user may edit their OWN row, but column grants below narrow that to
-- full_name only, and guard_profile_privileges() blocks role/active
-- changes outright. Without both, this policy would let any employee
-- promote themselves to administrator.
drop policy if exists profiles_update_own_name on public.profiles;
create policy profiles_update_own_name on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------
-- APP SETTINGS  (readable by everyone: the dashboard needs to know
-- whether public viewing is enabled before it can render anything)
-- ---------------------------------------------------------------------
drop policy if exists settings_read_all on public.app_settings;
create policy settings_read_all on public.app_settings
  for select to anon, authenticated using (true);

drop policy if exists settings_admin_write on public.app_settings;
create policy settings_admin_write on public.app_settings
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- BUILDINGS
-- ---------------------------------------------------------------------
drop policy if exists buildings_read_auth on public.buildings;
create policy buildings_read_auth on public.buildings
  for select to authenticated using (true);

drop policy if exists buildings_read_anon on public.buildings;
create policy buildings_read_anon on public.buildings
  for select to anon using (active and public.setting_bool('public_dashboard', true));

drop policy if exists buildings_admin_write on public.buildings;
create policy buildings_admin_write on public.buildings
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- TASKS
-- ---------------------------------------------------------------------
drop policy if exists tasks_read_auth on public.tasks;
create policy tasks_read_auth on public.tasks
  for select to authenticated using (true);

drop policy if exists tasks_read_anon on public.tasks;
create policy tasks_read_anon on public.tasks
  for select to anon using (active and public.setting_bool('public_dashboard', true));

drop policy if exists tasks_admin_write on public.tasks;
create policy tasks_admin_write on public.tasks
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- SERVICE REQUESTS
--   Read own, or everything if admin. Writes happen only through RPCs.
-- ---------------------------------------------------------------------
drop policy if exists requests_read_own_or_admin on public.service_requests;
create policy requests_read_own_or_admin on public.service_requests
  for select to authenticated
  using (requester_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------
-- REQUEST HISTORY
-- ---------------------------------------------------------------------
drop policy if exists request_history_read on public.request_history;
create policy request_history_read on public.request_history
  for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.service_requests sr
                where sr.id = request_id and sr.requester_id = auth.uid())
  );

-- ---------------------------------------------------------------------
-- STATUS HISTORY  (administrative reporting data)
-- ---------------------------------------------------------------------
drop policy if exists status_history_admin_read on public.status_history;
create policy status_history_admin_read on public.status_history
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- CURRENT STATUS
--   Signed-in users may read it. Anonymous visitors only while the
--   public dashboard is enabled. Realtime honours these policies, which
--   is what lets dashboards subscribe without any server of our own.
-- ---------------------------------------------------------------------
drop policy if exists current_status_read_auth on public.current_status;
create policy current_status_read_auth on public.current_status
  for select to authenticated using (true);

drop policy if exists current_status_read_anon on public.current_status;
create policy current_status_read_anon on public.current_status
  for select to anon using (public.setting_bool('public_dashboard', true));

-- ---------------------------------------------------------------------
-- PUBLIC BOARD  (pre-filtered snapshot -- safe for everyone)
-- ---------------------------------------------------------------------
drop policy if exists board_read_auth on public.public_board;
create policy board_read_auth on public.public_board
  for select to authenticated using (true);

drop policy if exists board_read_anon on public.public_board;
create policy board_read_anon on public.public_board
  for select to anon using (public.setting_bool('public_dashboard', true));

-- ---------------------------------------------------------------------
-- NOTIFICATIONS
-- ---------------------------------------------------------------------
drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications
  for select to authenticated using (user_id = auth.uid());

drop policy if exists notifications_own_update on public.notifications;
create policy notifications_own_update on public.notifications
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- PUSH SUBSCRIPTIONS  (a subscription is a credential -- owner only)
-- ---------------------------------------------------------------------
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists push_own_delete on public.push_subscriptions;
create policy push_own_delete on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- AUDIT LOG
-- ---------------------------------------------------------------------
drop policy if exists audit_admin_read on public.audit_log;
create policy audit_admin_read on public.audit_log
  for select to authenticated using (public.is_admin());

-- request_counters intentionally has NO policy: it is reachable only
-- from next_request_number(), which is SECURITY DEFINER.

-- =====================================================================
--  TABLE GRANTS
--  Supabase grants ALL on public tables to anon/authenticated by
--  default. Strip the write bits so the only write path is an RPC.
-- =====================================================================
revoke insert, update, delete on public.service_requests   from anon, authenticated;
revoke insert, update, delete on public.request_history    from anon, authenticated;
revoke insert, update, delete on public.status_history     from anon, authenticated;
revoke insert, update, delete on public.current_status     from anon, authenticated;
revoke insert, update, delete on public.public_board       from anon, authenticated;
revoke insert, update, delete on public.audit_log          from anon, authenticated;
revoke insert, update, delete on public.request_counters   from anon, authenticated;
revoke select                 on public.request_counters   from anon, authenticated;
revoke insert, update         on public.push_subscriptions from anon, authenticated;
revoke insert, delete         on public.profiles           from anon, authenticated;
revoke insert, delete         on public.notifications      from anon, authenticated;

-- Column-level grants: the only field a user may write on their own
-- profile is their display name, and the only field they may write on a
-- notification is the read flag. Role and active are changed exclusively
-- through admin_set_user_role / admin_set_user_active.
revoke update on public.profiles      from anon, authenticated;
revoke update on public.notifications from anon, authenticated;
grant  update (full_name) on public.profiles      to authenticated;
grant  update (read)      on public.notifications to authenticated;

-- Buildings, tasks and app_settings stay directly writable, but only
-- admins get past the RLS policies above.
grant select, insert, update on public.buildings    to authenticated;
grant select, insert, update on public.tasks        to authenticated;
grant select, insert, update on public.app_settings to authenticated;

-- Historical integrity: buildings and tasks are disabled, never deleted.
revoke delete on public.buildings from anon, authenticated;
revoke delete on public.tasks     from anon, authenticated;


-- =====================================================================
--  PRIVILEGE GUARD
--  Defence in depth behind the column grants above: even if a future
--  migration widens them by accident, role and active can still only be
--  changed by an administrator.
-- =====================================================================
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  -- NOT SECURITY DEFINER on purpose: this function needs to see the role
  -- the statement is really running as. A SECURITY DEFINER function would
  -- report its owner (postgres) here and the check below would be useless.
  --
  -- PostgREST runs every API request as `anon` or `authenticated`, so those
  -- are the only roles this guard applies to. A direct connection (the
  -- Supabase SQL editor, psql, a migration, the service-role key) is a
  -- database administrator and is trusted -- that is how the very first
  -- admin gets promoted, since auth.uid() is NULL with no JWT present.
  v_via_api  boolean := current_user in ('anon', 'authenticated');
begin
  if not v_via_api then
    return new;
  end if;

  if (new.role is distinct from old.role or new.active is distinct from old.active)
     and not public.is_admin() then
    raise exception 'Only an administrator can change a role or deactivate an account'
      using errcode = '42501';
  end if;

  return new;
end;
$fn$;

drop trigger if exists guard_profiles on public.profiles;
create trigger guard_profiles
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();
