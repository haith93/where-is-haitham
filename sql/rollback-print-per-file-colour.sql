-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  rollback-print-per-file-colour.sql
--
--  Undoes sql/migration-print-per-file-colour.sql.
--
--  Puts create_print_request back to taking colour, permission and the
--  note once for the whole request, which is what the code before that
--  migration sends.
--
--  Nothing is lost by running this. print_jobs already stored all three
--  per row and still will; only new requests go back to writing the same
--  value on every document. Requests that were created while the feature
--  was live keep whatever they were given, per document, and every screen
--  that reads them already reads them per document.
--
--  Run this BEFORE checking the code back, while the two still agree.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. The function, as it was
-- ---------------------------------------------------------------------
drop function if exists public.create_print_request(
  text, jsonb, text, text, uuid, text, text);

create or replace function public.create_print_request(
  p_requester_name   text,
  p_files            jsonb,
  p_title            text    default null,
  p_color_mode       text    default 'bw',
  p_color_permission boolean default null,
  p_note             text    default null,
  p_priority         text    default 'normal',
  p_building_id      uuid    default null,
  p_custom_location  text    default null,
  p_device_id        text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_name    text := nullif(trim(coalesce(p_requester_name, '')), '');
  v_title   text := nullif(trim(coalesce(p_title, '')), '');
  v_note    text := nullif(trim(coalesce(p_note, '')), '');
  v_count   integer;
  v_file    jsonb;
  v_upload  public.print_uploads;
  v_grade   public.school_grades;
  v_copies  integer;
  v_paper   text;
  v_sides   text;
  v_loc     text;
  v_task_id uuid;
  v_cat     text;
  v_row     public.service_requests;
  v_admin   record;
  v_recent  integer;
  v_pos     integer := 0;
  v_first   text;
begin
  ------------------------------------------------------------------
  -- Who
  ------------------------------------------------------------------
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

  ------------------------------------------------------------------
  -- How urgent, and therefore how many documents are allowed
  ------------------------------------------------------------------
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

  if p_priority <> 'normal' and v_count > 1 then
    raise exception 'An urgent request can carry only one document'
      using errcode = '22023';
  end if;

  if v_count > 10 then
    raise exception 'Please send at most 10 documents in one request'
      using errcode = '22023';
  end if;

  ------------------------------------------------------------------
  -- Colour: one answer for the whole request
  ------------------------------------------------------------------
  if p_color_mode not in ('bw', 'color') then
    raise exception 'Unknown colour mode' using errcode = '22023';
  end if;
  if p_color_mode = 'color' and coalesce(p_color_permission, false) is not true then
    raise exception 'Colour printing needs permission' using errcode = '42501';
  end if;
  if v_note is not null and char_length(v_note) > 100 then
    raise exception 'The note is limited to 100 characters' using errcode = '22023';
  end if;
  if v_title is not null and char_length(v_title) > 120 then
    raise exception 'Please shorten the title' using errcode = '22023';
  end if;

  ------------------------------------------------------------------
  -- Where it is collected. The form does not ask; see the comment in
  -- migration-print-requests.sql.
  ------------------------------------------------------------------
  if p_building_id is not null then
    select name into v_loc from public.buildings where id = p_building_id and active;
    if v_loc is null then
      raise exception 'Unknown building' using errcode = '22023';
    end if;
  else
    v_loc := nullif(trim(coalesce(p_custom_location, '')), '');
  end if;

  if v_loc is null then
    select id, name into p_building_id, v_loc
      from public.buildings
     where active and (lower(name) like '%photocop%'
                    or lower(name) like '%print%'
                    or lower(name) like '%copy%')
     order by display_order
     limit 1;
  end if;

  if v_loc is null then
    v_loc := 'Photocopy Centre';
  end if;

  select id, name into v_task_id, v_cat
    from public.tasks
   where active and (lower(name) like '%photocop%' or lower(name) like '%print%')
   order by display_order
   limit 1;
  if v_cat is null then
    v_cat := 'Printing';
  end if;

  ------------------------------------------------------------------
  -- The request
  ------------------------------------------------------------------
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
  -- Each document, with its own settings
  ------------------------------------------------------------------
  for v_file in select * from jsonb_array_elements(p_files)
  loop
    v_pos := v_pos + 1;

    select * into v_upload
      from public.print_uploads
     where id = (v_file ->> 'upload_id')::uuid
       and consumed_at is null
     for update;

    if v_upload.id is null then
      raise exception 'A document was not uploaded, or has already been used'
        using errcode = 'P0002';
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
      request_id, position, title, storage_provider, storage_path,
      original_filename, mime_type, file_size,
      paper_size, color_mode, color_permission, print_sides, copies,
      grade_id, section_snapshot, level_snapshot, grade_snapshot, note
    ) values (
      v_row.id, v_pos,
      -- The title belongs to the request, and is repeated on each row so
      -- a single job read on its own still says what it is.
      v_title, 'supabase', v_upload.storage_path,
      v_upload.original_filename, v_upload.mime_type, v_upload.file_size,
      v_paper, p_color_mode,
      case when p_color_mode = 'color' then p_color_permission end,
      v_sides, v_copies,
      v_grade.id, v_grade.section, v_grade.level_name, v_grade.grade_name_ar,
      v_note
    );

    update public.print_uploads set consumed_at = now() where id = v_upload.id;

    if v_pos = 1 then
      v_first := v_upload.original_filename;
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
-- 2. Grants, as they were
-- ---------------------------------------------------------------------
revoke all on function public.create_print_request(
  text, jsonb, text, text, boolean, text, text, uuid, text, text) from public;

grant execute on function public.create_print_request(
  text, jsonb, text, text, boolean, text, text, uuid, text, text) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
