-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-print-offline-delivery.sql
--
--  Run once, after migration-print-per-file-colour.sql.
--  Undo:  sql/rollback-print-offline-delivery.sql
--
--  WHAT THIS IS FOR
--  ----------------
--  While the school is still getting used to the site, most print jobs
--  will not arrive through it. Somebody hands over a sheet of paper in
--  the corridor, or sends a file on WhatsApp, or drops it in the shared
--  folder, or the thing is simply too large to upload. Haitham still has
--  to print it, and it still has to appear in the queue and the monthly
--  report, otherwise the report describes the half of his work that
--  happened to arrive the convenient way.
--
--  So a print job records HOW THE DOCUMENT REACHED HIM, and a job whose
--  document did not arrive as an upload simply has no file attached.
--
--  WHY NOT REUSE `channel`
--  -----------------------
--  service_requests.channel already says how the REQUEST arrived. That is
--  a different fact and the two genuinely diverge: a teacher phones to
--  ask, then emails the file. The request's channel is 'phone'; the
--  document's delivery is 'email'. Collapsing them would lose one of
--  them, and it is the document's route that decides whether there is a
--  file to open.
--
--  WHY ONE CHOICE RATHER THAN CHECKBOXES
--  -------------------------------------
--  A document arrives one way. Ticking both "by hand" and "email" would
--  describe two documents, not one, and nothing downstream could act on
--  the pair. The form asks once and takes a single answer.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. How the document arrived
-- ---------------------------------------------------------------------
alter table public.print_jobs
  add column if not exists delivery text not null default 'upload';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.print_jobs'::regclass
       and conname  = 'print_jobs_delivery_check'
  ) then
    alter table public.print_jobs
      add constraint print_jobs_delivery_check
      check (delivery in ('upload', 'hand', 'whatsapp', 'email', 'shared_folder', 'other'));
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. The storage columns become optional
--
--    They were NOT NULL because every print job had a file. Now a job
--    delivered by hand has nothing to point at. The constraint below
--    keeps the pairing honest in both directions: an upload must have a
--    file, and anything else must not pretend to.
-- ---------------------------------------------------------------------
alter table public.print_jobs
  alter column storage_path      drop not null,
  alter column original_filename drop not null,
  alter column mime_type         drop not null,
  alter column file_size         drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.print_jobs'::regclass
       and conname  = 'print_jobs_file_matches_delivery'
  ) then
    alter table public.print_jobs
      add constraint print_jobs_file_matches_delivery
      check (
        (delivery = 'upload'  and storage_path is not null and original_filename is not null)
        or
        -- No file, and therefore a title: something has to say what is
        -- being printed, or the queue card is blank and the report is
        -- a row of settings attached to nothing.
        (delivery <> 'upload' and storage_path is null and title is not null)
      );
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Recording a print request on someone's behalf
--
--    The administrator's counterpart to create_print_request. Same shape,
--    same per-document settings, but every document may say how it
--    arrived - and only an 'upload' carries an upload_id.
--
--    p_files entries:
--      { "upload_id": uuid|null, "delivery": text, "title": text|null,
--        "copies": int, "paper_size": text, "print_sides": text,
--        "color_mode": text, "color_permission": bool|null,
--        "grade_id": uuid|null, "note": text|null }
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
      coalesce(p_duration_minutes, 15),
      v_row.id          -- ties the status to this request, so the board
    );                  -- can name who he is with
  end if;

  return jsonb_build_object(
    'request_number', v_row.request_number,
    'files',          v_count,
    'status',         v_row.status
  );
end;
$fn$;

-- ---------------------------------------------------------------------
-- 4. Reading it back
--
--    Both readers gain `delivery`, so a screen can tell the difference
--    between "open the file" and "it is the paper on the desk".
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
-- 5. Grants
-- ---------------------------------------------------------------------
revoke all on function public.admin_create_print_request(
  text, jsonb, text, text, text, text, uuid, text, boolean, integer) from public;

grant execute on function public.admin_create_print_request(
  text, jsonb, text, text, text, text, uuid, text, boolean, integer) to authenticated;

commit;

notify pgrst, 'reload schema';
