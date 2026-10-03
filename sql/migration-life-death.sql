-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-life-death.sql
--
--  Run once, after every earlier migration.
--
--  Adds a fourth urgency above "very urgent": life_death.
--
--  WHY A FOURTH LEVEL
--  ------------------
--  Three levels stopped discriminating. Once "very urgent" is the top of
--  the scale, everything that actually stops work gets filed there, and
--  the genuinely drop-everything cases are buried among the merely
--  annoying ones. A level above it gives the top of the scale somewhere
--  to go, and leaves "very urgent" meaning what it says.
--
--  WHAT THIS TOUCHES
--  -----------------
--  * the priority check constraint on service_requests
--  * every function that validates a priority, orders by one, or counts
--    one, redefined here from its current definition with the new level
--    folded in
--
--  Existing rows are untouched: nothing is reclassified, and a request
--  that was 'very_urgent' yesterday is still 'very_urgent' today.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. The constraint
--
--    The original check is inline and therefore auto-named, and the name
--    Postgres chose is not guaranteed across installs. Find it by what
--    it says rather than by what it is called.
-- ---------------------------------------------------------------------
do $$
declare
  v_name text;
begin
  select con.conname into v_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
   where ns.nspname = 'public'
     and rel.relname = 'service_requests'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%very_urgent%'
   limit 1;

  if v_name is not null then
    execute format('alter table public.service_requests drop constraint %I', v_name);
  end if;
end;
$$;

alter table public.service_requests
  add constraint service_requests_priority_check
  check (priority in ('normal', 'urgent', 'very_urgent', 'life_death'));

-- ---------------------------------------------------------------------
-- 2. The functions
--
--    Each one below is the definition that was live before this file,
--    with the priority list, the queue ordering and the counts extended.
--    Nothing else about them changed.
-- ---------------------------------------------------------------------

-- ---- The public snapshot: queue order and the counts ---------------
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
        'location_ar',     coalesce(cs.location_name_ar_snapshot, cs.location_name_snapshot, cs.custom_location),
        'task',            coalesce(cs.task_name_snapshot, cs.custom_task),
        'task_ar',         coalesce(cs.task_name_ar_snapshot, cs.task_name_snapshot, cs.custom_task),
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
        'location_ar',    coalesce(sr.location_name_ar_snapshot, sr.location_name_snapshot),
        'category',       sr.category_name_snapshot,
        'category_ar',    coalesce(sr.category_name_ar_snapshot, sr.category_name_snapshot),
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
        'location_ar',    coalesce(sr.location_name_ar_snapshot, sr.location_name_snapshot),
        'category',       sr.category_name_snapshot,
        'category_ar',    coalesce(sr.category_name_ar_snapshot, sr.category_name_snapshot),
        'priority',       sr.priority
      )
      from public.service_requests sr
      where sr.status in ('accepted', 'paused')
      order by case when sr.status = 'paused' then 0 else 1 end,
               sr.queue_position, sr.accepted_at
      limit 1
    ),
    'queue', (
      select coalesce(jsonb_agg(to_jsonb(q) - 'ord' order by q.ord), '[]'::jsonb)
      from (
        select row_number() over (
                 order by case sr.status when 'paused' then 0 else 1 end,
                          case sr.priority when 'life_death' then 0 when 'very_urgent' then 1
                               when 'urgent' then 2 else 3 end,
                          sr.queue_position, sr.created_at
               ) as ord,
               sr.requester_name_snapshot as requester,
               sr.location_name_snapshot  as location,
               coalesce(sr.location_name_ar_snapshot, sr.location_name_snapshot) as location_ar,
               sr.category_name_snapshot  as category,
               coalesce(sr.category_name_ar_snapshot, sr.category_name_snapshot) as category_ar,
               sr.priority,
               sr.status
        from public.service_requests sr
        where sr.status in ('pending', 'accepted', 'paused')
      ) q
    ),
    'counts', (
      select jsonb_build_object(
        'waiting',     count(*) filter (where status in ('pending','accepted','paused')),
        'pending',     count(*) filter (where status = 'pending'),
        'paused',      count(*) filter (where status = 'paused'),
        'in_progress', count(*) filter (where status = 'in_progress'),
        'urgent',      count(*) filter (where status in ('pending','accepted','paused') and priority = 'urgent'),
        'very_urgent', count(*) filter (where status in ('pending','accepted','paused') and priority = 'very_urgent'),
        'life_death',  count(*) filter (where status in ('pending','accepted','paused') and priority = 'life_death')
      )
      from public.service_requests
    )
  );
$fn$;

-- ---- A colleague sends a request -----------------------------------
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
  v_name    text;
  v_loc     text;
  v_cat     text;
  v_loc_ar  text;
  v_cat_ar  text;
  v_device  text := left(coalesce(nullif(trim(p_device_id), ''), 'unknown'), 64);
  v_count   integer;
  v_window  timestamptz;
  v_row     public.service_requests;
  v_ahead   integer;
  v_admin   uuid;
begin
  v_name := nullif(trim(regexp_replace(coalesce(p_requester_name, ''), '\s+', ' ', 'g')), '');
  if v_name is null or char_length(v_name) < 2 then
    raise exception 'Please enter your name' using errcode = '22023';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'That name is too long' using errcode = '22023';
  end if;
  if p_priority not in ('normal', 'urgent', 'very_urgent', 'life_death') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;

  p_custom_location := nullif(trim(coalesce(p_custom_location, '')), '');
  p_custom_category := nullif(trim(coalesce(p_custom_category, '')), '');
  p_description     := nullif(trim(coalesce(p_description, '')), '');

  if char_length(coalesce(p_description, '')) > 1000 then
    raise exception 'Please shorten the description' using errcode = '22023';
  end if;

  v_loc    := coalesce(public.building_name(p_building_id), p_custom_location);
  v_cat    := coalesce(public.task_name(p_task_id), p_custom_category);
  v_loc_ar := coalesce(public.building_name_ar(p_building_id), p_custom_location);
  v_cat_ar := coalesce(public.task_name_ar(p_task_id), p_custom_category);

  if v_loc is null then
    raise exception 'Please choose where you are' using errcode = '22023';
  end if;
  if v_cat is null then
    raise exception 'Please choose what you need' using errcode = '22023';
  end if;

  insert into public.request_throttle (device_id) values (v_device)
  on conflict (device_id) do nothing;

  select count, window_start into v_count, v_window
    from public.request_throttle where device_id = v_device for update;

  if v_window < now() - interval '10 minutes' then
    update public.request_throttle set count = 0, window_start = now() where device_id = v_device;
    v_count := 0;
  end if;

  if v_count >= 5 then
    raise exception 'You have sent several requests already. Please wait a few minutes before sending another.'
      using errcode = '53400';
  end if;

  if (select count(*) from public.service_requests
       where created_at > now() - interval '5 minutes') >= 40 then
    raise exception 'The system is unusually busy right now. Please try again shortly.'
      using errcode = '53400';
  end if;

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

  insert into public.service_requests (
    request_number, requester_id, requester_name_snapshot,
    location_building_id, custom_location, location_name_snapshot, location_name_ar_snapshot,
    category_task_id, custom_category, category_name_snapshot, category_name_ar_snapshot,
    description, priority, status, channel, queue_position
  ) values (
    public.next_request_number(), null, v_name,
    p_building_id, p_custom_location, v_loc, v_loc_ar,
    p_task_id, p_custom_category, v_cat, v_cat_ar,
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
        when 'life_death'  then 'LIFE & DEATH request'
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

  return jsonb_build_object(
    'request_number', v_row.request_number,
    'public_token',   v_row.public_token,
    'created_at',     v_row.created_at,
    'people_ahead',   v_ahead
  );
end;
$fn$;

-- ---- Haitham records a request that arrived some other way ---------
create or replace function public.admin_create_request(
  p_requester_name   text,
  p_channel          text,
  p_building_id      uuid    default null,
  p_custom_location  text    default null,
  p_task_id          uuid    default null,
  p_custom_category  text    default null,
  p_description      text    default null,
  p_priority         text    default 'normal',
  p_notes            text    default null,
  p_start_now        boolean default false,
  p_duration_minutes integer default null
)
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v_name   text;
  v_loc    text;
  v_cat    text;
  v_loc_ar text;
  v_cat_ar text;
  v_row    public.service_requests;
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
  if p_priority not in ('normal', 'urgent', 'very_urgent', 'life_death') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;

  p_custom_location := nullif(trim(coalesce(p_custom_location, '')), '');
  p_custom_category := nullif(trim(coalesce(p_custom_category, '')), '');
  p_description     := nullif(trim(coalesce(p_description, '')), '');
  p_notes           := nullif(trim(coalesce(p_notes, '')), '');

  v_loc    := coalesce(public.building_name(p_building_id), p_custom_location);
  v_cat    := coalesce(public.task_name(p_task_id), p_custom_category);
  v_loc_ar := coalesce(public.building_name_ar(p_building_id), p_custom_location);
  v_cat_ar := coalesce(public.task_name_ar(p_task_id), p_custom_category);

  if v_loc is null then
    raise exception 'Please choose a location' using errcode = '22023';
  end if;
  if v_cat is null then
    raise exception 'Please choose what they need' using errcode = '22023';
  end if;

  insert into public.service_requests (
    request_number, requester_id, requester_name_snapshot,
    location_building_id, custom_location, location_name_snapshot, location_name_ar_snapshot,
    category_task_id, custom_category, category_name_snapshot, category_name_ar_snapshot,
    description, priority, status, channel, notes, created_by, queue_position
  ) values (
    public.next_request_number(), null, v_name,
    p_building_id, p_custom_location, v_loc, v_loc_ar,
    p_task_id, p_custom_category, v_cat, v_cat_ar,
    p_description, p_priority, 'pending', p_channel, p_notes, v_uid,
    coalesce((select max(queue_position) + 1 from public.service_requests
               where status in ('pending', 'accepted')), 0)
  )
  returning * into v_row;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (v_row.id, v_uid, null, 'pending',
          'Recorded by the administrator (' || p_channel || ')');

  if p_start_now then
    v_row := public.start_request(v_row.id, p_duration_minutes);
  end if;

  return v_row;
end;
$fn$;

-- ---- The requester raises the urgency afterwards -------------------
create or replace function public.update_request_by_token(
  p_token       uuid,
  p_description text default null,
  p_priority    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row  public.service_requests;
  v_desc text := nullif(trim(coalesce(p_description, '')), '');
begin
  select * into v_row from public.service_requests where public_token = p_token for update;
  if v_row is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;

  -- Pending only. Accepted means he has already planned around it.
  if v_row.status <> 'pending' then
    raise exception 'This request can no longer be changed' using errcode = '42501';
  end if;

  if p_priority is not null and p_priority not in ('normal', 'urgent', 'very_urgent', 'life_death') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;
  if v_desc is not null and char_length(v_desc) > 1000 then
    raise exception 'Please shorten the description' using errcode = '22023';
  end if;

  update public.service_requests
     set description = coalesce(v_desc, description),
         priority    = coalesce(p_priority, priority)
   where id = v_row.id
  returning * into v_row;

  -- Worth recording: a request that quietly became "very urgent" after
  -- the fact should be visible in its own history.
  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (v_row.id, null, 'pending', 'pending',
          'Updated by the requester (priority: ' || v_row.priority || ')');

  return jsonb_build_object(
    'request_number', v_row.request_number,
    'description',    v_row.description,
    'priority',       v_row.priority,
    'status',         v_row.status
  );
end;
$fn$;

-- ---- Haitham changes the urgency -----------------------------------
create or replace function public.set_request_priority(p_request_id uuid, p_priority text)
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $fn$
declare v_row public.service_requests;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can change priority' using errcode = '42501';
  end if;
  if p_priority not in ('normal','urgent','very_urgent','life_death') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;

  update public.service_requests set priority = p_priority
   where id = p_request_id returning * into v_row;

  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (p_request_id, auth.uid(), v_row.status, v_row.status, 'Priority set to ' || p_priority);

  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 3. Grants
--
--    `create or replace` keeps existing grants, but restating them costs
--    nothing and makes this file safe to read on its own.
-- ---------------------------------------------------------------------
revoke all on function public.create_public_request(text, uuid, text, uuid, text, text, text, text) from public;
revoke all on function public.admin_create_request(text, text, uuid, text, uuid, text, text, text, text, boolean, integer) from public;
revoke all on function public.update_request_by_token(uuid, text, text) from public;
revoke all on function public.set_request_priority(uuid, text) from public;

grant execute on function public.create_public_request(text, uuid, text, uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.admin_create_request(text, text, uuid, text, uuid, text, text, text, text, boolean, integer) to authenticated;
grant execute on function public.update_request_by_token(uuid, text, text) to anon, authenticated;
grant execute on function public.set_request_priority(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Refresh the board so the new count appears without waiting for the
--    next request to come in and fire the trigger.
-- ---------------------------------------------------------------------
update public.public_board
   set snapshot = public.build_public_snapshot(), updated_at = now()
 where id = true;

commit;

notify pgrst, 'reload schema';
