-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-priority-flag.sql
--
--  Run once, after every earlier migration.
--
--  WHAT THIS CHANGES
--  -----------------
--  Haitham could already overwrite the urgency a colleague chose. That
--  settled the queue but lost the disagreement: the request now said
--  "normal" and there was no record that anyone had ever called it very
--  urgent, nor any way for the person who did to find out it had been
--  reconsidered.
--
--  A flag instead. The colleague's own `priority` is never touched - it
--  is their judgement of their own situation and it still orders the
--  queue. Beside it sits Haitham's reading, with an optional sentence
--  saying why, which the requester can see on their own request.
--
--  So a request can now say: "they marked this very urgent; I have
--  flagged it as normal - the lab is not timetabled until Thursday."
--  Both halves survive, and the report can count how often the two
--  disagree, which is the number worth knowing.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. The flag
--
--    All four columns are null on a request nobody has flagged, which is
--    almost all of them. `flagged_priority` null means "no opinion", not
--    "normal" - the difference matters when counting.
-- ---------------------------------------------------------------------
alter table public.service_requests
  add column if not exists flagged_priority text,
  add column if not exists flag_note        text,
  add column if not exists flagged_at       timestamptz,
  add column if not exists flagged_by       uuid references public.profiles (id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.service_requests'::regclass
       and conname  = 'service_requests_flagged_priority_check'
  ) then
    alter table public.service_requests
      add constraint service_requests_flagged_priority_check
      check (flagged_priority is null
             or flagged_priority in ('normal', 'urgent', 'very_urgent', 'life_death'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.service_requests'::regclass
       and conname  = 'service_requests_flag_note_check'
  ) then
    alter table public.service_requests
      add constraint service_requests_flag_note_check
      check (flag_note is null or char_length(flag_note) <= 200);
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Setting and clearing it
--
--    Administrators only. Passing null for the priority removes the flag
--    entirely, which is how Haitham takes back a second opinion rather
--    than leaving a stale one on the record.
-- ---------------------------------------------------------------------
create or replace function public.flag_request_priority(
  p_request_id uuid,
  p_priority   text default null,
  p_note       text default null
)
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row  public.service_requests;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_uid  uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can flag a request' using errcode = '42501';
  end if;

  if p_priority is not null
     and p_priority not in ('normal', 'urgent', 'very_urgent', 'life_death') then
    raise exception 'Unknown priority' using errcode = '22023';
  end if;

  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'Please shorten the message' using errcode = '22023';
  end if;

  select * into v_row from public.service_requests where id = p_request_id for update;
  if v_row.id is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;

  update public.service_requests
     set flagged_priority = p_priority,
         -- A note without a flag would be a message attached to nothing.
         flag_note  = case when p_priority is null then null else v_note end,
         flagged_at = case when p_priority is null then null else now() end,
         flagged_by = case when p_priority is null then null else v_uid end
   where id = p_request_id
  returning * into v_row;

  -- The disagreement belongs in the request's own history, so it is still
  -- there after the flag is cleared.
  insert into public.request_history (request_id, changed_by, old_status, new_status, notes)
  values (
    p_request_id, v_uid, v_row.status, v_row.status,
    case when p_priority is null
         then 'Priority flag removed'
         else 'Flagged as ' || p_priority
              || case when v_note is not null then ' - ' || v_note else '' end
    end
  );

  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 3. The requester's own view
--
--    Whoever holds the token sees the flag and the message. That is the
--    whole point of it: a second opinion nobody is told about is just a
--    private note.
--
--    The public board does NOT carry the flag. A disagreement about how
--    urgent somebody's problem is belongs between the two of them, not
--    on a screen in the corridor.
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
-- 4. Grants
-- ---------------------------------------------------------------------
revoke all on function public.flag_request_priority(uuid, text, text) from public;
grant execute on function public.flag_request_priority(uuid, text, text) to authenticated;

commit;

notify pgrst, 'reload schema';
