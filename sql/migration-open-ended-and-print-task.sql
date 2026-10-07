-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-open-ended-and-print-task.sql
--
--  Run once, after migration-public-offline-delivery.sql.
--  Undo:  sql/rollback-open-ended-and-print-task.sql
--
--  THREE THINGS, ALL ABOUT WHAT HAPPENS AROUND A REQUEST
--  -----------------------------------------------------
--  1. A print request was being filed under the wrong task. The task was
--     chosen by matching names against `like '%print%'`, and "Printer
--     repair" matches that as readily as "Photocopying" does. Whichever
--     of the two had the lower display_order won, so reordering the task
--     list silently changed what a print job was called. Sections 1-3
--     replace the guess with one function that decides, ranked so that
--     photocopying beats printing beats copying, and repair never wins.
--
--  2. Finishing a job left the board saying he was still on it.
--     set_request_status cleared the request pointers but never moved
--     status_type, so "serving Ahmad at the Girls Building" stayed up
--     until he remembered to change it by hand. Section 5 frees the
--     status when the request that owned it closes.
--
--  3. Starting a recorded print job forced a 15-minute window even when
--     no duration was asked for. Section 3 passes the duration through
--     as given, so no time means no fixed finish time.
--
--  ONE DATA CORRECTION, DELIBERATE
--  -------------------------------
--  Section 4 re-files existing print requests under the right task.
--  This rewrites category_task_id and the two name snapshots on rows
--  that already exist, including closed ones, because the value was
--  never chosen by anybody - it was derived, and derived wrongly, and
--  reports group by it. Leaving it would mean every report attributes
--  photocopying to printer repair for ever.
--
--  It does NOT touch:
--    * the location, which Haitham can choose by hand on the record
--      form, so his choice is his;
--    * status_history, which is a record of what the board actually
--      displayed at the time. That it displayed the wrong thing is a
--      fact about the past, not a value to correct.
--
--  The rollback restores the old functions and will NOT put the wrong
--  task names back.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Where a print job is filed, decided in one place
--
--    Both print RPCs used to carry their own copy of this lookup, which
--    is how one loose pattern ended up in five migrations. They call
--    these instead now, so there is a single place to correct.
--
--    The ranking matters more than the matching. Several task names can
--    plausibly mean "this is the photocopying job", and the old query
--    left the winner to display_order - an ordering the admin console
--    lets you drag around, with no hint that doing so retargets every
--    future print request.
-- ---------------------------------------------------------------------
create or replace function public.print_task()
returns public.tasks
language sql
stable
security definer
set search_path = public
as $fn$
  select *
    from public.tasks
   where active
     and (lower(name) like '%photocop%'
       or lower(name) like '%printing%'
       or lower(name) like '%print job%'
       or lower(name) like '%copying%'
       or lower(name) like '%copies%'
       or coalesce(name_ar, '') like '%تصوير%')
     -- Repairing a printer is a different job that happens to share a
     -- word. This is the line that was missing.
     and lower(name) not like '%repair%'
     and lower(name) not like '%fix%'
     and lower(name) not like '%maintenance%'
     and coalesce(name_ar, '') not like '%تصليح%'
     and coalesce(name_ar, '') not like '%صيانة%'
   order by case
     when lower(name) like '%photocop%'          then 0
     when coalesce(name_ar, '') like '%تصوير%'    then 0
     when lower(name) like '%printing%'          then 1
     when lower(name) like '%print job%'         then 1
     when lower(name) like '%copying%'           then 2
     else 3
   end, display_order
   limit 1;
$fn$;

create or replace function public.print_location()
returns public.buildings
language sql
stable
security definer
set search_path = public
as $fn$
  select *
    from public.buildings
   where active
     and (lower(name) like '%photocop%'
       or lower(name) like '%copy cent%'
       or lower(name) like '%copy room%'
       or lower(name) like '%print%'
       or lower(name) like '%copy%'
       or coalesce(name_ar, '') like '%تصوير%')
   order by case
     when lower(name) like '%photocop%'       then 0
     when coalesce(name_ar, '') like '%تصوير%' then 0
     when lower(name) like '%copy cent%'      then 1
     when lower(name) like '%copy room%'      then 1
     when lower(name) like '%print%'          then 2
     else 3
   end, display_order
   limit 1;
$fn$;

revoke all on function public.print_task() from public;
revoke all on function public.print_location() from public;
grant execute on function public.print_task() to anon, authenticated;
grant execute on function public.print_location() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. The public print form files its request through the helpers
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

-- ---------------------------------------------------------------------
-- 3. So does the record form, and it no longer forces 15 minutes
-- ---------------------------------------------------------------------
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
-- 4. Re-file print requests that landed under the wrong task
--
--    See the header: this rewrites derived values, not chosen ones, and
--    the rollback will not undo it.
-- ---------------------------------------------------------------------
do $do$
declare
  v_task public.tasks := public.print_task();
  v_n    integer;
begin
  if v_task.id is null then
    raise warning 'No task matches photocopying, so print requests fall back to '
                  'free text and cannot be filtered by task. Add a task named '
                  '"Photocopying" in the admin console.';
    return;
  end if;

  update public.service_requests sr
     set category_task_id          = v_task.id,
         custom_category           = null,
         category_name_snapshot    = v_task.name,
         category_name_ar_snapshot = coalesce(v_task.name_ar, v_task.name)
   where sr.request_type = 'print'
     and (sr.category_task_id is distinct from v_task.id
       or sr.category_name_snapshot is distinct from v_task.name);

  get diagnostics v_n = row_count;
  raise notice 'Print requests re-filed under "%": %', v_task.name, v_n;
end
$do$;

-- ---------------------------------------------------------------------
-- 5. Finishing a job frees the status
--
--    Only when the request being closed is the one that owned the
--    status. If he is on a break, or with somebody else, nothing moves:
--    writing "available" over a break would put a lie on the board.
--
--    This writes the tables directly rather than calling
--    update_my_status, because that function insists the caller is an
--    administrator - and a colleague cancelling their own request must
--    also release him, without being one.
-- ---------------------------------------------------------------------
create or replace function public.release_status_after_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_cs   public.current_status;
  v_now  timestamptz := now();
  v_hist uuid;
begin
  -- "serving" points at the request through serving_request_id;
  -- "traveling" through next_request_id. Any other status, or a pointer
  -- at some other request, is none of this function's business.
  select * into v_cs
    from public.current_status
   where (status_type = 'serving'   and serving_request_id = p_request_id)
      or (status_type = 'traveling' and next_request_id    = p_request_id)
   limit 1;

  if v_cs.user_id is null then
    return;
  end if;

  update public.status_history
     set actual_end_at = v_now
   where user_id = v_cs.user_id and actual_end_at is null;

  insert into public.status_history (
    user_id, building_id, custom_location, location_name_snapshot,
    location_name_ar_snapshot, task_id, custom_task, task_name_snapshot,
    task_name_ar_snapshot, status_type, request_id, started_at,
    expected_end_at, duration_minutes
  ) values (
    v_cs.user_id, null, null, null, null, null, null, null, null,
    'available', null, v_now, null, null
  )
  returning id into v_hist;

  update public.current_status set
    building_id               = null,
    custom_location           = null,
    location_name_snapshot    = null,
    location_name_ar_snapshot = null,
    task_id                   = null,
    custom_task               = null,
    task_name_snapshot        = null,
    task_name_ar_snapshot     = null,
    status_type               = 'available',
    history_id                = v_hist,
    serving_request_id        = null,
    next_request_id           = case when next_request_id = p_request_id
                                     then null else next_request_id end,
    started_at                = v_now,
    expected_end_at           = null,
    updated_at                = v_now
  where user_id = v_cs.user_id;
end;
$fn$;

revoke all on function public.release_status_after_request(uuid) from public;

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
    -- Before the pointers are cleared, because this reads them: if the
    -- request was the thing in hand, the status goes back to available
    -- instead of leaving the board on a job that is already done.
    perform public.release_status_after_request(p_request_id);

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
-- 6. Grants
--
--    No signature changed, so the existing grants still apply. They are
--    restated because `create or replace` on a function whose owner
--    differs would otherwise leave them to be guessed at.
-- ---------------------------------------------------------------------
revoke all on function public.set_request_status(uuid, text, text) from public;
grant execute on function public.set_request_status(uuid, text, text) to authenticated;

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
