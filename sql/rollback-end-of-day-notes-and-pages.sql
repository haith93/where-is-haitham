-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  rollback-end-of-day-notes-and-pages.sql
--
--  Undoes sql/migration-end-of-day-notes-and-pages.sql and leaves
--  migration 14 in place.
--
--  WHAT COMES BACK
--  ---------------
--  update_my_status without the end-of-day close, the two print RPCs
--  without a page count, and both readers without pages, sheets or the
--  message. annotate_request and print_sheets are dropped.
--
--  WHAT IS KEPT, DELIBERATELY
--  --------------------------
--  The two new columns stay: service_requests.admin_message and
--  print_jobs.pages. Dropping them would delete sentences Haitham typed
--  to colleagues and page counts people counted by hand. Nothing reads
--  them once this script has run, so they sit there costing nothing
--  until the migration is applied again, at which point the content is
--  still there.
--
--  Also kept: the live status re-pointed at the photocopying task in
--  section 0. Putting "Printer repair" back on a photocopying job is
--  not an undo, it is a regression.
--
--  AFTER THIS RUNS
--  ---------------
--  "Finished for the day" goes back to being stored open-ended, so a
--  report run the next day will again count the intervening hours as
--  time at work. It also loses the return date: update_my_status goes
--  back to seven arguments, and any date already stored in
--  expected_end_at stays in the column but is no longer settable.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. update_my_status, open-ended again
-- ---------------------------------------------------------------------
drop function if exists public.update_my_status(
  text, uuid, text, uuid, text, integer, uuid, timestamptz);

create function public.update_my_status(
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
-- 2. The print RPCs, without a page count
-- ---------------------------------------------------------------------
create or replace function public.create_print_request(
  p_requester_name   text,
  p_files            jsonb,
  p_title            text default null,
  p_priority         text default 'normal',
  p_building_id      uuid default null,
  p_custom_location  text default null,
  p_device_id        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_name    text := nullif(trim(coalesce(p_requester_name, '')), '');
  v_title   text := nullif(trim(coalesce(p_title, '')), '');
  v_count   integer;
  v_file    jsonb;
  v_upload  public.print_uploads;
  v_grade   public.school_grades;
  v_deliv   text;
  v_ftitle  text;
  v_copies  integer;
  v_paper   text;
  v_sides   text;
  v_colour  text;
  v_perm    boolean;
  v_note    text;
  v_loc     text;
  v_task_id uuid;
  v_cat     text;
  v_task    public.tasks;
  v_bld     public.buildings;
  v_row     public.service_requests;
  v_admin   record;
  v_recent  integer;
  v_pos     integer := 0;
  v_first   text;
begin
  if v_name is null or char_length(v_name) > 120 then
    raise exception 'Please give your name' using errcode = '22023';
  end if;

  select count(*) into v_recent
    from public.service_requests sr
   where sr.created_at > now() - interval '10 minutes'
     and sr.requester_name_snapshot = v_name;
  if v_recent >= 5 then
    raise exception 'Too many requests just now. Please wait a few minutes.'
      using errcode = '53400';
  end if;

  if p_priority not in ('normal', 'urgent', 'very_urgent', 'life_death') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;

  if p_files is null or jsonb_typeof(p_files) <> 'array' then
    raise exception 'Please choose the document to print' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_files);

  if v_count = 0 then
    raise exception 'Please choose the document to print' using errcode = '22023';
  end if;

  -- Only a Normal request may carry several documents.
  if p_priority <> 'normal' and v_count > 1 then
    raise exception 'An urgent request can carry only one document'
      using errcode = '22023';
  end if;

  if v_count > 10 then
    raise exception 'Please send at most 10 documents in one request'
      using errcode = '22023';
  end if;

  if v_title is not null and char_length(v_title) > 120 then
    raise exception 'Please shorten the title' using errcode = '22023';
  end if;

  -- Where it is collected; the form does not ask.
  if p_building_id is not null then
    select name into v_loc from public.buildings where id = p_building_id and active;
    if v_loc is null then
      raise exception 'Unknown building' using errcode = '22023';
    end if;
  else
    v_loc := nullif(trim(coalesce(p_custom_location, '')), '');
  end if;

  if v_loc is null then
    v_bld := public.print_location();
    p_building_id := v_bld.id;
    v_loc := v_bld.name;
  end if;

  if v_loc is null then
    v_loc := 'Photocopy Centre';
  end if;

  -- Ranked, and "Printer repair" is excluded. See section 1.
  v_task := public.print_task();
  v_task_id := v_task.id;
  v_cat := v_task.name;
  if v_cat is null then
    v_cat := 'Printing';
  end if;

  insert into public.service_requests (
    request_number, requester_id, requester_name_snapshot,
    location_building_id, custom_location, location_name_snapshot,
    location_name_ar_snapshot,
    category_task_id, custom_category, category_name_snapshot,
    category_name_ar_snapshot,
    description, priority, status, channel, request_type, queue_position
  )
  values (
    public.next_request_number(), null, v_name,
    p_building_id,
    case when p_building_id is null then v_loc end,
    v_loc,
    coalesce(public.building_name_ar(p_building_id), v_loc),
    v_task_id,
    case when v_task_id is null then v_cat end,
    v_cat,
    coalesce(public.task_name_ar(v_task_id), v_cat),
    null, p_priority, 'pending', 'app', 'print',
    coalesce((select max(queue_position) from public.service_requests
               where status in ('pending', 'accepted')), 0) + 1
  )
  returning * into v_row;

  ------------------------------------------------------------------
  -- Each document
  ------------------------------------------------------------------
  for v_file in select * from jsonb_array_elements(p_files)
  loop
    v_pos := v_pos + 1;

    v_deliv := coalesce(v_file ->> 'delivery', 'upload');
    if v_deliv not in ('upload', 'hand', 'whatsapp', 'email', 'shared_folder', 'other') then
      raise exception 'Unknown delivery' using errcode = '22023';
    end if;

    -- A document nobody can open must at least say what it is. The
    -- request title stands in, so one sheet of paper needs nothing extra.
    v_ftitle := coalesce(nullif(trim(coalesce(v_file ->> 'title', '')), ''), v_title);

    v_upload := null;
    if v_deliv = 'upload' then
      select * into v_upload
        from public.print_uploads
       where id = (v_file ->> 'upload_id')::uuid
         and consumed_at is null
       for update;

      if v_upload.id is null then
        raise exception 'A document was not uploaded, or has already been used'
          using errcode = 'P0002';
      end if;
    elsif v_ftitle is null then
      raise exception 'Please say what the document is' using errcode = '22023';
    end if;

    v_copies := coalesce((v_file ->> 'copies')::integer, 1);
    if v_copies < 1 or v_copies > 500 then
      raise exception 'Copies must be between 1 and 500' using errcode = '22023';
    end if;

    v_paper := coalesce(v_file ->> 'paper_size', 'A4');
    if not exists (select 1 from public.paper_sizes where code = v_paper and active) then
      raise exception 'Unknown paper size' using errcode = '22023';
    end if;

    v_sides := coalesce(v_file ->> 'print_sides', 'single');
    if v_sides not in ('single', 'double') then
      raise exception 'Unknown sides option' using errcode = '22023';
    end if;

    v_colour := coalesce(v_file ->> 'color_mode', 'bw');
    if v_colour not in ('bw', 'color') then
      raise exception 'Unknown colour mode' using errcode = '22023';
    end if;

    v_perm := (v_file ->> 'color_permission')::boolean;
    if v_colour = 'color' and coalesce(v_perm, false) is not true then
      raise exception 'Colour printing needs permission' using errcode = '42501';
    end if;

    v_note := nullif(trim(coalesce(v_file ->> 'note', '')), '');
    if v_note is not null and char_length(v_note) > 100 then
      raise exception 'A note is limited to 100 characters' using errcode = '22023';
    end if;

    v_grade := null;
    if nullif(v_file ->> 'grade_id', '') is not null then
      select * into v_grade
        from public.school_grades
       where id = (v_file ->> 'grade_id')::uuid and active;
      if v_grade.id is null then
        raise exception 'Unknown class' using errcode = '22023';
      end if;
    end if;

    insert into public.print_jobs (
      request_id, position, title, delivery, storage_provider, storage_path,
      original_filename, mime_type, file_size,
      paper_size, color_mode, color_permission, print_sides, copies,
      grade_id, section_snapshot, level_snapshot, grade_snapshot, note
    ) values (
      v_row.id, v_pos, v_ftitle, v_deliv, 'supabase', v_upload.storage_path,
      v_upload.original_filename, v_upload.mime_type, v_upload.file_size,
      v_paper, v_colour,
      case when v_colour = 'color' then v_perm end,
      v_sides, v_copies,
      v_grade.id, v_grade.section, v_grade.level_name, v_grade.grade_name_ar,
      v_note
    );

    if v_upload.id is not null then
      update public.print_uploads set consumed_at = now() where id = v_upload.id;
    end if;

    if v_pos = 1 then
      v_first := coalesce(v_upload.original_filename, v_ftitle);
    end if;
  end loop;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (v_row.id, null, null, 'pending',
          'Print request created (' || v_count || ' document'
          || case when v_count = 1 then '' else 's' end || ')');

  for v_admin in select id from public.profiles where role = 'admin' and active loop
    insert into public.notifications (user_id, request_id, title, message, type)
    values (
      v_admin.id, v_row.id,
      case v_row.priority
        when 'life_death'  then 'LIFE & DEATH print job'
        when 'very_urgent' then 'VERY URGENT print job'
        when 'urgent'      then 'Urgent print job'
        else 'New print job' end,
      v_name || ' - ' || coalesce(v_title, v_first)
             || case when v_count > 1 then ' (+' || (v_count - 1) || ' more)' else '' end,
      'new_request'
    );
  end loop;

  return jsonb_build_object(
    'request_number', v_row.request_number,
    'public_token',   v_row.public_token,
    'files',          v_count,
    'people_ahead',   (select count(*) from public.service_requests q
                        where q.status in ('pending', 'accepted', 'paused')
                          and q.created_at < v_row.created_at)
  );
end;
$fn$;

create or replace function public.admin_create_print_request(
  p_requester_name   text,
  p_files            jsonb,
  p_channel          text    default 'in_person',
  p_title            text    default null,
  p_priority         text    default 'normal',
  p_notes            text    default null,
  p_building_id      uuid    default null,
  p_custom_location  text    default null,
  p_start_now        boolean default false,
  p_duration_minutes integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_name    text := nullif(trim(coalesce(p_requester_name, '')), '');
  v_title   text := nullif(trim(coalesce(p_title, '')), '');
  v_notes   text := nullif(trim(coalesce(p_notes, '')), '');
  v_count   integer;
  v_file    jsonb;
  v_upload  public.print_uploads;
  v_grade   public.school_grades;
  v_deliv   text;
  v_ftitle  text;
  v_copies  integer;
  v_paper   text;
  v_sides   text;
  v_colour  text;
  v_perm    boolean;
  v_note    text;
  v_loc     text;
  v_task_id uuid;
  v_cat     text;
  v_task    public.tasks;
  v_bld     public.buildings;
  v_row     public.service_requests;
  v_pos     integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can record a request' using errcode = '42501';
  end if;

  if v_name is null or char_length(v_name) > 120 then
    raise exception 'Please say who asked' using errcode = '22023';
  end if;

  if p_channel not in ('app', 'whatsapp', 'phone', 'in_person', 'other') then
    raise exception 'Unknown channel' using errcode = '22023';
  end if;

  if p_priority not in ('normal', 'urgent', 'very_urgent', 'life_death') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;

  if p_files is null or jsonb_typeof(p_files) <> 'array' then
    raise exception 'Please add at least one document' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_files);
  if v_count = 0 then
    raise exception 'Please add at least one document' using errcode = '22023';
  end if;
  if v_count > 10 then
    raise exception 'Please record at most 10 documents in one request' using errcode = '22023';
  end if;

  -- Location, as the help form records it.
  if p_building_id is not null then
    select name into v_loc from public.buildings where id = p_building_id and active;
    if v_loc is null then
      raise exception 'Unknown building' using errcode = '22023';
    end if;
  else
    v_loc := nullif(trim(coalesce(p_custom_location, '')), '');
  end if;

  if v_loc is null then
    v_bld := public.print_location();
    p_building_id := v_bld.id;
    v_loc := v_bld.name;
  end if;

  if v_loc is null then
    v_loc := 'Photocopy Centre';
  end if;

  -- Ranked, and "Printer repair" is excluded. See section 1.
  v_task := public.print_task();
  v_task_id := v_task.id;
  v_cat := v_task.name;
  if v_cat is null then
    v_cat := 'Printing';
  end if;

  insert into public.service_requests (
    request_number, requester_id, requester_name_snapshot,
    location_building_id, custom_location, location_name_snapshot,
    location_name_ar_snapshot,
    category_task_id, custom_category, category_name_snapshot,
    category_name_ar_snapshot,
    description, priority, status, channel, request_type, notes,
    created_by, queue_position,
    accepted_at, started_at
  )
  values (
    public.next_request_number(), null, v_name,
    p_building_id,
    case when p_building_id is null then v_loc end,
    v_loc,
    coalesce(public.building_name_ar(p_building_id), v_loc),
    v_task_id,
    case when v_task_id is null then v_cat end,
    v_cat,
    coalesce(public.task_name_ar(v_task_id), v_cat),
    null, p_priority,
    case when p_start_now then 'in_progress' else 'pending' end,
    p_channel, 'print', v_notes,
    v_uid,
    coalesce((select max(queue_position) from public.service_requests
               where status in ('pending', 'accepted')), 0) + 1,
    case when p_start_now then now() end,
    case when p_start_now then now() end
  )
  returning * into v_row;

  ------------------------------------------------------------------
  -- Each document
  ------------------------------------------------------------------
  for v_file in select * from jsonb_array_elements(p_files)
  loop
    v_pos := v_pos + 1;

    v_deliv := coalesce(v_file ->> 'delivery', 'upload');
    if v_deliv not in ('upload', 'hand', 'whatsapp', 'email', 'shared_folder', 'other') then
      raise exception 'Unknown delivery' using errcode = '22023';
    end if;

    -- A document with no file must say what it is. The request title is
    -- the fallback, so one paper handed over needs nothing extra typed.
    v_ftitle := coalesce(nullif(trim(coalesce(v_file ->> 'title', '')), ''), v_title);

    v_upload := null;
    if v_deliv = 'upload' then
      select * into v_upload
        from public.print_uploads
       where id = (v_file ->> 'upload_id')::uuid
         and consumed_at is null
       for update;

      if v_upload.id is null then
        raise exception 'A document was not uploaded, or has already been used'
          using errcode = 'P0002';
      end if;
    elsif v_ftitle is null then
      raise exception 'Please name a document that was not attached'
        using errcode = '22023';
    end if;

    v_copies := coalesce((v_file ->> 'copies')::integer, 1);
    if v_copies < 1 or v_copies > 500 then
      raise exception 'Copies must be between 1 and 500' using errcode = '22023';
    end if;

    v_paper := coalesce(v_file ->> 'paper_size', 'A4');
    if not exists (select 1 from public.paper_sizes where code = v_paper and active) then
      raise exception 'Unknown paper size' using errcode = '22023';
    end if;

    v_sides := coalesce(v_file ->> 'print_sides', 'single');
    if v_sides not in ('single', 'double') then
      raise exception 'Unknown sides option' using errcode = '22023';
    end if;

    v_colour := coalesce(v_file ->> 'color_mode', 'bw');
    if v_colour not in ('bw', 'color') then
      raise exception 'Unknown colour mode' using errcode = '22023';
    end if;

    -- Haitham recording his own job still answers the colour question,
    -- because the answer is what the report counts.
    v_perm := (v_file ->> 'color_permission')::boolean;
    if v_colour = 'color' and coalesce(v_perm, false) is not true then
      raise exception 'Colour printing needs permission' using errcode = '42501';
    end if;

    v_note := nullif(trim(coalesce(v_file ->> 'note', '')), '');
    if v_note is not null and char_length(v_note) > 100 then
      raise exception 'A note is limited to 100 characters' using errcode = '22023';
    end if;

    v_grade := null;
    if nullif(v_file ->> 'grade_id', '') is not null then
      select * into v_grade
        from public.school_grades
       where id = (v_file ->> 'grade_id')::uuid and active;
      if v_grade.id is null then
        raise exception 'Unknown class' using errcode = '22023';
      end if;
    end if;

    insert into public.print_jobs (
      request_id, position, title, delivery, storage_provider, storage_path,
      original_filename, mime_type, file_size,
      paper_size, color_mode, color_permission, print_sides, copies,
      grade_id, section_snapshot, level_snapshot, grade_snapshot, note
    ) values (
      v_row.id, v_pos, v_ftitle, v_deliv, 'supabase', v_upload.storage_path,
      v_upload.original_filename, v_upload.mime_type, v_upload.file_size,
      v_paper, v_colour,
      case when v_colour = 'color' then v_perm end,
      v_sides, v_copies,
      v_grade.id, v_grade.section, v_grade.level_name, v_grade.grade_name_ar,
      v_note
    );

    if v_upload.id is not null then
      update public.print_uploads set consumed_at = now() where id = v_upload.id;
    end if;
  end loop;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (v_row.id, v_uid, null, v_row.status,
          'Print request recorded by an administrator (' || v_count || ' document'
          || case when v_count = 1 then '' else 's' end || ')');

  -- Starting it immediately moves his status, exactly as the help form does.
  if p_start_now then
    perform public.update_my_status(
      'serving', p_building_id, case when p_building_id is null then v_loc end,
      v_task_id, case when v_task_id is null then v_cat end,
      p_duration_minutes,   -- as given: no duration forced, so an
                            -- open-ended job stays open-ended
      v_row.id          -- ties the status to this request, so the
    );                  -- board can name who he is with
  end if;

  return jsonb_build_object(
    'request_number', v_row.request_number,
    'files',          v_count,
    'status',         v_row.status
  );
end;
$fn$;

-- ---------------------------------------------------------------------
-- 3. What the colleague reads back, without the message
-- ---------------------------------------------------------------------
create or replace function public.get_request_by_token(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'id',             sr.id,
    'request_number', sr.request_number,
    'requester',      sr.requester_name_snapshot,
    'location',       sr.location_name_snapshot,
    'location_ar',    coalesce(sr.location_name_ar_snapshot, sr.location_name_snapshot),
    'category',       sr.category_name_snapshot,
    'category_ar',    coalesce(sr.category_name_ar_snapshot, sr.category_name_snapshot),
    'description',    sr.description,
    'priority',       sr.priority,
    'flagged_priority', sr.flagged_priority,
    'flag_note',        sr.flag_note,
    'flagged_at',       sr.flagged_at,
    'status',         sr.status,
    'channel',        sr.channel,
    'request_type',   sr.request_type,
    'created_at',     sr.created_at,
    'accepted_at',    sr.accepted_at,
    'started_at',     sr.started_at,
    'completed_at',   sr.completed_at,
    'people_ahead',   (select count(*) from public.service_requests q
                        where q.status in ('pending', 'accepted', 'paused')
                          and q.created_at < sr.created_at),
    'print_files',    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',                pj.id,
        'position',          pj.position,
        'title',             pj.title,
        'original_filename', pj.original_filename,
        'file_size',         pj.file_size,
        'paper_size',        pj.paper_size,
        'color_mode',        pj.color_mode,
        'print_sides',       pj.print_sides,
        'copies',            pj.copies,
        'section',           pj.section_snapshot,
        'level',             pj.level_snapshot,
        'grade',             pj.grade_snapshot,
        'note',              pj.note
      ) order by pj.position), '[]'::jsonb)
      from public.print_jobs pj where pj.request_id = sr.id
    )
  )
  from public.service_requests sr
  where sr.public_token = p_token;
$fn$;

-- ---------------------------------------------------------------------
-- 4. What the console reads back, without pages
-- ---------------------------------------------------------------------
create or replace function public.admin_print_jobs(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v jsonb;
begin
  if not public.is_admin() then
    raise exception 'Administrators only' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',                pj.id,
    'position',          pj.position,
    'title',             pj.title,
    'delivery',          pj.delivery,
    'original_filename', pj.original_filename,
    'mime_type',         pj.mime_type,
    'file_size',         pj.file_size,
    'paper_size',        pj.paper_size,
    'color_mode',        pj.color_mode,
    'color_permission',  pj.color_permission,
    'print_sides',       pj.print_sides,
    'copies',            pj.copies,
    'section',           pj.section_snapshot,
    'level',             pj.level_snapshot,
    'grade',             pj.grade_snapshot,
    'note',              pj.note
  ) order by pj.position), '[]'::jsonb) into v
  from public.print_jobs pj
  where pj.request_id = p_request_id;

  return v;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 5. The new functions go
-- ---------------------------------------------------------------------
drop function if exists public.annotate_request(uuid, text, text);
drop function if exists public.print_sheets(integer, text, integer);

-- The columns are NOT dropped. See the header.

-- ---------------------------------------------------------------------
-- 6. Grants, restated
-- ---------------------------------------------------------------------
revoke all on function public.update_my_status(
  text, uuid, text, uuid, text, integer, uuid) from public;
grant execute on function public.update_my_status(
  text, uuid, text, uuid, text, integer, uuid) to authenticated;

revoke all on function public.get_request_by_token(uuid) from public;
grant execute on function public.get_request_by_token(uuid) to anon, authenticated;

revoke all on function public.admin_print_jobs(uuid) from public;
grant execute on function public.admin_print_jobs(uuid) to authenticated;

revoke all on function public.create_print_request(
  text, jsonb, text, text, uuid, text, text) from public;
grant execute on function public.create_print_request(
  text, jsonb, text, text, uuid, text, text) to anon, authenticated;

revoke all on function public.admin_create_print_request(
  text, jsonb, text, text, text, text, uuid, text, boolean, integer) from public;
grant execute on function public.admin_create_print_request(
  text, jsonb, text, text, text, text, uuid, text, boolean, integer) to authenticated;

commit;

notify pgrst, 'reload schema';
