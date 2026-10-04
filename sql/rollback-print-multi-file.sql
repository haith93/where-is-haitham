-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  rollback-print-multi-file.sql
--
--  Undoes sql/migration-print-multi-file.sql.
--
--  WHEN TO RUN THIS
--  ----------------
--  Only if the multi-file feature is being abandoned and the branch that
--  carried it is being deleted. Git takes the code back; it cannot take
--  the database back, and a database running the new functions against
--  the old code is the one state in which this application misbehaves
--  quietly rather than loudly.
--
--  WHAT IT DOES
--  ------------
--  Restores every function this feature replaced to the definition it
--  had before, and puts request_id back as the primary key of print_jobs.
--
--  WHAT IT CANNOT DO
--  -----------------
--  If any request was submitted with more than one document while the
--  feature was live, those rows cannot all survive: the old shape allows
--  exactly one job per request. This script REFUSES to run in that case
--  rather than silently deleting somebody's print job. If you mean to
--  discard them, the message tells you the one statement that does it.
--
--  The id and position columns are left in place. They are harmless, the
--  old code never looks at them, and dropping a column is the one step
--  here that could not itself be undone.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Refuse to destroy data
-- ---------------------------------------------------------------------
do $$
declare
  v_extra integer;
begin
  select count(*) into v_extra
    from (
      select request_id
        from public.print_jobs
       group by request_id
      having count(*) > 1
    ) multi;

  if v_extra > 0 then
    raise exception
      'Refusing to roll back: % request(s) carry more than one document. '
      'Review them first. To discard the extras and keep only the first of '
      'each, run: delete from public.print_jobs pj where exists (select 1 '
      'from public.print_jobs o where o.request_id = pj.request_id and '
      'o.position < pj.position);',
      v_extra;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. print_jobs: one document per request again
-- ---------------------------------------------------------------------
do $$
declare
  v_pk text;
begin
  select con.conname into v_pk
    from pg_constraint con
   where con.conrelid = 'public.print_jobs'::regclass
     and con.contype = 'p';

  if v_pk is not null and v_pk = 'print_jobs_pkey_id' then
    alter table public.print_jobs drop constraint print_jobs_pkey_id;
    alter table public.print_jobs add constraint print_jobs_pkey primary key (request_id);
  end if;
end;
$$;

drop index if exists public.print_jobs_request_idx;

-- ---------------------------------------------------------------------
-- 2. The functions, as they were
-- ---------------------------------------------------------------------
drop function if exists public.create_print_request(
  text, jsonb, text, text, boolean, text, text, uuid, text, text);
drop function if exists public.admin_print_jobs(uuid);

create or replace function public.create_print_request(
  p_requester_name   text,
  p_upload_id        uuid,
  p_building_id      uuid    default null,
  p_custom_location  text    default null,
  p_title            text    default null,
  p_paper_size       text    default 'A4',
  p_color_mode       text    default 'bw',
  p_color_permission boolean default null,
  p_print_sides      text    default 'single',
  p_copies           integer default 1,
  p_grade_id         uuid    default null,
  p_note             text    default null,
  p_priority         text    default 'normal',
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
  v_upload  public.print_uploads;
  v_grade   public.school_grades;
  v_loc     text;
  v_task_id uuid;
  v_cat     text;
  v_row     public.service_requests;
  v_admin   record;
  v_recent  integer;
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

  select * into v_upload
    from public.print_uploads
   where id = p_upload_id and consumed_at is null
   for update;

  if v_upload.id is null then
    raise exception 'The document was not uploaded, or has already been used'
      using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.paper_sizes where code = p_paper_size and active) then
    raise exception 'Unknown paper size' using errcode = '22023';
  end if;
  if p_color_mode not in ('bw', 'color') then
    raise exception 'Unknown colour mode' using errcode = '22023';
  end if;
  if p_color_mode = 'color' and coalesce(p_color_permission, false) is not true then
    raise exception 'Colour printing needs permission' using errcode = '42501';
  end if;
  if p_print_sides not in ('single', 'double') then
    raise exception 'Unknown sides option' using errcode = '22023';
  end if;
  if p_copies is null or p_copies < 1 or p_copies > 500 then
    raise exception 'Copies must be between 1 and 500' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 100 then
    raise exception 'The note is limited to 100 characters' using errcode = '22023';
  end if;
  if v_title is not null and char_length(v_title) > 120 then
    raise exception 'Please shorten the title' using errcode = '22023';
  end if;
  if p_priority not in ('normal', 'urgent', 'very_urgent', 'life_death') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;

  if p_grade_id is not null then
    select * into v_grade from public.school_grades where id = p_grade_id and active;
    if v_grade.id is null then
      raise exception 'Unknown class' using errcode = '22023';
    end if;
  end if;

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

  insert into public.print_jobs (
    request_id, title, storage_provider, storage_path,
    original_filename, mime_type, file_size,
    paper_size, color_mode, color_permission, print_sides, copies,
    grade_id, section_snapshot, level_snapshot, grade_snapshot, note
  ) values (
    v_row.id, v_title, 'supabase', v_upload.storage_path,
    v_upload.original_filename, v_upload.mime_type, v_upload.file_size,
    p_paper_size, p_color_mode,
    case when p_color_mode = 'color' then p_color_permission end,
    p_print_sides, p_copies,
    p_grade_id, v_grade.section, v_grade.level_name, v_grade.grade_name_ar,
    v_note
  );

  update public.print_uploads set consumed_at = now() where id = v_upload.id;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (v_row.id, null, null, 'pending', 'Print request created');

  for v_admin in select id from public.profiles where role = 'admin' and active loop
    insert into public.notifications (user_id, request_id, title, message, type)
    values (
      v_admin.id, v_row.id,
      case v_row.priority
        when 'life_death'  then 'LIFE & DEATH print job'
        when 'very_urgent' then 'VERY URGENT print job'
        when 'urgent'      then 'Urgent print job'
        else 'New print job' end,
      v_name || ' - ' || coalesce(v_title, v_upload.original_filename)
             || ' - ' || p_copies || ' copies',
      'new_request'
    );
  end loop;

  return jsonb_build_object(
    'request_number', v_row.request_number,
    'public_token',   v_row.public_token,
    'people_ahead',   (select count(*) from public.service_requests q
                        where q.status in ('pending', 'accepted', 'paused')
                          and q.created_at < v_row.created_at)
  );
end;
$fn$;

create or replace function public.admin_print_job(p_request_id uuid)
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

  select jsonb_build_object(
    'request_id',        pj.request_id,
    'title',             pj.title,
    'original_filename', pj.original_filename,
    'storage_provider',  pj.storage_provider,
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
    'note',              pj.note,
    'created_at',        pj.created_at
  ) into v
  from public.print_jobs pj
  where pj.request_id = p_request_id;

  return v;
end;
$fn$;

create or replace function public.print_job_public(p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'title',  pj.title,
    'copies', pj.copies
  )
  from public.print_jobs pj
  where pj.request_id = p_request_id;
$fn$;

-- get_request_by_token, back to the single-document shape (with the
-- priority flag, which this feature did not touch).
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
    'print',          (
      select jsonb_build_object(
        'title',             pj.title,
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
      )
      from public.print_jobs pj where pj.request_id = sr.id
    )
  )
  from public.service_requests sr
  where sr.public_token = p_token;
$fn$;

-- ---------------------------------------------------------------------
-- 3. Grants, as they were
-- ---------------------------------------------------------------------
revoke all on function public.create_print_request(
  text, uuid, uuid, text, text, text, text, boolean, text, integer, uuid, text, text, text) from public;
revoke all on function public.admin_print_job(uuid) from public;
revoke all on function public.print_job_public(uuid) from public;

grant execute on function public.create_print_request(
  text, uuid, uuid, text, text, text, text, boolean, text, integer, uuid, text, text, text) to anon, authenticated;
grant execute on function public.print_job_public(uuid) to anon, authenticated;
grant execute on function public.admin_print_job(uuid)  to authenticated;

update public.public_board
   set snapshot = public.build_public_snapshot(), updated_at = now()
 where id = 1;

commit;

notify pgrst, 'reload schema';
