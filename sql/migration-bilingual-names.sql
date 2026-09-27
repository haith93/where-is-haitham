-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-bilingual-names.sql
--
--  Run once, AFTER migration-public-requests.sql.
--
--  WHY
--  ---
--  Building and task names are DATA, not interface strings, so they were
--  not covered by the Arabic/English layer. "Computer repair" stayed in
--  English on an otherwise Arabic screen.
--
--  Each building and task now carries an optional Arabic name. Where one
--  is missing the English name is used, so nothing ever renders blank.
--
--  HISTORY
--  -------
--  Historical rows freeze the name they were created with, so that
--  renaming something later cannot rewrite old reports. That principle
--  still holds — there is simply a second frozen column now, so an old
--  report reads correctly in either language.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. THE LISTS
-- ---------------------------------------------------------------------
alter table public.buildings add column if not exists name_ar text
  check (name_ar is null or char_length(trim(name_ar)) between 1 and 80);
alter table public.tasks     add column if not exists name_ar text
  check (name_ar is null or char_length(trim(name_ar)) between 1 and 80);

-- ---------------------------------------------------------------------
-- 2. FROZEN ARABIC SNAPSHOTS
-- ---------------------------------------------------------------------
alter table public.service_requests
  add column if not exists location_name_ar_snapshot text,
  add column if not exists category_name_ar_snapshot text;

alter table public.status_history
  add column if not exists location_name_ar_snapshot text,
  add column if not exists task_name_ar_snapshot text;

alter table public.current_status
  add column if not exists location_name_ar_snapshot text,
  add column if not exists task_name_ar_snapshot text;

-- ---------------------------------------------------------------------
-- 3. NAME LOOKUP HELPERS
-- ---------------------------------------------------------------------
create or replace function public.building_name_ar(p_id uuid)
returns text language sql stable security definer set search_path = public as $fn$
  select nullif(trim(coalesce(name_ar, '')), '') from public.buildings where id = p_id;
$fn$;

create or replace function public.task_name_ar(p_id uuid)
returns text language sql stable security definer set search_path = public as $fn$
  select nullif(trim(coalesce(name_ar, '')), '') from public.tasks where id = p_id;
$fn$;

-- ---------------------------------------------------------------------
-- 4. ARABIC FOR THE SEEDED LISTS
--    Only fills rows that have no Arabic name yet, matched on the
--    English name, so an administrator's own edits are never overwritten.
-- ---------------------------------------------------------------------
update public.buildings b set name_ar = v.ar
  from (values
    ('Photocopy Center', 'مركز التصوير'),
    ('Administration',   'الإدارة'),
    ('Building 1',       'المبنى ١'),
    ('Building 2',       'المبنى ٢'),
    ('Building 3',       'المبنى ٣'),
    ('Building 4',       'المبنى ٤'),
    ('Building 5',       'المبنى ٥'),
    ('Building 6',       'المبنى ٦'),
    ('IT Office',        'مكتب تقنية المعلومات')
  ) as v(en, ar)
 where lower(trim(b.name)) = lower(v.en)
   and nullif(trim(coalesce(b.name_ar, '')), '') is null;

update public.tasks t set name_ar = v.ar
  from (values
    ('Photocopying',     'التصوير'),
    ('Printer repair',   'تصليح الطابعة'),
    ('Computer repair',  'تصليح الكمبيوتر'),
    ('School system',    'النظام المدرسي'),
    ('Projector',        'جهاز العرض'),
    ('Network / WiFi',   'الشبكة / الواي فاي'),
    ('Administration',   'الإدارة'),
    ('Helping employee', 'مساعدة موظف'),
    ('Meeting',          'اجتماع'),
    ('Equipment setup',  'تجهيز المعدات'),
    ('Other',            'أخرى')
  ) as v(en, ar)
 where lower(trim(t.name)) = lower(v.en)
   and nullif(trim(coalesce(t.name_ar, '')), '') is null;

-- Backfill the Arabic snapshots on rows that already exist, so today's
-- history does not look half-translated.
update public.service_requests sr
   set location_name_ar_snapshot = coalesce(sr.location_name_ar_snapshot, b.name_ar)
  from public.buildings b
 where b.id = sr.location_building_id and b.name_ar is not null;

update public.service_requests sr
   set category_name_ar_snapshot = coalesce(sr.category_name_ar_snapshot, t.name_ar)
  from public.tasks t
 where t.id = sr.category_task_id and t.name_ar is not null;

update public.status_history sh
   set location_name_ar_snapshot = coalesce(sh.location_name_ar_snapshot, b.name_ar)
  from public.buildings b
 where b.id = sh.building_id and b.name_ar is not null;

update public.status_history sh
   set task_name_ar_snapshot = coalesce(sh.task_name_ar_snapshot, t.name_ar)
  from public.tasks t
 where t.id = sh.task_id and t.name_ar is not null;

update public.current_status cs
   set location_name_ar_snapshot = coalesce(cs.location_name_ar_snapshot, b.name_ar)
  from public.buildings b
 where b.id = cs.building_id and b.name_ar is not null;

update public.current_status cs
   set task_name_ar_snapshot = coalesce(cs.task_name_ar_snapshot, t.name_ar)
  from public.tasks t
 where t.id = cs.task_id and t.name_ar is not null;

-- ---------------------------------------------------------------------
-- 5. STATUS UPDATES CARRY BOTH NAMES
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
  v_uid          uuid := auth.uid();
  v_now          timestamptz := now();
  v_expected     timestamptz;
  v_loc_name     text;
  v_task_name    text;
  v_loc_name_ar  text;
  v_task_name_ar text;
  v_history_id   uuid;
  v_row          public.current_status;
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

  v_loc_name  := coalesce(public.building_name(p_building_id), p_custom_location);
  v_task_name := coalesce(public.task_name(p_task_id), p_custom_task);

  -- A typed-in location has only the words the user typed, so the same
  -- text serves both languages.
  v_loc_name_ar  := coalesce(public.building_name_ar(p_building_id), p_custom_location);
  v_task_name_ar := coalesce(public.task_name_ar(p_task_id), p_custom_task);

  if p_building_id is not null and v_loc_name is null then
    raise exception 'That building no longer exists' using errcode = '23503';
  end if;
  if p_task_id is not null and v_task_name is null then
    raise exception 'That task no longer exists' using errcode = '23503';
  end if;

  if p_duration_minutes is not null then
    v_expected := v_now + make_interval(mins => p_duration_minutes);
  end if;

  update public.status_history
     set actual_end_at = v_now
   where user_id = v_uid and actual_end_at is null;

  insert into public.status_history (
    user_id, building_id, custom_location, location_name_snapshot, location_name_ar_snapshot,
    task_id, custom_task, task_name_snapshot, task_name_ar_snapshot,
    status_type, request_id, started_at, expected_end_at, duration_minutes
  ) values (
    v_uid, p_building_id, p_custom_location, v_loc_name, v_loc_name_ar,
    p_task_id, p_custom_task, v_task_name, v_task_name_ar,
    p_status_type, p_request_id, v_now, v_expected, p_duration_minutes
  )
  returning id into v_history_id;

  insert into public.current_status (
    user_id, building_id, custom_location, location_name_snapshot, location_name_ar_snapshot,
    task_id, custom_task, task_name_snapshot, task_name_ar_snapshot,
    status_type, history_id, serving_request_id, started_at, expected_end_at, updated_at
  ) values (
    v_uid, p_building_id, p_custom_location, v_loc_name, v_loc_name_ar,
    p_task_id, p_custom_task, v_task_name, v_task_name_ar,
    p_status_type, v_history_id,
    case when p_status_type = 'serving' then p_request_id else null end,
    v_now, v_expected, v_now
  )
  on conflict (user_id) do update set
    building_id               = excluded.building_id,
    custom_location           = excluded.custom_location,
    location_name_snapshot    = excluded.location_name_snapshot,
    location_name_ar_snapshot = excluded.location_name_ar_snapshot,
    task_id                   = excluded.task_id,
    custom_task               = excluded.custom_task,
    task_name_snapshot        = excluded.task_name_snapshot,
    task_name_ar_snapshot     = excluded.task_name_ar_snapshot,
    status_type               = excluded.status_type,
    history_id                = excluded.history_id,
    serving_request_id        = excluded.serving_request_id,
    next_request_id           = case when excluded.status_type = 'traveling'
                                     then public.current_status.next_request_id else null end,
    started_at                = excluded.started_at,
    expected_end_at           = excluded.expected_end_at,
    updated_at                = excluded.updated_at
  returning * into v_row;

  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 6. REQUESTS CARRY BOTH NAMES
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
  if p_priority not in ('normal', 'urgent', 'very_urgent') then
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
  if p_priority not in ('normal', 'urgent', 'very_urgent') then
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

-- ---------------------------------------------------------------------
-- 7. THE PUBLIC BOARD CARRIES BOTH LANGUAGES
--    The browser picks; the database never guesses which one to send.
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
               coalesce(sr.location_name_ar_snapshot, sr.location_name_snapshot) as location_ar,
               sr.category_name_snapshot  as category,
               coalesce(sr.category_name_ar_snapshot, sr.category_name_snapshot) as category_ar,
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

-- ---------------------------------------------------------------------
-- 8. "FOLLOW MY REQUEST" ALSO RETURNS BOTH NAMES
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
                        where q.status in ('pending', 'accepted')
                          and q.created_at < sr.created_at)
  )
  from public.service_requests sr
  where sr.public_token = p_token;
$fn$;

-- Refresh the stored snapshot so the board shows Arabic immediately.
update public.public_board
   set snapshot = public.build_public_snapshot(), updated_at = now()
 where id = 1;

commit;

notify pgrst, 'reload schema';
