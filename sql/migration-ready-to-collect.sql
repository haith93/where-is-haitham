-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-ready-to-collect.sql
--
--  Run once, after migration-end-of-day-notes-and-pages.sql (15).
--  Undo:  sql/rollback-ready-to-collect.sql
--
--  THE PROBLEM THIS SOLVES
--  -----------------------
--  A coordinator sends an exam to be printed. A different teacher is
--  the one who collects it. Today that teacher has no way to find out
--  whether it is ready, so they telephone Haitham, or telephone the
--  coordinator, who telephones Haitham.
--
--  The board cannot answer them. It publishes only pending, accepted
--  and paused requests, so the moment a job is completed it vanishes -
--  and absence is ambiguous. Finished, rejected, still being printed
--  and never submitted all look identical from outside.
--
--  Underneath that are two gaps:
--
--    * `completed` means two different things at once. "I have finished
--      printing it" and "it has left my hands" are separate events, and
--      the gap between them is exactly when the telephone rings.
--
--    * A request is only visible to the device that created it, because
--      that is where its public_token lives. The person who collects
--      the documents is a third party the data model does not know
--      exists.
--
--  WHAT THIS ADDS
--  --------------
--  ready_at             printed, waiting on the counter
--  expected_collectors  who is coming for it; more than one is normal,
--                       because two teachers may share a class across
--                       sections
--  request_collections  one row per person who actually took something,
--                       so "who collected them" has a real answer and
--                       two part-collections do not overwrite each other
--
--  The board gains a "Ready to collect" list carrying names and request
--  numbers only. No document title is published: a finished exam named
--  on a public board, with the place to collect it beside it, is a
--  different proposition from a queue entry.
--
--  WHAT IT DOES NOT CHANGE
--  -----------------------
--  No status value is added. ready_at is a column, so every existing
--  filter, report and policy keeps working untouched. A request is
--  "ready" when ready_at is set and completed_at is not.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Stop if migration 15 has not been applied
-- ---------------------------------------------------------------------
do $do$
begin
  if to_regprocedure('public.annotate_request(uuid, text, text)') is null then
    raise exception
      'Run sql/migration-end-of-day-notes-and-pages.sql first (number 15).'
      using errcode = '42883';
  end if;
end
$do$;

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table public.service_requests
  add column if not exists ready_at timestamptz;

alter table public.service_requests
  add column if not exists expected_collectors text[];

do $do$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.service_requests'::regclass
       and conname  = 'service_requests_collectors_check')
  then
    alter table public.service_requests
      add constraint service_requests_collectors_check
      check (expected_collectors is null
             or (array_length(expected_collectors, 1) <= 6
                 and array_length(expected_collectors, 1) >= 1));
  end if;
end
$do$;

create index if not exists sr_ready_idx
  on public.service_requests (ready_at)
  where ready_at is not null and completed_at is null;

-- ---------------------------------------------------------------------
-- 2. Who actually took it
--
--    A table rather than a column, because two teachers collecting for
--    two sections is the case that prompted this, and a single
--    collected_by would record the first and silently lose the second.
-- ---------------------------------------------------------------------
create table if not exists public.request_collections (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null
                 references public.service_requests (id) on delete cascade,

  collector_name text not null
                 check (char_length(trim(collector_name)) between 1 and 120),

  -- What they took, when a request is split between two people. Free
  -- text: the useful answer is "the grade 7 copies", not an id.
  note           text check (note is null or char_length(note) <= 200),

  collected_at   timestamptz not null default now(),
  recorded_by    uuid references public.profiles (id) on delete set null
);

create index if not exists rc_request_idx
  on public.request_collections (request_id);

alter table public.request_collections enable row level security;

drop policy if exists rc_admin on public.request_collections;

-- Administrators only. The board learns what it needs through the
-- public snapshot, which is built by a SECURITY DEFINER function and
-- publishes names, never documents.
create policy rc_admin on public.request_collections
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

revoke all on public.request_collections from anon;
revoke insert, update, delete on public.request_collections from authenticated;
grant select on public.request_collections to authenticated;

-- ---------------------------------------------------------------------
-- 3. Printed, and waiting on the counter
-- ---------------------------------------------------------------------
create or replace function public.mark_request_ready(
  p_request_id uuid,
  p_collectors text[] default null
)
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_row public.service_requests;
  v_who text[];
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can mark a request ready' using errcode = '42501';
  end if;

  -- Blank names are dropped rather than stored: an empty chip on the
  -- board is worse than no chip.
  if p_collectors is not null then
    select array_agg(x) into v_who
      from (select distinct nullif(trim(unnest), '') as x
              from unnest(p_collectors) as unnest) t
     where x is not null;
  end if;

  update public.service_requests
     set ready_at = coalesce(ready_at, now()),
         expected_collectors = coalesce(v_who, expected_collectors)
   where id = p_request_id
     and status not in ('cancelled', 'rejected')
  returning * into v_row;

  if not found then
    raise exception 'Request not found, or already closed' using errcode = 'P0002';
  end if;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (p_request_id, v_uid, v_row.status, v_row.status,
          'Printed and ready to collect'
          || case when v_row.expected_collectors is null then ''
                  else ' (' || array_to_string(v_row.expected_collectors, ', ') || ')' end);

  if v_row.requester_id is not null then
    insert into public.notifications (user_id, request_id, title, message, type)
    values (v_row.requester_id, v_row.id, 'Ready to collect',
            v_row.request_number || ' is printed and waiting at '
            || coalesce(v_row.location_name_snapshot, 'the photocopy centre'),
            'request_update');
  end if;

  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 4. Somebody came and took it
--
--    Completes the request only when nobody expected is still to come.
--    Two teachers sharing a class across sections collect separately,
--    and the first one arriving must not close the job on the second.
-- ---------------------------------------------------------------------
create or replace function public.record_collection(
  p_request_id uuid,
  p_collector  text,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid       uuid := auth.uid();
  v_name      text := nullif(trim(coalesce(p_collector, '')), '');
  v_note      text := nullif(trim(coalesce(p_note, '')), '');
  v_row       public.service_requests;
  v_taken     text[];
  v_waiting   text[];
  v_complete  boolean := false;
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can record a collection' using errcode = '42501';
  end if;
  if v_name is null or char_length(v_name) > 120 then
    raise exception 'Please say who collected it' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'Please shorten the note' using errcode = '22023';
  end if;

  select * into v_row from public.service_requests where id = p_request_id for update;
  if not found then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;

  insert into public.request_collections (request_id, collector_name, note, recorded_by)
  values (p_request_id, v_name, v_note, v_uid);

  -- Everyone who has taken something so far.
  select array_agg(distinct lower(collector_name)) into v_taken
    from public.request_collections where request_id = p_request_id;

  -- Of the people expected, who has not been yet.
  if v_row.expected_collectors is null
     or array_length(v_row.expected_collectors, 1) is null then
    v_complete := true;                  -- nobody named, so one is enough
  else
    select array_agg(e) into v_waiting
      from unnest(v_row.expected_collectors) as e
     where lower(e) <> all (coalesce(v_taken, array[]::text[]));
    v_complete := v_waiting is null or array_length(v_waiting, 1) is null;
  end if;

  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (p_request_id, v_uid, v_row.status, v_row.status,
          'Collected by ' || v_name || coalesce(' - ' || v_note, ''));

  if v_complete and v_row.status not in ('completed', 'cancelled', 'rejected') then
    perform public.set_request_status(p_request_id, 'completed', 'Collected by ' || v_name);
  end if;

  return jsonb_build_object(
    'completed', v_complete,
    'waiting_for', coalesce(v_waiting, array[]::text[])
  );
end;
$fn$;

-- ---------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------
revoke all on function public.mark_request_ready(uuid, text[]) from public;
grant execute on function public.mark_request_ready(uuid, text[]) to authenticated;

revoke all on function public.record_collection(uuid, text, text) from public;
grant execute on function public.record_collection(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. The public print form can name who collects
--
--    A new argument means a new signature, so the old one goes rather
--    than sitting beside it as a second overload PostgREST might pick.
-- ---------------------------------------------------------------------
drop function if exists public.create_print_request(
  text, jsonb, text, text, uuid, text, text);
create or replace function public.create_print_request(
  p_requester_name   text,
  p_files            jsonb,
  p_title            text default null,
  p_priority         text default 'normal',
  p_building_id      uuid default null,
  p_custom_location  text default null,
  p_device_id        text default null,
  -- Who will come for it. The coordinator sending an exam usually knows
  -- which teacher collects, and more than one is normal when a class is
  -- split across sections.
  p_collectors       text[] default null
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
  v_pages   integer;
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
  v_who     text[];
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

  if p_collectors is not null then
    select array_agg(x) into v_who
      from (select distinct nullif(trim(unnest), '') as x
              from unnest(p_collectors) as unnest) t
     where x is not null;
    if array_length(v_who, 1) > 6 then
      raise exception 'Please name at most 6 people' using errcode = '22023';
    end if;
  end if;

  insert into public.service_requests (
    request_number, requester_id, requester_name_snapshot,
    location_building_id, custom_location, location_name_snapshot,
    location_name_ar_snapshot,
    category_task_id, custom_category, category_name_snapshot,
    category_name_ar_snapshot,
    description, priority, status, channel, request_type, queue_position,
    expected_collectors
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
               where status in ('pending', 'accepted')), 0) + 1,
    v_who
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

    -- How many sheets a copy costs depends on this, so it is worth
    -- asking for. Optional: a document handed over on paper may not
    -- have been counted yet.
    v_pages := nullif(v_file ->> 'pages', '')::integer;
    if v_pages is not null and (v_pages < 1 or v_pages > 2000) then
      raise exception 'Pages must be between 1 and 2000' using errcode = '22023';
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
      paper_size, color_mode, color_permission, print_sides, copies, pages,
      grade_id, section_snapshot, level_snapshot, grade_snapshot, note
    ) values (
      v_row.id, v_pos, v_ftitle, v_deliv, 'supabase', v_upload.storage_path,
      v_upload.original_filename, v_upload.mime_type, v_upload.file_size,
      v_paper, v_colour,
      case when v_colour = 'color' then v_perm end,
      v_sides, v_copies, v_pages,
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
-- 7. The board publishes what is waiting to be collected
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
        'request_type',   sr.request_type,
        'print_title',    (select max(pj.title) from public.print_jobs pj where pj.request_id = sr.id),
        'print_files',    (select count(*) from public.print_jobs pj where pj.request_id = sr.id),
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
        'priority',       sr.priority,
        'request_type',   sr.request_type,
        'print_title',    (select max(pj.title) from public.print_jobs pj where pj.request_id = sr.id),
        'print_files',    (select count(*) from public.print_jobs pj where pj.request_id = sr.id)
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
               sr.status,
               sr.request_type,
               (select max(pj.title) from public.print_jobs pj where pj.request_id = sr.id) as print_title,
               (select count(*) from public.print_jobs pj where pj.request_id = sr.id) as print_files
        from public.service_requests sr
        where sr.status in ('pending', 'accepted', 'paused')
      ) q
    ),
    -- Printed and waiting on the counter. Names and numbers only: no
    -- document title is published here. A finished exam named on a
    -- public board, with the place to collect it printed beside it, is
    -- a different proposition from a queue entry.
    'ready', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'request_number', sr.request_number,
               'requester',      sr.requester_name_snapshot,
               'location',       sr.location_name_snapshot,
               'location_ar',    coalesce(sr.location_name_ar_snapshot, sr.location_name_snapshot),
               'documents',      (select count(*) from public.print_jobs pj
                                   where pj.request_id = sr.id),
               'ready_at',       sr.ready_at,
               'collectors',     to_jsonb(coalesce(sr.expected_collectors, array[]::text[])),
               'collected',      (select coalesce(jsonb_agg(jsonb_build_object(
                                             'name', rc.collector_name,
                                             'at',   rc.collected_at)
                                           order by rc.collected_at), '[]'::jsonb)
                                    from public.request_collections rc
                                   where rc.request_id = sr.id)
             ) order by sr.ready_at), '[]'::jsonb)
      from public.service_requests sr
      where sr.ready_at is not null
        and sr.completed_at is null
        and sr.status not in ('cancelled', 'rejected')
    ),
    'counts', (
      select jsonb_build_object(
        'ready',       count(*) filter (where ready_at is not null and completed_at is null
                                          and status not in ('cancelled','rejected')),
        'waiting',     count(*) filter (where status in ('pending','accepted','paused')),
        'pending',     count(*) filter (where status = 'pending'),
        'paused',      count(*) filter (where status = 'paused'),
        'in_progress', count(*) filter (where status = 'in_progress'),
        'printing',    count(*) filter (where status in ('pending','accepted','paused')
                                          and request_type = 'print'),
        'urgent',      count(*) filter (where status in ('pending','accepted','paused') and priority = 'urgent'),
        'very_urgent', count(*) filter (where status in ('pending','accepted','paused') and priority = 'very_urgent'),
        'life_death',  count(*) filter (where status in ('pending','accepted','paused') and priority = 'life_death')
      )
      from public.service_requests
    )
  );
$fn$;

-- ---------------------------------------------------------------------
-- 8. Grants
--
--    create_print_request gains an argument, so the seven-argument form
--    is dropped first. Nothing calls it positionally from inside the
--    database, and PostgREST matches by name - an old client that omits
--    p_collectors still resolves, because it defaults.
-- ---------------------------------------------------------------------
revoke all on function public.create_print_request(
  text, jsonb, text, text, uuid, text, text, text[]) from public;
grant execute on function public.create_print_request(
  text, jsonb, text, text, uuid, text, text, text[]) to anon, authenticated;

revoke all on function public.build_public_snapshot() from public;
grant execute on function public.build_public_snapshot() to anon, authenticated;

commit;

notify pgrst, 'reload schema';
