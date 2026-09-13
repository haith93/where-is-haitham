-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  functions.sql
--  Run AFTER schema.sql and BEFORE rls.sql.
--
--  Every write that involves a clock happens here, inside the database,
--  using now(). The browser only ever sends a *duration in minutes*.
--  This is what makes rule "no manual time entry" impossible to violate.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Name resolution helpers (used to freeze snapshots into history rows)
-- ---------------------------------------------------------------------
create or replace function public.building_name(p_id uuid)
returns text language sql stable security definer set search_path = public as $fn$
  select name from public.buildings where id = p_id;
$fn$;

create or replace function public.task_name(p_id uuid)
returns text language sql stable security definer set search_path = public as $fn$
  select name from public.tasks where id = p_id;
$fn$;

-- ---------------------------------------------------------------------
-- STATUS: update
--   The single entry point for "I am now here doing this".
--   1. closes any open status_history row with a real actual_end_at
--   2. inserts the new immutable history row
--   3. upserts current_status
--   4. triggers refresh the public board -> Realtime fan-out
-- ---------------------------------------------------------------------
create or replace function public.update_my_status(
  p_status_type      text,
  p_building_id      uuid    default null,
  p_custom_location  text    default null,
  p_task_id          uuid    default null,
  p_custom_task      text    default null,
  p_duration_minutes integer default null,
  p_request_id       uuid    default null
)
returns public.current_status
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid        uuid := auth.uid();
  v_now        timestamptz := now();
  v_expected   timestamptz;
  v_loc_name   text;
  v_task_name  text;
  v_history_id uuid;
  v_row        public.current_status;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if not public.is_admin() then
    raise exception 'Only an administrator can update the tracked status' using errcode = '42501';
  end if;
  if p_status_type is null or p_status_type not in
     ('available','busy','serving','traveling','break','meeting','offsite','done') then
    raise exception 'Unknown status type: %', coalesce(p_status_type, 'null') using errcode = '22023';
  end if;
  if p_duration_minutes is not null and (p_duration_minutes < 1 or p_duration_minutes > 1440) then
    raise exception 'Duration must be between 1 and 1440 minutes' using errcode = '22023';
  end if;
  if p_building_id is not null and p_custom_location is not null then
    raise exception 'Choose either a configured building or a custom location, not both' using errcode = '22023';
  end if;
  if p_task_id is not null and p_custom_task is not null then
    raise exception 'Choose either a configured task or a custom task, not both' using errcode = '22023';
  end if;

  p_custom_location := nullif(trim(coalesce(p_custom_location, '')), '');
  p_custom_task     := nullif(trim(coalesce(p_custom_task, '')), '');

  -- Freeze display names so a later rename cannot rewrite history.
  v_loc_name  := coalesce(public.building_name(p_building_id), p_custom_location);
  v_task_name := coalesce(public.task_name(p_task_id), p_custom_task);

  if p_building_id is not null and v_loc_name is null then
    raise exception 'That building no longer exists' using errcode = '23503';
  end if;
  if p_task_id is not null and v_task_name is null then
    raise exception 'That task no longer exists' using errcode = '23503';
  end if;

  -- Expected end = server start time + chosen duration. Never client supplied.
  if p_duration_minutes is not null then
    v_expected := v_now + make_interval(mins => p_duration_minutes);
  end if;

  -- 1. Close the previous status with its ACTUAL end time.
  update public.status_history
     set actual_end_at = v_now
   where user_id = v_uid and actual_end_at is null;

  -- 2. Immutable history row.
  insert into public.status_history (
    user_id, building_id, custom_location, location_name_snapshot,
    task_id, custom_task, task_name_snapshot,
    status_type, request_id, started_at, expected_end_at, duration_minutes
  ) values (
    v_uid, p_building_id, p_custom_location, v_loc_name,
    p_task_id, p_custom_task, v_task_name,
    p_status_type, p_request_id, v_now, v_expected, p_duration_minutes
  )
  returning id into v_history_id;

  -- 3. Current status (single row per user).
  insert into public.current_status (
    user_id, building_id, custom_location, location_name_snapshot,
    task_id, custom_task, task_name_snapshot,
    status_type, history_id, serving_request_id, started_at, expected_end_at, updated_at
  ) values (
    v_uid, p_building_id, p_custom_location, v_loc_name,
    p_task_id, p_custom_task, v_task_name,
    p_status_type, v_history_id,
    case when p_status_type = 'serving' then p_request_id else null end,
    v_now, v_expected, v_now
  )
  on conflict (user_id) do update set
    building_id            = excluded.building_id,
    custom_location        = excluded.custom_location,
    location_name_snapshot = excluded.location_name_snapshot,
    task_id                = excluded.task_id,
    custom_task            = excluded.custom_task,
    task_name_snapshot     = excluded.task_name_snapshot,
    status_type            = excluded.status_type,
    history_id             = excluded.history_id,
    serving_request_id     = excluded.serving_request_id,
    next_request_id        = case when excluded.status_type = 'traveling'
                                  then current_status.next_request_id else null end,
    started_at             = excluded.started_at,
    expected_end_at        = excluded.expected_end_at,
    updated_at             = excluded.updated_at
  returning * into v_row;

  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------
-- STATUS: finish the current task now
--   Records the real end time and drops back to "available".
-- ---------------------------------------------------------------------
create or replace function public.finish_current_task()
returns public.current_status
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can update the tracked status' using errcode = '42501';
  end if;
  return public.update_my_status('available');
end;
$fn$;

-- ---------------------------------------------------------------------
-- REQUESTS: create (employee)
-- ---------------------------------------------------------------------
create or replace function public.create_service_request(
  p_building_id     uuid default null,
  p_custom_location text default null,
  p_task_id         uuid default null,
  p_custom_category text default null,
  p_description     text default null,
  p_priority        text default 'normal'
)
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid       uuid := auth.uid();
  v_profile   public.profiles;
  v_loc_name  text;
  v_cat_name  text;
  v_row       public.service_requests;
  v_admin     uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to send a request' using errcode = '28000';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found or not v_profile.active then
    raise exception 'Your account is not active' using errcode = '42501';
  end if;
  if p_priority not in ('normal','urgent','very_urgent') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;

  p_custom_location := nullif(trim(coalesce(p_custom_location, '')), '');
  p_custom_category := nullif(trim(coalesce(p_custom_category, '')), '');
  p_description     := nullif(trim(coalesce(p_description, '')), '');

  v_loc_name := coalesce(public.building_name(p_building_id), p_custom_location);
  v_cat_name := coalesce(public.task_name(p_task_id), p_custom_category);

  if v_loc_name is null then
    raise exception 'Please choose or type where you are' using errcode = '22023';
  end if;
  if v_cat_name is null then
    raise exception 'Please choose or type what you need' using errcode = '22023';
  end if;

  -- Light anti-spam: block an identical open request from the same person.
  if exists (
    select 1 from public.service_requests
     where requester_id = v_uid
       and status in ('pending','accepted','in_progress')
       and category_name_snapshot = v_cat_name
       and location_name_snapshot = v_loc_name
       and created_at > now() - interval '2 minutes'
  ) then
    raise exception 'You already sent this request a moment ago' using errcode = '23505';
  end if;

  insert into public.service_requests (
    request_number, requester_id, requester_name_snapshot,
    location_building_id, custom_location, location_name_snapshot,
    category_task_id, custom_category, category_name_snapshot,
    description, priority, status,
    queue_position
  ) values (
    public.next_request_number(), v_uid, v_profile.full_name,
    p_building_id, p_custom_location, v_loc_name,
    p_task_id, p_custom_category, v_cat_name,
    p_description, p_priority, 'pending',
    coalesce((select max(queue_position) + 1 from public.service_requests
               where status in ('pending','accepted')), 0)
  )
  returning * into v_row;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (v_row.id, v_uid, null, 'pending', 'Request created');

  -- Notify every active administrator.
  for v_admin in select id from public.profiles where role = 'admin' and active loop
    insert into public.notifications (user_id, request_id, title, message, type)
    values (
      v_admin, v_row.id,
      case v_row.priority
        when 'very_urgent' then 'VERY URGENT request'
        when 'urgent'      then 'Urgent request'
        else 'New request' end,
      v_profile.full_name || ' - ' || v_loc_name || ' - ' || v_cat_name,
      'new_request'
    );
  end loop;

  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------
-- REQUESTS: change status
--   Admin may make any legal transition. A requester may cancel their own
--   request while it has not been started yet.
-- ---------------------------------------------------------------------
create or replace function public.set_request_status(
  p_request_id uuid,
  p_new_status text,
  p_notes      text default null
)
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_now      timestamptz := now();
  v_req      public.service_requests;
  v_old      text;
  v_is_admin boolean := public.is_admin();
  v_title    text;
  v_msg      text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  select * into v_req from public.service_requests where id = p_request_id for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;

  if p_new_status not in ('pending','accepted','in_progress','completed','rejected','cancelled') then
    raise exception 'Unknown request status' using errcode = '22023';
  end if;

  if not v_is_admin then
    if v_req.requester_id <> v_uid then
      raise exception 'You can only change your own requests' using errcode = '42501';
    end if;
    if p_new_status <> 'cancelled' then
      raise exception 'You can only cancel your own request' using errcode = '42501';
    end if;
    if v_req.status not in ('pending','accepted') then
      raise exception 'This request can no longer be cancelled' using errcode = '42501';
    end if;
  end if;

  if v_req.status = p_new_status then
    return v_req;                      -- idempotent: double tap changes nothing
  end if;
  if v_req.status in ('completed','rejected','cancelled') then
    raise exception 'This request is already closed' using errcode = '42501';
  end if;

  v_old := v_req.status;               -- captured before the UPDATE overwrites it

  update public.service_requests set
    status       = p_new_status,
    assigned_to  = case when p_new_status in ('accepted','in_progress') then v_uid else assigned_to end,
    accepted_at  = case when p_new_status = 'accepted'    and accepted_at  is null then v_now else accepted_at end,
    started_at   = case when p_new_status = 'in_progress' and started_at   is null then v_now else started_at end,
    completed_at = case when p_new_status = 'completed'   then v_now else completed_at end,
    cancelled_at = case when p_new_status in ('cancelled','rejected') then v_now else cancelled_at end
  where id = p_request_id
  returning * into v_req;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (p_request_id, v_uid, v_old, p_new_status, nullif(trim(coalesce(p_notes, '')), ''));

  -- Keep current_status pointers honest.
  if p_new_status in ('completed','cancelled','rejected') then
    update public.current_status
       set serving_request_id = null
     where serving_request_id = p_request_id;
    update public.current_status
       set next_request_id = null
     where next_request_id = p_request_id;
  end if;

  -- Tell the requester what happened (unless they did it themselves).
  if v_req.requester_id <> v_uid then
    v_title := case p_new_status
                 when 'accepted'    then 'Request accepted'
                 when 'in_progress' then 'Work started'
                 when 'completed'   then 'Request completed'
                 when 'rejected'    then 'Request rejected'
                 when 'cancelled'   then 'Request cancelled'
                 else 'Request updated' end;
    v_msg := v_req.request_number || ' - ' || v_req.category_name_snapshot ||
             coalesce(' - ' || nullif(trim(coalesce(p_notes, '')), ''), '');
    insert into public.notifications (user_id, request_id, title, message, type)
    values (v_req.requester_id, v_req.id, v_title, v_msg, 'request_update');
  end if;

  return v_req;
end;
$fn$;

-- ---------------------------------------------------------------------
-- REQUESTS: accept + optionally start travelling to the requester
-- ---------------------------------------------------------------------
create or replace function public.accept_request(
  p_request_id       uuid,
  p_travel_now       boolean default false,
  p_duration_minutes integer default null
)
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_req public.service_requests;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can accept requests' using errcode = '42501';
  end if;

  v_req := public.set_request_status(p_request_id, 'accepted', null);

  if p_travel_now then
    perform public.update_my_status(
      'traveling',
      v_req.location_building_id,
      case when v_req.location_building_id is null then v_req.location_name_snapshot end,
      v_req.category_task_id,
      case when v_req.category_task_id is null then v_req.category_name_snapshot end,
      p_duration_minutes,
      v_req.id
    );
  end if;

  update public.current_status
     set next_request_id = v_req.id, updated_at = now()
   where user_id = auth.uid();

  return v_req;
end;
$fn$;

-- ---------------------------------------------------------------------
-- REQUESTS: start work
--   Moves the request to in_progress AND sets the tracked status to
--   "serving" at that request's location -- one tap, no retyping.
-- ---------------------------------------------------------------------
create or replace function public.start_request(
  p_request_id       uuid,
  p_duration_minutes integer default null
)
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_req public.service_requests;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can start requests' using errcode = '42501';
  end if;

  v_req := public.set_request_status(p_request_id, 'in_progress', null);

  perform public.update_my_status(
    'serving',
    v_req.location_building_id,
    case when v_req.location_building_id is null then v_req.location_name_snapshot end,
    v_req.category_task_id,
    case when v_req.category_task_id is null then v_req.category_name_snapshot end,
    p_duration_minutes,
    v_req.id
  );

  return v_req;
end;
$fn$;

-- ---------------------------------------------------------------------
-- REQUESTS: priority and manual queue order
-- ---------------------------------------------------------------------
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
  if p_priority not in ('normal','urgent','very_urgent') then
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

create or replace function public.set_queue_order(p_request_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can reorder the queue' using errcode = '42501';
  end if;

  update public.service_requests sr
     set queue_position = ord.pos
    from (select id, (idx - 1) as pos
            from unnest(p_request_ids) with ordinality as u(id, idx)) ord
   where sr.id = ord.id;
end;
$fn$;

-- ---------------------------------------------------------------------
-- PUBLIC BOARD reader
--   Anonymous access is allowed only while the "public_dashboard"
--   setting is on. Enforced here AND in RLS.
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
  if auth.uid() is null and not public.setting_bool('public_dashboard', true) then
    raise exception 'Sign in required to view the board' using errcode = '42501';
  end if;

  select nullif(snapshot, '{}'::jsonb) into v_snap from public.public_board where id = 1;
  return coalesce(v_snap, public.build_public_snapshot());
end;
$fn$;

-- ---------------------------------------------------------------------
-- NOTIFICATIONS
-- ---------------------------------------------------------------------
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  update public.notifications
     set read = true
   where user_id = auth.uid()
     and not read
     and (p_ids is null or id = any(p_ids));

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- ---------------------------------------------------------------------
-- PUSH SUBSCRIPTIONS
-- ---------------------------------------------------------------------
create or replace function public.save_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if p_endpoint is null or p_endpoint = '' then
    raise exception 'Missing push endpoint' using errcode = '22023';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(coalesce(p_user_agent, ''), 200))
  on conflict (endpoint) do update
    set user_id    = excluded.user_id,
        p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        user_agent = excluded.user_agent,
        updated_at = now();
end;
$fn$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void
language sql
security definer
set search_path = public
as $fn$
  delete from public.push_subscriptions
   where endpoint = p_endpoint and user_id = auth.uid();
$fn$;

-- ---------------------------------------------------------------------
-- USER ADMINISTRATION
-- ---------------------------------------------------------------------
create or replace function public.admin_set_user_active(p_user_id uuid, p_active boolean)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $fn$
declare v_row public.profiles;
begin
  if not public.is_admin() then
    raise exception 'Administrators only' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() and not p_active then
    raise exception 'You cannot deactivate your own account' using errcode = '42501';
  end if;

  update public.profiles set active = p_active where id = p_user_id returning * into v_row;
  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  return v_row;
end;
$fn$;

create or replace function public.admin_set_user_role(p_user_id uuid, p_role text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $fn$
declare v_row public.profiles;
begin
  if not public.is_admin() then
    raise exception 'Administrators only' using errcode = '42501';
  end if;
  if p_role not in ('admin','employee') then
    raise exception 'Unknown role' using errcode = '22023';
  end if;
  if p_user_id = auth.uid() and p_role <> 'admin' then
    raise exception 'You cannot remove your own administrator role' using errcode = '42501';
  end if;

  update public.profiles set role = p_role where id = p_user_id returning * into v_row;
  if not found then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------
-- GRANTS
--   Nothing here is callable by a role that is not listed.
-- ---------------------------------------------------------------------
revoke all on function public.update_my_status(text, uuid, text, uuid, text, integer, uuid) from public;
revoke all on function public.finish_current_task() from public;
revoke all on function public.create_service_request(uuid, text, uuid, text, text, text) from public;
revoke all on function public.set_request_status(uuid, text, text) from public;
revoke all on function public.accept_request(uuid, boolean, integer) from public;
revoke all on function public.start_request(uuid, integer) from public;
revoke all on function public.set_request_priority(uuid, text) from public;
revoke all on function public.set_queue_order(uuid[]) from public;
revoke all on function public.mark_notifications_read(uuid[]) from public;
revoke all on function public.save_push_subscription(text, text, text, text) from public;
revoke all on function public.delete_push_subscription(text) from public;
revoke all on function public.admin_set_user_active(uuid, boolean) from public;
revoke all on function public.admin_set_user_role(uuid, text) from public;

grant execute on function public.update_my_status(text, uuid, text, uuid, text, integer, uuid) to authenticated;
grant execute on function public.finish_current_task() to authenticated;
grant execute on function public.create_service_request(uuid, text, uuid, text, text, text) to authenticated;
grant execute on function public.set_request_status(uuid, text, text) to authenticated;
grant execute on function public.accept_request(uuid, boolean, integer) to authenticated;
grant execute on function public.start_request(uuid, integer) to authenticated;
grant execute on function public.set_request_priority(uuid, text) to authenticated;
grant execute on function public.set_queue_order(uuid[]) to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;
grant execute on function public.admin_set_user_active(uuid, boolean) to authenticated;
grant execute on function public.admin_set_user_role(uuid, text) to authenticated;

-- The board reader is the one function anonymous visitors may call.
grant execute on function public.get_public_status() to anon, authenticated;
