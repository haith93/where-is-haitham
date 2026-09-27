-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-public-requests.sql
--
--  ONE-TIME MIGRATION for an existing database.
--  Run it once, after schema.sql / functions.sql / rls.sql / seed.sql.
--  A brand new project can skip it: the base files already contain
--  everything below.
--
--  WHAT CHANGES
--  ------------
--  1. Employees no longer sign in at all. A request is submitted by an
--     anonymous visitor through one narrowly scoped RPC.
--  2. Haitham can record a request that arrived by phone, WhatsApp or in
--     person, so every request ends up as one standardised record.
--  3. Every request remembers HOW it arrived (its channel).
--  4. The access-code / anonymous-account system is removed completely.
--
--  SECURITY NOTE
--  -------------
--  `anon` gets EXECUTE on exactly two functions and SELECT on nothing
--  except the pre-filtered board and the building/task lists. It cannot
--  read the requests table, cannot modify anything, and cannot reach any
--  administrative function.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. SERVICE REQUESTS: new shape
-- ---------------------------------------------------------------------

-- A public requester has no account, so there is no profile to point at.
-- The name they typed lives in requester_name_snapshot, as it always did.
alter table public.service_requests
  alter column requester_id drop not null;

-- How the request reached Haitham.
alter table public.service_requests
  add column if not exists channel text not null default 'app';

do $do$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'service_requests_channel_check'
  ) then
    alter table public.service_requests
      add constraint service_requests_channel_check
      check (channel in ('app', 'whatsapp', 'phone', 'in_person', 'other'));
  end if;
end
$do$;

-- Who recorded it, when Haitham enters it on someone's behalf.
alter table public.service_requests
  add column if not exists created_by uuid references public.profiles (id) on delete set null;

-- Free-text note, used mostly for manually recorded requests.
alter table public.service_requests
  add column if not exists notes text check (notes is null or char_length(notes) <= 1000);

-- Lets the person who submitted a request follow it on their own device
-- without an account. It is returned once, at creation, and is the only
-- way to read a single request anonymously.
alter table public.service_requests
  add column if not exists public_token uuid not null default gen_random_uuid();

create index if not exists sr_token_idx   on public.service_requests (public_token);
create index if not exists sr_channel_idx on public.service_requests (channel);

-- ---------------------------------------------------------------------
-- 2. ABUSE CONTROL FOR ANONYMOUS SUBMISSIONS
--    No login means no natural rate limit, so the RPC enforces its own.
--    `device_id` is a random value the browser keeps in localStorage. It
--    is trivially resettable, which is why the global cap exists too.
-- ---------------------------------------------------------------------
create table if not exists public.request_throttle (
  device_id    text primary key,
  count        integer not null default 0,
  window_start timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

alter table public.request_throttle enable row level security;
revoke all on public.request_throttle from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. REMOVE THE ACCESS-CODE SYSTEM
--    Employees no longer authenticate, so none of this has a purpose.
--    Dropping it also removes the RLS policies that referenced it.
-- ---------------------------------------------------------------------
drop function if exists public.claim_staff_access(text, text);
drop function if exists public.set_staff_access_code(text, text);
drop function if exists public.access_options();
drop function if exists public.purge_unclaimed_guests(interval);
drop table if exists public.access_codes;
drop table if exists public.access_attempts;

delete from public.app_settings where key = 'public_dashboard';

-- The board is now unconditionally public: with no employee login, a
-- private board would simply be a board nobody could read.
drop policy if exists board_read_anon         on public.public_board;
drop policy if exists current_status_read_anon on public.current_status;
drop policy if exists buildings_read_anon     on public.buildings;
drop policy if exists tasks_read_anon         on public.tasks;

create policy board_read_anon on public.public_board
  for select to anon using (true);

create policy current_status_read_anon on public.current_status
  for select to anon using (true);

create policy buildings_read_anon on public.buildings
  for select to anon using (active);

create policy tasks_read_anon on public.tasks
  for select to anon using (active);

-- Anonymous accounts created by the old join flow are no longer usable.
-- Their requests are kept; only the empty, never-used ones go.
delete from auth.users u
 where (u.email is null or u.email = '')
   and not exists (select 1 from public.service_requests sr where sr.requester_id = u.id);

-- ---------------------------------------------------------------------
-- 4. NEW-USER TRIGGER (no more anonymous sign-ups)
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_name text;
begin
  v_name := nullif(trim(new.raw_user_meta_data ->> 'full_name'), '');
  if v_name is null then
    v_name := split_part(coalesce(new.email, 'user'), '@', 1);
  end if;

  insert into public.profiles (id, full_name, email, role, active)
  values (
    new.id,
    left(v_name, 120),
    new.email,
    'employee',                       -- admins are promoted manually, never self-assigned
    public.setting_bool('allow_email_signup', true)
  )
  on conflict (id) do nothing;
  return new;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 5. PUBLIC SUBMISSION
--    The single write an anonymous visitor may perform. Everything is
--    validated here; the table itself stays unreachable.
-- ---------------------------------------------------------------------
create or replace function public.create_public_request(
  p_requester_name  text,
  p_building_id     uuid    default null,
  p_custom_location text    default null,
  p_task_id         uuid    default null,
  p_custom_category text    default null,
  p_description     text    default null,
  p_priority        text    default 'normal',
  p_device_id       text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_name     text;
  v_loc      text;
  v_cat      text;
  v_device   text := left(coalesce(nullif(trim(p_device_id), ''), 'unknown'), 64);
  v_count    integer;
  v_window   timestamptz;
  v_row      public.service_requests;
  v_ahead    integer;
  v_admin    uuid;
begin
  /* ---- validation ------------------------------------------------ */
  v_name := nullif(trim(regexp_replace(coalesce(p_requester_name, ''), '\s+', ' ', 'g')), '');
  if v_name is null or char_length(v_name) < 2 then
    raise exception 'Please enter your name' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'That name is too long' using errcode = '22023';
  end if;

  if p_priority not in ('normal', 'urgent', 'very_urgent') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;

  p_custom_location := nullif(trim(coalesce(p_custom_location, '')), '');
  p_custom_category := nullif(trim(coalesce(p_custom_category, '')), '');
  p_description     := nullif(trim(coalesce(p_description, '')), '');

  if char_length(coalesce(p_description, '')) > 1000 then
    raise exception 'Please shorten the description' using errcode = '22023';
  end if;

  v_loc := coalesce(public.building_name(p_building_id), p_custom_location);
  v_cat := coalesce(public.task_name(p_task_id), p_custom_category);

  if v_loc is null then
    raise exception 'Please choose where you are' using errcode = '22023';
  end if;
  if v_cat is null then
    raise exception 'Please choose what you need' using errcode = '22023';
  end if;

  /* ---- abuse control ---------------------------------------------- */
  -- Per device: at most 5 requests in a rolling 10 minutes.
  insert into public.request_throttle (device_id) values (v_device)
  on conflict (device_id) do nothing;

  select count, window_start into v_count, v_window
    from public.request_throttle where device_id = v_device for update;

  if v_window < now() - interval '10 minutes' then
    update public.request_throttle
       set count = 0, window_start = now()
     where device_id = v_device;
    v_count := 0;
  end if;

  if v_count >= 5 then
    raise exception 'You have sent several requests already. Please wait a few minutes before sending another.'
      using errcode = '53400';
  end if;

  -- Global safety net, so a reset device id cannot be used to flood.
  if (select count(*) from public.service_requests
       where created_at > now() - interval '5 minutes') >= 40 then
    raise exception 'The system is unusually busy right now. Please try again shortly.'
      using errcode = '53400';
  end if;

  -- The same person asking for the same thing twice in a row is almost
  -- always a double tap, not a second problem.
  if exists (
    select 1 from public.service_requests
     where status in ('pending', 'accepted', 'in_progress')
       and lower(requester_name_snapshot) = lower(v_name)
       and location_name_snapshot = v_loc
       and category_name_snapshot = v_cat
       and created_at > now() - interval '3 minutes'
  ) then
    raise exception 'You already sent this request a moment ago. Haitham has it.'
      using errcode = '23505';
  end if;

  /* ---- write ------------------------------------------------------ */
  insert into public.service_requests (
    request_number, requester_id, requester_name_snapshot,
    location_building_id, custom_location, location_name_snapshot,
    category_task_id, custom_category, category_name_snapshot,
    description, priority, status, channel,
    queue_position
  ) values (
    public.next_request_number(), null, v_name,
    p_building_id, p_custom_location, v_loc,
    p_task_id, p_custom_category, v_cat,
    p_description, p_priority, 'pending', 'app',
    coalesce((select max(queue_position) + 1 from public.service_requests
               where status in ('pending', 'accepted')), 0)
  )
  returning * into v_row;

  update public.request_throttle
     set count = count + 1, last_seen = now()
   where device_id = v_device;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (v_row.id, null, null, 'pending', 'Submitted from the app');

  for v_admin in select id from public.profiles where role = 'admin' and active loop
    insert into public.notifications (user_id, request_id, title, message, type)
    values (
      v_admin, v_row.id,
      case v_row.priority
        when 'very_urgent' then 'VERY URGENT request'
        when 'urgent'      then 'Urgent request'
        else 'New request' end,
      v_name || ' - ' || v_loc || ' - ' || v_cat,
      'new_request'
    );
  end loop;

  select count(*) into v_ahead
    from public.service_requests
   where status in ('pending', 'accepted') and id <> v_row.id;

  -- Only what the requester needs; never the whole row.
  return jsonb_build_object(
    'request_number', v_row.request_number,
    'public_token',   v_row.public_token,
    'created_at',     v_row.created_at,
    'people_ahead',   v_ahead
  );
end;
$fn$;

-- ---------------------------------------------------------------------
-- 6. FOLLOW YOUR OWN REQUEST
--    Requires the unguessable token handed back at creation, so nobody
--    can walk the table by guessing request numbers.
-- ---------------------------------------------------------------------
create or replace function public.get_request_by_token(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'request_number', sr.request_number,
    'requester',      sr.requester_name_snapshot,
    'location',       sr.location_name_snapshot,
    'category',       sr.category_name_snapshot,
    'description',    sr.description,
    'priority',       sr.priority,
    'status',         sr.status,
    'channel',        sr.channel,
    'created_at',     sr.created_at,
    'accepted_at',    sr.accepted_at,
    'started_at',     sr.started_at,
    'completed_at',   sr.completed_at,
    'people_ahead',   (select count(*) from public.service_requests q
                        where q.status in ('pending', 'accepted')
                          and q.created_at < sr.created_at)
  )
  from public.service_requests sr
  where sr.public_token = p_token;
$fn$;

-- Cancelling your own request, with the same token.
create or replace function public.cancel_request_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_row public.service_requests;
begin
  select * into v_row from public.service_requests where public_token = p_token for update;
  if v_row is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_row.status not in ('pending', 'accepted') then
    raise exception 'This request can no longer be cancelled' using errcode = '42501';
  end if;

  update public.service_requests
     set status = 'cancelled', cancelled_at = now()
   where id = v_row.id
  returning * into v_row;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (v_row.id, null, 'pending', 'cancelled', 'Cancelled by the requester');

  update public.current_status set next_request_id = null where next_request_id = v_row.id;

  return jsonb_build_object('request_number', v_row.request_number, 'status', v_row.status);
end;
$fn$;

-- ---------------------------------------------------------------------
-- 7. RECORDING A REQUEST ON SOMEONE'S BEHALF
--    A phone call, a WhatsApp message or someone stopping Haitham in a
--    corridor becomes the same standardised record as an app request.
-- ---------------------------------------------------------------------
create or replace function public.admin_create_request(
  p_requester_name  text,
  p_channel         text,
  p_building_id     uuid    default null,
  p_custom_location text    default null,
  p_task_id         uuid    default null,
  p_custom_category text    default null,
  p_description     text    default null,
  p_priority        text    default 'normal',
  p_notes           text    default null,
  p_start_now       boolean default false,
  p_duration_minutes integer default null
)
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid  uuid := auth.uid();
  v_name text;
  v_loc  text;
  v_cat  text;
  v_row  public.service_requests;
begin
  if not public.is_admin() then
    raise exception 'Administrators only' using errcode = '42501';
  end if;

  v_name := nullif(trim(regexp_replace(coalesce(p_requester_name, ''), '\s+', ' ', 'g')), '');
  if v_name is null or char_length(v_name) < 2 then
    raise exception 'Please enter who asked for help' using errcode = '22023';
  end if;
  if p_channel not in ('app', 'whatsapp', 'phone', 'in_person', 'other') then
    raise exception 'Unknown channel' using errcode = '22023';
  end if;
  if p_priority not in ('normal', 'urgent', 'very_urgent') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;

  p_custom_location := nullif(trim(coalesce(p_custom_location, '')), '');
  p_custom_category := nullif(trim(coalesce(p_custom_category, '')), '');
  p_description     := nullif(trim(coalesce(p_description, '')), '');
  p_notes           := nullif(trim(coalesce(p_notes, '')), '');

  v_loc := coalesce(public.building_name(p_building_id), p_custom_location);
  v_cat := coalesce(public.task_name(p_task_id), p_custom_category);

  if v_loc is null then
    raise exception 'Please choose a location' using errcode = '22023';
  end if;
  if v_cat is null then
    raise exception 'Please choose what they need' using errcode = '22023';
  end if;

  -- created_at is now(): the time it was RECORDED. Server generated, as
  -- everywhere else in this application.
  insert into public.service_requests (
    request_number, requester_id, requester_name_snapshot,
    location_building_id, custom_location, location_name_snapshot,
    category_task_id, custom_category, category_name_snapshot,
    description, priority, status, channel, notes, created_by,
    queue_position
  ) values (
    public.next_request_number(), null, v_name,
    p_building_id, p_custom_location, v_loc,
    p_task_id, p_custom_category, v_cat,
    p_description, p_priority, 'pending', p_channel, p_notes, v_uid,
    coalesce((select max(queue_position) + 1 from public.service_requests
               where status in ('pending', 'accepted')), 0)
  )
  returning * into v_row;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (v_row.id, v_uid, null, 'pending',
          'Recorded by the administrator (' || p_channel || ')');

  -- One flow: record it and start work straight away.
  if p_start_now then
    v_row := public.start_request(v_row.id, p_duration_minutes);
  end if;

  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 8. THE OLD AUTHENTICATED SUBMISSION IS GONE
-- ---------------------------------------------------------------------
drop function if exists public.create_service_request(uuid, text, uuid, text, text, text);

-- ---------------------------------------------------------------------
-- 9. GRANTS
--    anon may call exactly three functions: read the board, submit a
--    request, and follow/cancel its own request by token.
-- ---------------------------------------------------------------------
revoke all on function public.create_public_request(text, uuid, text, uuid, text, text, text, text) from public;
revoke all on function public.get_request_by_token(uuid) from public;
revoke all on function public.cancel_request_by_token(uuid) from public;
revoke all on function public.admin_create_request(text, text, uuid, text, uuid, text, text, text, text, boolean, integer) from public;

grant execute on function public.create_public_request(text, uuid, text, uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.get_request_by_token(uuid)                                            to anon, authenticated;
grant execute on function public.cancel_request_by_token(uuid)                                         to anon, authenticated;
grant execute on function public.admin_create_request(text, text, uuid, text, uuid, text, text, text, text, boolean, integer) to authenticated;
grant execute on function public.get_public_status()                                                   to anon, authenticated;

-- ---------------------------------------------------------------------
-- 10. THE BOARD READER NO LONGER CONSULTS A "PUBLIC?" SETTING
--     There is no employee login any more, so the board is always
--     readable. Removing the check also removes the last reference to
--     the deleted public_dashboard setting.
-- ---------------------------------------------------------------------
create or replace function public.get_public_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare v_snap jsonb;
begin
  select nullif(snapshot, '{}'::jsonb) into v_snap from public.public_board where id = 1;
  return coalesce(v_snap, public.build_public_snapshot());
end;
$fn$;

commit;

notify pgrst, 'reload schema';
