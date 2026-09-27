-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-buildings-and-interruptions.sql
--
--  Run once, after the earlier migrations.
--
--  PART A  the real buildings, replacing the placeholder list
--  PART B  putting a request down without finishing it
-- =====================================================================

begin;

-- =====================================================================
--  PART A — REAL BUILDINGS
--
--  Old rows are DISABLED, never deleted: every request and every status
--  already recorded points at them, and historical reports must keep
--  reading correctly. Disabling only removes them from the menus.
-- =====================================================================

insert into public.buildings (name, name_ar, display_order)
select v.name, v.name_ar, v.ord
  from (values
    ('Rihab Zahraa HS',         'مبنى الثانوية',          1),
    ('Rihab Zahraa BE',         'مبنى التعليم الأساسي',   2),
    ('KG Building',             'مبنى الروضات',           3),
    ('Papyrus',                 'بابيروس',                4),
    ('AFAAK Vocational',        'معهد الآفاق',            5),
    ('Headquarters',            'مبنى الإدارات',          6),
    ('Rihab Zahraa Orphanage',  'المبرة',                 7)
  ) as v(name, name_ar, ord)
 where not exists (
   select 1 from public.buildings b where lower(trim(b.name)) = lower(trim(v.name))
 );

-- If a building already existed, make sure it carries the Arabic name
-- and the new ordering.
update public.buildings b
   set name_ar       = v.name_ar,
       display_order = v.ord,
       active        = true
  from (values
    ('Rihab Zahraa HS',         'مبنى الثانوية',          1),
    ('Rihab Zahraa BE',         'مبنى التعليم الأساسي',   2),
    ('KG Building',             'مبنى الروضات',           3),
    ('Papyrus',                 'بابيروس',                4),
    ('AFAAK Vocational',        'معهد الآفاق',            5),
    ('Headquarters',            'مبنى الإدارات',          6),
    ('Rihab Zahraa Orphanage',  'المبرة',                 7)
  ) as v(name, name_ar, ord)
 where lower(trim(b.name)) = lower(trim(v.name));

-- Retire the generic placeholders.
update public.buildings
   set active = false, display_order = 90
 where lower(trim(name)) in ('building 1', 'building 2', 'building 3',
                             'building 4', 'building 5', 'building 6');

-- Rooms that are not buildings. "Photocopy Center" and "IT Office" are
-- kept active because they are real places Haitham works in; the old
-- generic "Administration" is superseded by Headquarters.
update public.buildings
   set active = false, display_order = 91
 where lower(trim(name)) = 'administration';

update public.buildings b
   set name_ar = coalesce(nullif(trim(b.name_ar), ''), v.ar),
       display_order = v.ord
  from (values
    ('Photocopy Center', 'مركز التصوير', 8),
    ('IT Office',        'مكتب المعلوماتية', 9)
  ) as v(en, ar, ord)
 where lower(trim(b.name)) = lower(v.en);

--  "Outside the site" is NOT a building row. The location dropdown already
--  ends with "+ Other / custom location", which reveals a free-text box and
--  records exactly what was typed without adding it to the permanent list.
--  That is the right home for "I am off site today".

-- =====================================================================
--  PART B — INTERRUPTIONS
--
--  Until now a started request could only move forward: complete it,
--  cancel it, or leave it hanging. Real days are not like that. Something
--  very urgent arrives by WhatsApp and the job in hand has to be put
--  down, unfinished, and picked up later.
--
--  "paused" is that state. It is still an OPEN request: it stays in the
--  queue, stays in the counts, and nobody has to remember it exists.
-- =====================================================================

alter table public.service_requests
  drop constraint if exists service_requests_status_check;

alter table public.service_requests
  add constraint service_requests_status_check
  check (status in ('pending', 'accepted', 'in_progress', 'paused',
                    'completed', 'rejected', 'cancelled'));

alter table public.service_requests
  add column if not exists paused_at timestamptz,
  add column if not exists pause_reason text
    check (pause_reason is null or char_length(pause_reason) <= 300);

create index if not exists sr_paused_idx on public.service_requests (status)
  where status = 'paused';

-- ---------------------------------------------------------------------
-- Put a request down
-- ---------------------------------------------------------------------
create or replace function public.pause_request(
  p_request_id uuid,
  p_reason     text default null
)
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_row    public.service_requests;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can pause a request' using errcode = '42501';
  end if;

  select * into v_row from public.service_requests where id = p_request_id for update;
  if v_row is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'in_progress' then
    raise exception 'Only a request that is being worked on can be paused' using errcode = '42501';
  end if;

  update public.service_requests
     set status       = 'paused',
         paused_at    = now(),
         pause_reason = v_reason
   where id = p_request_id
  returning * into v_row;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (p_request_id, v_uid, 'in_progress', 'paused',
          coalesce(v_reason, 'Interrupted by something more urgent'));

  -- Nobody is being served by a paused request.
  update public.current_status
     set serving_request_id = null
   where serving_request_id = p_request_id;

  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------
-- Pick it back up
-- ---------------------------------------------------------------------
create or replace function public.resume_request(
  p_request_id       uuid,
  p_duration_minutes integer default null
)
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $fn$
declare v_row public.service_requests;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can resume a request' using errcode = '42501';
  end if;

  select * into v_row from public.service_requests where id = p_request_id for update;
  if v_row is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'paused' then
    raise exception 'That request is not paused' using errcode = '42501';
  end if;

  -- start_request does the rest: it pauses whatever is in progress, moves
  -- the status to the requester's location, and logs the transition.
  update public.service_requests
     set status = 'in_progress', paused_at = null, pause_reason = null
   where id = p_request_id;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (p_request_id, auth.uid(), 'paused', 'in_progress', 'Resumed');

  select * into v_row from public.service_requests where id = p_request_id;

  perform public.update_my_status(
    'serving',
    v_row.location_building_id,
    case when v_row.location_building_id is null then v_row.location_name_snapshot end,
    v_row.category_task_id,
    case when v_row.category_task_id is null then v_row.category_name_snapshot end,
    p_duration_minutes,
    v_row.id
  );

  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------
-- Starting something else now pauses what was in hand
--
-- This is the whole point: when the urgent thing arrives, Haitham taps
-- "Start now" on it and the job he was doing is set down automatically,
-- with a note saying why. Nothing is forgotten and nothing is faked as
-- finished.
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
  v_req     public.service_requests;
  v_other   public.service_requests;
  v_new_num text;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can start requests' using errcode = '42501';
  end if;

  select request_number into v_new_num
    from public.service_requests where id = p_request_id;

  -- Set down anything already in hand, naming what displaced it.
  for v_other in
    select * from public.service_requests
     where status = 'in_progress' and id <> p_request_id
  loop
    perform public.pause_request(
      v_other.id,
      'Interrupted by ' || coalesce(v_new_num, 'a more urgent request')
    );
  end loop;

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
-- A paused request is still open, so it belongs on the board
-- ---------------------------------------------------------------------
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
                          case sr.priority when 'very_urgent' then 0 when 'urgent' then 1 else 2 end,
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
        'very_urgent', count(*) filter (where status in ('pending','accepted','paused') and priority = 'very_urgent')
      )
      from public.service_requests
    )
  );
$fn$;

-- The queue position helpers must know about paused requests too.
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
    'location_ar',    coalesce(sr.location_name_ar_snapshot, sr.location_name_snapshot),
    'category',       sr.category_name_snapshot,
    'category_ar',    coalesce(sr.category_name_ar_snapshot, sr.category_name_snapshot),
    'description',    sr.description,
    'priority',       sr.priority,
    'status',         sr.status,
    'channel',        sr.channel,
    'created_at',     sr.created_at,
    'accepted_at',    sr.accepted_at,
    'started_at',     sr.started_at,
    'completed_at',   sr.completed_at,
    'people_ahead',   (select count(*) from public.service_requests q
                        where q.status in ('pending', 'accepted', 'paused')
                          and q.created_at < sr.created_at)
  )
  from public.service_requests sr
  where sr.public_token = p_token;
$fn$;

-- ---------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------
revoke all on function public.pause_request(uuid, text) from public;
revoke all on function public.resume_request(uuid, integer) from public;

grant execute on function public.pause_request(uuid, text)     to authenticated;
grant execute on function public.resume_request(uuid, integer) to authenticated;

-- Refresh the board so the new shape shows immediately.
update public.public_board
   set snapshot = public.build_public_snapshot(), updated_at = now()
 where id = 1;

commit;

notify pgrst, 'reload schema';

-- =====================================================================
--  CHECK IT
--    select name, name_ar, active, display_order
--      from public.buildings order by display_order, name;
-- =====================================================================
