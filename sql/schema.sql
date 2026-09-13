-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  schema.sql
--  Run this FIRST in the Supabase SQL editor, then rls.sql, then seed.sql.
--
--  Design notes
--  ------------
--  * All timestamps are TIMESTAMPTZ stored in UTC. Conversion to
--    Asia/Beirut happens in the browser via Intl.DateTimeFormat.
--  * The browser NEVER supplies a start or end time. Every write that
--    involves a clock goes through an RPC (see functions.sql) that
--    calls now() inside the database.
--  * "expected_end_at" (start + chosen duration) and "actual_end_at"
--    (written only when a real transition happens) are deliberately
--    separate. Reports use actual time; the UI shows expected time.
--  * Historical rows keep *_name_snapshot so renaming a building or a
--    task never silently rewrites old reports.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1. PROFILES
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null check (char_length(trim(full_name)) between 1 and 120),
  email       text,
  role        text not null default 'employee' check (role in ('admin', 'employee')),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is 'Application user record, 1:1 with auth.users.';

-- Create a profile automatically whenever someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    new.email,
    'employee'          -- admins are promoted manually; never self-assigned
  )
  on conflict (id) do nothing;
  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helpers used by RLS policies. SECURITY DEFINER so that reading the
-- caller's own role does not recurse into the profiles policies.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active
  );
$fn$;

create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.profiles where id = auth.uid() and active
  );
$fn$;

-- ---------------------------------------------------------------------
-- 2. SETTINGS
-- ---------------------------------------------------------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.setting_bool(p_key text, p_default boolean default false)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(
    (select (value #>> '{}')::boolean from public.app_settings where key = p_key),
    p_default
  );
$fn$;

-- ---------------------------------------------------------------------
-- 3. BUILDINGS / LOCATIONS
-- ---------------------------------------------------------------------
create table if not exists public.buildings (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(trim(name)) between 1 and 80),
  active        boolean not null default true,
  display_order integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists buildings_name_key on public.buildings (lower(trim(name)));
create index if not exists buildings_active_order_idx on public.buildings (active, display_order);

-- ---------------------------------------------------------------------
-- 4. TASKS
-- ---------------------------------------------------------------------
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(trim(name)) between 1 and 80),
  active        boolean not null default true,
  display_order integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists tasks_name_key on public.tasks (lower(trim(name)));
create index if not exists tasks_active_order_idx on public.tasks (active, display_order);

-- ---------------------------------------------------------------------
-- 5. SERVICE REQUESTS
-- ---------------------------------------------------------------------
create table if not exists public.request_counters (
  year        integer primary key,
  last_number integer not null default 0
);

create or replace function public.next_request_number()
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_year integer := extract(year from (now() at time zone 'Asia/Beirut'))::int;
  v_num  integer;
begin
  insert into public.request_counters (year, last_number)
  values (v_year, 1)
  on conflict (year) do update set last_number = request_counters.last_number + 1
  returning last_number into v_num;

  return 'REQ-' || v_year::text || '-' || lpad(v_num::text, 6, '0');
end;
$fn$;

create table if not exists public.service_requests (
  id                      uuid primary key default gen_random_uuid(),
  request_number          text unique not null,

  requester_id            uuid not null references public.profiles (id) on delete restrict,
  requester_name_snapshot text not null,

  location_building_id    uuid references public.buildings (id) on delete set null,
  custom_location         text check (custom_location is null or char_length(trim(custom_location)) between 1 and 80),
  location_name_snapshot  text not null,

  category_task_id        uuid references public.tasks (id) on delete set null,
  custom_category         text check (custom_category is null or char_length(trim(custom_category)) between 1 and 80),
  category_name_snapshot  text not null,

  description             text check (description is null or char_length(description) <= 1000),

  priority                text not null default 'normal'
                          check (priority in ('normal', 'urgent', 'very_urgent')),
  status                  text not null default 'pending'
                          check (status in ('pending', 'accepted', 'in_progress', 'completed', 'rejected', 'cancelled')),
  queue_position          integer not null default 0,

  assigned_to             uuid references public.profiles (id) on delete set null,

  created_at              timestamptz not null default now(),
  accepted_at             timestamptz,
  started_at              timestamptz,
  completed_at            timestamptz,
  cancelled_at            timestamptz,
  updated_at              timestamptz not null default now(),

  -- A request points at a configured building OR a typed-in one, never neither.
  constraint request_location_present check (location_building_id is not null or custom_location is not null),
  constraint request_category_present check (category_task_id is not null or custom_category is not null)
);

create index if not exists sr_status_idx     on public.service_requests (status);
create index if not exists sr_open_queue_idx on public.service_requests (status, priority, queue_position, created_at)
  where status in ('pending', 'accepted', 'in_progress');
create index if not exists sr_requester_idx  on public.service_requests (requester_id, created_at desc);
create index if not exists sr_assigned_idx   on public.service_requests (assigned_to, created_at desc);
create index if not exists sr_created_idx    on public.service_requests (created_at desc);
create index if not exists sr_building_idx   on public.service_requests (location_building_id);
create index if not exists sr_task_idx       on public.service_requests (category_task_id);

-- ---------------------------------------------------------------------
-- 6. REQUEST HISTORY (audit trail of every status transition)
-- ---------------------------------------------------------------------
create table if not exists public.request_history (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.service_requests (id) on delete cascade,
  changed_by uuid references public.profiles (id) on delete set null,
  old_status text,
  new_status text,
  notes      text check (notes is null or char_length(notes) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists rh_request_idx on public.request_history (request_id, created_at);

-- ---------------------------------------------------------------------
-- 7. STATUS HISTORY (immutable log of where Haitham has been)
-- ---------------------------------------------------------------------
create table if not exists public.status_history (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles (id) on delete cascade,

  building_id            uuid references public.buildings (id) on delete set null,
  custom_location        text check (custom_location is null or char_length(trim(custom_location)) between 1 and 80),
  location_name_snapshot text,

  task_id                uuid references public.tasks (id) on delete set null,
  custom_task            text check (custom_task is null or char_length(trim(custom_task)) between 1 and 80),
  task_name_snapshot     text,

  status_type            text not null check (status_type in
                         ('available','busy','serving','traveling','break','meeting','offsite','done')),

  request_id             uuid references public.service_requests (id) on delete set null,

  started_at             timestamptz not null,
  expected_end_at        timestamptz,
  actual_end_at          timestamptz,

  duration_minutes       integer check (duration_minutes is null or (duration_minutes between 1 and 1440)),

  -- Real elapsed time. NULL while the status is still open.
  actual_minutes         numeric generated always as (
                           case when actual_end_at is null then null
                           else round((extract(epoch from (actual_end_at - started_at)) / 60.0)::numeric, 2) end
                         ) stored,

  created_at             timestamptz not null default now()
);

create index if not exists sh_user_started_idx on public.status_history (user_id, started_at desc);
create index if not exists sh_open_idx         on public.status_history (user_id) where actual_end_at is null;
create index if not exists sh_building_idx     on public.status_history (building_id);
create index if not exists sh_task_idx         on public.status_history (task_id);

-- ---------------------------------------------------------------------
-- 8. CURRENT STATUS (one row per tracked user -- fast realtime read)
-- ---------------------------------------------------------------------
create table if not exists public.current_status (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null unique references public.profiles (id) on delete cascade,

  building_id            uuid references public.buildings (id) on delete set null,
  custom_location        text,
  location_name_snapshot text,

  task_id                uuid references public.tasks (id) on delete set null,
  custom_task            text,
  task_name_snapshot     text,

  status_type            text not null check (status_type in
                         ('available','busy','serving','traveling','break','meeting','offsite','done')),

  history_id             uuid references public.status_history (id) on delete set null,
  serving_request_id     uuid references public.service_requests (id) on delete set null,
  next_request_id        uuid references public.service_requests (id) on delete set null,

  started_at             timestamptz not null,
  expected_end_at        timestamptz,
  updated_at             timestamptz not null default now()
);

create index if not exists cs_user_idx on public.current_status (user_id);

-- ---------------------------------------------------------------------
-- 9. NOTIFICATIONS
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  request_id uuid references public.service_requests (id) on delete cascade,
  title      text not null check (char_length(title) <= 120),
  message    text not null check (char_length(message) <= 500),
  type       text check (type is null or type in ('new_request','request_update','status','system')),
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notif_user_idx on public.notifications (user_id, read, created_at desc);

-- ---------------------------------------------------------------------
-- 10. PUSH SUBSCRIPTIONS
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text,
  auth       text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_user_idx on public.push_subscriptions (user_id);

-- ---------------------------------------------------------------------
-- 11. AUDIT LOG (meaningful admin state changes only)
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references public.profiles (id) on delete set null,
  action     text not null,
  entity     text not null,
  entity_id  uuid,
  details    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_created_idx on public.audit_log (created_at desc);

-- ---------------------------------------------------------------------
-- 12. PUBLIC BOARD
--     A single pre-computed, privacy-filtered snapshot of "what everyone
--     is allowed to see". Employees and anonymous visitors read ONLY this
--     row, so nobody can enumerate other people's requests. Triggers keep
--     it fresh and Realtime pushes it to every connected dashboard.
-- ---------------------------------------------------------------------
create table if not exists public.public_board (
  id         smallint primary key default 1 check (id = 1),
  snapshot   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.public_board (id) values (1) on conflict do nothing;

create or replace function public.build_public_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'generated_at', now(),
    'status', (
      select jsonb_build_object(
        'status_type',     cs.status_type,
        'location',        coalesce(cs.location_name_snapshot, cs.custom_location),
        'task',            coalesce(cs.task_name_snapshot, cs.custom_task),
        'started_at',      cs.started_at,
        'expected_end_at', cs.expected_end_at,
        'updated_at',      cs.updated_at,
        'person',          p.full_name
      )
      from public.current_status cs
      join public.profiles p on p.id = cs.user_id
      where p.role = 'admin'
      order by cs.updated_at desc
      limit 1
    ),
    'serving', (
      select jsonb_build_object(
        'request_number', sr.request_number,
        'requester',      sr.requester_name_snapshot,
        'location',       sr.location_name_snapshot,
        'category',       sr.category_name_snapshot,
        'priority',       sr.priority,
        'started_at',     coalesce(sr.started_at, sr.accepted_at)
      )
      from public.service_requests sr
      where sr.status = 'in_progress'
      order by sr.started_at desc nulls last
      limit 1
    ),
    'next', (
      select jsonb_build_object(
        'request_number', sr.request_number,
        'requester',      sr.requester_name_snapshot,
        'location',       sr.location_name_snapshot,
        'category',       sr.category_name_snapshot,
        'priority',       sr.priority
      )
      from public.service_requests sr
      where sr.status = 'accepted'
      order by sr.queue_position, sr.accepted_at
      limit 1
    ),
    'queue', (
      select coalesce(jsonb_agg(to_jsonb(q) - 'ord' order by q.ord), '[]'::jsonb)
      from (
        select row_number() over (
                 order by case sr.priority when 'very_urgent' then 0 when 'urgent' then 1 else 2 end,
                          sr.queue_position, sr.created_at
               ) as ord,
               sr.requester_name_snapshot as requester,
               sr.location_name_snapshot  as location,
               sr.category_name_snapshot  as category,
               sr.priority,
               sr.status
        from public.service_requests sr
        where sr.status in ('pending', 'accepted')
      ) q
    ),
    'counts', (
      select jsonb_build_object(
        'waiting',     count(*) filter (where status in ('pending','accepted')),
        'pending',     count(*) filter (where status = 'pending'),
        'in_progress', count(*) filter (where status = 'in_progress'),
        'urgent',      count(*) filter (where status in ('pending','accepted') and priority = 'urgent'),
        'very_urgent', count(*) filter (where status in ('pending','accepted') and priority = 'very_urgent')
      )
      from public.service_requests
    )
  );
$fn$;

create or replace function public.refresh_public_board()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.public_board
     set snapshot   = public.build_public_snapshot(),
         updated_at = now()
   where id = 1;
  return null;
end;
$fn$;

drop trigger if exists refresh_board_on_status on public.current_status;
create trigger refresh_board_on_status
  after insert or update or delete on public.current_status
  for each statement execute function public.refresh_public_board();

drop trigger if exists refresh_board_on_requests on public.service_requests;
create trigger refresh_board_on_requests
  after insert or update or delete on public.service_requests
  for each statement execute function public.refresh_public_board();

-- ---------------------------------------------------------------------
-- 13. updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

do $do$
declare t text;
begin
  foreach t in array array['profiles','buildings','tasks','service_requests',
                           'current_status','push_subscriptions','app_settings']
  loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s', t);
    execute format('create trigger touch_%1$s before update on public.%1$s
                    for each row execute function public.touch_updated_at()', t);
  end loop;
end
$do$;

-- ---------------------------------------------------------------------
-- 14. AUDIT TRIGGERS (configuration changes only -- not every UI click)
-- ---------------------------------------------------------------------
create or replace function public.audit_config_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_action  text;
  v_details jsonb;
  v_id      uuid;
begin
  if TG_OP = 'INSERT' then
    v_action  := 'created';
    v_details := jsonb_build_object('name', new.name);
    v_id      := new.id;
  elsif TG_OP = 'UPDATE' then
    if new.name is distinct from old.name then
      v_action  := 'renamed';
      v_details := jsonb_build_object('from', old.name, 'to', new.name);
    elsif new.active is distinct from old.active then
      v_action  := case when new.active then 'enabled' else 'disabled' end;
      v_details := jsonb_build_object('name', new.name);
    else
      return null;                    -- reordering alone is not worth logging
    end if;
    v_id := new.id;
  else
    v_action  := 'deleted';
    v_details := jsonb_build_object('name', old.name);
    v_id      := old.id;              -- NEW does not exist on a DELETE
  end if;

  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), v_action, TG_TABLE_NAME, v_id, v_details);
  return null;
end;
$fn$;

drop trigger if exists audit_buildings on public.buildings;
create trigger audit_buildings after insert or update or delete on public.buildings
  for each row execute function public.audit_config_change();

drop trigger if exists audit_tasks on public.tasks;
create trigger audit_tasks after insert or update or delete on public.tasks
  for each row execute function public.audit_config_change();

create or replace function public.audit_profile_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.active is distinct from old.active then
    insert into public.audit_log (actor_id, action, entity, entity_id, details)
    values (auth.uid(), case when new.active then 'user_activated' else 'user_deactivated' end,
            'profiles', new.id, jsonb_build_object('name', new.full_name));
  elsif new.role is distinct from old.role then
    insert into public.audit_log (actor_id, action, entity, entity_id, details)
    values (auth.uid(), 'role_changed', 'profiles', new.id,
            jsonb_build_object('name', new.full_name, 'from', old.role, 'to', new.role));
  end if;
  return null;
end;
$fn$;

drop trigger if exists audit_profiles on public.profiles;
create trigger audit_profiles after update on public.profiles
  for each row execute function public.audit_profile_change();

-- ---------------------------------------------------------------------
-- 15. REALTIME PUBLICATION
-- ---------------------------------------------------------------------
do $do$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$do$;

do $do$
declare t text;
begin
  foreach t in array array['public_board','service_requests','notifications',
                           'current_status','buildings','tasks']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end
$do$;

-- Realtime needs the old row to evaluate RLS on UPDATE/DELETE events.
alter table public.service_requests replica identity full;
alter table public.public_board     replica identity full;
