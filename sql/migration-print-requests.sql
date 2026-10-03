-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-print-requests.sql
--
--  Run once, after every earlier migration.
--
--  Adds a second kind of request: "print this for me", with a file
--  attached. The existing help request is untouched - it simply becomes
--  request_type = 'help', which is the column default, so every row that
--  already exists keeps behaving exactly as it did.
--
--  THE PRIVACY RULE THIS FILE ENFORCES
--  -----------------------------------
--  The document itself must never reach another colleague. That is not a
--  UI concern, so it is not solved in the UI:
--
--    * the file lives in a PRIVATE Supabase Storage bucket. No policy on
--      storage.objects grants anon or authenticated anything, so there is
--      no path by which a browser can read it directly - signed URLs are
--      minted server-side by an Edge Function holding the service role.
--    * the storage path, the original filename and the MIME type live in
--      print_jobs, which anon cannot select from at all.
--    * build_public_snapshot - the ONLY thing an anonymous visitor reads -
--      emits a sentence and nothing else: "printing <title> for <name>".
--      No filename, no path, no size. A colleague reading the raw JSON of
--      the public board learns nothing the board does not already show.
--
--  WHY A CHILD TABLE RATHER THAN MORE COLUMNS
--  ------------------------------------------
--  Eighteen print-only columns on service_requests would be null on every
--  help request forever, and would put the filename inside the row that
--  several existing policies and functions already return. Keeping them
--  in print_jobs means the sensitive columns are somewhere anon has no
--  reach, and the existing queue, statuses, history, notifications and
--  board keep working without knowing print requests exist.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. The school structure
--
--    Seeded from the school's own spreadsheet, verbatim - including the
--    rows where a support ("مساند") grade sits under a different section
--    than its neighbours, which is how the sheet has it. This is data,
--    not code: next year's structure is an edit here, not a release.
--
--    Three levels deep, because that is all the sheet contains. There is
--    no class (A/B/C) anywhere in it, so none is invented here.
-- ---------------------------------------------------------------------
create table if not exists public.school_grades (
  id             uuid primary key default gen_random_uuid(),
  display_order  integer not null default 0,

  section        text not null,          -- Kindergarten | EE | LS | MSE
  section_ar     text not null,
  level_name     text not null,          -- Kindergarten | Cycle One | ...
  level_name_ar  text not null,
  grade_name     text not null,
  grade_name_ar  text not null unique,   -- the sheet's own "grade level"

  combined_key   text,                   -- the sheet's "combined classes"
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

create index if not exists school_grades_pick_idx
  on public.school_grades (active, section, level_name, display_order);

insert into public.school_grades
  (display_order, section, section_ar, level_name, level_name_ar, grade_name, grade_name_ar, combined_key)
values
  (10, 'Kindergarten', 'الروضات', 'Kindergarten', 'الروضات', 'KG1', 'KG1', 'kg1'),
  (20, 'Kindergarten', 'الروضات', 'Kindergarten', 'الروضات', 'KG2', 'KG2', 'kg2'),
  (30, 'Kindergarten', 'الروضات', 'Kindergarten', 'الروضات', 'KG2 (Support)', 'KG2 LS', null),
  (40, 'Kindergarten', 'الروضات', 'Kindergarten', 'الروضات', 'KG3', 'KG3', 'kg3'),
  (50, 'Kindergarten', 'الروضات', 'Kindergarten', 'الروضات', 'KG3 (Support)', 'KG3 LS', null),
  (60, 'EE', 'التعليم الأساسي', 'Cycle One', 'الحلقة الأولى', 'Grade 1', 'الأوّل', 'grade 1'),
  (70, 'LS', 'التعليم المساند', 'Cycle One', 'الحلقة الأولى', 'Grade 1 (Support)', 'الأوّل مساند', null),
  (80, 'EE', 'التعليم الأساسي', 'Cycle One', 'الحلقة الأولى', 'Grade 2', 'الثّاني', 'grade 2'),
  (90, 'LS', 'التعليم المساند', 'Cycle One', 'الحلقة الأولى', 'Grade 2 (Support)', 'الثّاني مساند', null),
  (100, 'EE', 'التعليم الأساسي', 'Cycle One', 'الحلقة الأولى', 'Grade 3', 'الثّالث', 'grade 3'),
  (110, 'LS', 'التعليم المساند', 'Cycle One', 'الحلقة الأولى', 'Grade 3 (Support)', 'الثّالث مساند', null),
  (120, 'EE', 'التعليم الأساسي', 'Cycle Two', 'الحلقة الثانية', 'Grade 4', 'الرّابع', 'grade 4'),
  (130, 'LS', 'التعليم المساند', 'Cycle Two', 'الحلقة الثانية', 'Grade 4 (Support)', 'الرّابع مساند', null),
  (140, 'EE', 'التعليم الأساسي', 'Cycle Two', 'الحلقة الثانية', 'Grade 5', 'الخامس', 'grade 5'),
  (150, 'LS', 'التعليم المساند', 'Cycle Two', 'الحلقة الثانية', 'Grade 5 (Support)', 'الخامس مساند', null),
  (160, 'EE', 'التعليم الأساسي', 'Cycle Two', 'الحلقة الثانية', 'Grade 6', 'السّادس', 'grade 6'),
  (170, 'LS', 'التعليم المساند', 'Cycle Two', 'الحلقة الثانية', 'Grade 6 (Support)', 'السّادس مساند', null),
  (180, 'MSE', 'المتوسّط والثانوي', 'Cycle Three', 'الحلقة الثالثة', 'Grade 7', 'السّابع', 'grade 7'),
  (190, 'LS', 'التعليم المساند', 'Cycle Three', 'الحلقة الثالثة', 'Grade 7 (Support)', 'السّابع مساند', null),
  (200, 'MSE', 'المتوسّط والثانوي', 'Cycle Three', 'الحلقة الثالثة', 'Grade 8', 'الثّامن', 'grade 8'),
  (210, 'LS', 'التعليم المساند', 'Cycle Three', 'الحلقة الثالثة', 'Grade 8 (Support)', 'الثّامن مساند', null),
  (220, 'MSE', 'المتوسّط والثانوي', 'Cycle Three', 'الحلقة الثالثة', 'Grade 9', 'التّاسع', 'grade 9'),
  (230, 'LS', 'التعليم المساند', 'Cycle Three', 'الحلقة الثالثة', 'Grade 9 (Support)', 'التّاسع مساند', null),
  (240, 'MSE', 'المتوسّط والثانوي', 'High School', 'المرحلة الثانوية', 'Grade 10', 'العاشر', 'grade 10'),
  (250, 'MSE', 'المتوسّط والثانوي', 'High School', 'المرحلة الثانوية', 'Grade 10 (Support)', 'العاشر مساند', null),
  (260, 'MSE', 'المتوسّط والثانوي', 'High School', 'المرحلة الثانوية', 'Grade 11', 'الحادي عشر', 'grade 11'),
  (270, 'MSE', 'المتوسّط والثانوي', 'High School', 'المرحلة الثانوية', 'Grade 11 (Support)', 'الحادي عشر مساند', null),
  (280, 'MSE', 'المتوسّط والثانوي', 'High School', 'المرحلة الثانوية', 'Grade 12 — Life Sciences', 'الثاني عشر علوم الحياة', 'grade 12'),
  (290, 'MSE', 'المتوسّط والثانوي', 'High School', 'المرحلة الثانوية', 'Grade 12 — Sociology & Economics', 'الثاني عشر اجتماع واقتصاد', null),
  (300, 'MSE', 'المتوسّط والثانوي', 'High School', 'المرحلة الثانوية', 'Grade 12 — Sociology & Economics (Support)', 'الثاني عشر اجتماع واقتصاد مساند', null),
  (310, 'MSE', 'المتوسّط والثانوي', 'High School', 'المرحلة الثانوية', 'Grade 12 — General Sciences', 'الثاني عشر علوم عامة', null)
on conflict (grade_name_ar) do nothing;


-- ---------------------------------------------------------------------
-- 2. The request type
--
--    Defaulting to 'help' is what makes this migration safe to run on a
--    live table: every existing row becomes a help request, which is
--    what it already was.
-- ---------------------------------------------------------------------
alter table public.service_requests
  add column if not exists request_type text not null default 'help';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.service_requests'::regclass
       and conname  = 'service_requests_request_type_check'
  ) then
    alter table public.service_requests
      add constraint service_requests_request_type_check
      check (request_type in ('help', 'print'));
  end if;
end;
$$;

create index if not exists sr_type_idx on public.service_requests (request_type, created_at desc);

-- ---------------------------------------------------------------------
-- 3. Uploads in flight
--
--    A file is stored BEFORE its request exists, because a request that
--    points at a file that failed to upload is worse than a file with no
--    request. This table is the receipt: the Edge Function writes a row
--    after the bytes land, and create_print_request consumes it exactly
--    once. A row nobody consumes is an orphan an administrator can purge.
--
--    It also makes the storage path unguessable and single-use: knowing
--    an upload id is useless without also being the admin or holding the
--    request token.
-- ---------------------------------------------------------------------
create table if not exists public.print_uploads (
  id                uuid primary key default gen_random_uuid(),
  device_id         text,
  storage_path      text not null,
  original_filename text not null,
  mime_type         text not null,
  file_size         bigint not null check (file_size > 0),
  created_at        timestamptz not null default now(),
  consumed_at       timestamptz
);

create index if not exists print_uploads_unconsumed_idx
  on public.print_uploads (created_at) where consumed_at is null;

-- ---------------------------------------------------------------------
-- 4. The print job itself
--
--    One row per print request. Everything here is structured rather
--    than prose, so the monthly report can count double-sided A3 jobs
--    for Cycle Two without parsing a sentence.
-- ---------------------------------------------------------------------
create table if not exists public.print_jobs (
  request_id        uuid primary key
                    references public.service_requests (id) on delete cascade,

  -- What the colleague called it. Optional, and the only part of a print
  -- request that other colleagues are ever shown.
  title             text check (title is null or char_length(trim(title)) between 1 and 120),

  -- The document. Private: nothing below this comment is readable by
  -- anon, and none of it enters the public snapshot.
  storage_provider  text not null default 'supabase'
                    check (storage_provider in ('supabase', 'google_drive')),
  storage_path      text not null,
  original_filename text not null,
  mime_type         text not null,
  file_size         bigint not null check (file_size > 0),

  -- How to print it.
  paper_size        text not null default 'A4',
  color_mode        text not null default 'bw'
                    check (color_mode in ('bw', 'color')),
  -- Tri-state on purpose: null means the question was never asked because
  -- the job is black and white. Only 'color' jobs carry true/false, and
  -- the RPC refuses a colour job that answered false.
  color_permission  boolean,
  print_sides       text not null default 'single'
                    check (print_sides in ('single', 'double')),
  copies            integer not null default 1 check (copies between 1 and 500),

  -- Where it goes. All three are snapshots: renaming a grade next year
  -- must not rewrite what last term's reports say.
  grade_id          uuid references public.school_grades (id) on delete set null,
  section_snapshot  text,
  level_snapshot    text,
  grade_snapshot    text,

  note              text check (note is null or char_length(note) <= 100),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- A colour job must have answered the permission question.
  constraint print_colour_permission_answered
    check (color_mode <> 'color' or color_permission is not null)
);

-- Paper sizes are a lookup, not a check constraint, so adding A2 later is
-- an INSERT rather than a migration that rewrites the table.
create table if not exists public.paper_sizes (
  code          text primary key,
  label         text not null,
  label_ar      text not null,
  display_order integer not null default 0,
  active        boolean not null default true
);

insert into public.paper_sizes (code, label, label_ar, display_order) values
  ('A4', 'A4', 'A4', 10),
  ('A3', 'A3', 'A3', 20),
  ('A5', 'A5', 'A5', 30)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 5. Row level security
--
--    The shape matches the rest of the application: RLS on, table writes
--    revoked from everyone, and every change made through a SECURITY
--    DEFINER function that checks who is asking.
--
--    Note what anon is NOT given below: no select on print_jobs, none on
--    print_uploads. A colleague's only read paths are the public snapshot
--    and get_request_by_token, and both are functions that decide for
--    themselves what to hand back.
-- ---------------------------------------------------------------------
alter table public.school_grades  enable row level security;
alter table public.paper_sizes    enable row level security;
alter table public.print_jobs     enable row level security;
alter table public.print_uploads  enable row level security;

drop policy if exists grades_read_all    on public.school_grades;
drop policy if exists grades_admin_write on public.school_grades;
drop policy if exists paper_read_all     on public.paper_sizes;
drop policy if exists paper_admin_write  on public.paper_sizes;
drop policy if exists print_jobs_admin   on public.print_jobs;

-- The structure of the school is not a secret, and the form cannot be
-- filled in without it.
create policy grades_read_all on public.school_grades
  for select to anon, authenticated using (active);

create policy grades_admin_write on public.school_grades
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy paper_read_all on public.paper_sizes
  for select to anon, authenticated using (active);

create policy paper_admin_write on public.paper_sizes
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Administrators only. There is deliberately no anon policy here at all.
create policy print_jobs_admin on public.print_jobs
  for select to authenticated using (public.is_admin());

-- print_uploads gets no policy whatsoever: only the service role, which
-- bypasses RLS, ever touches it.

revoke insert, update, delete on public.school_grades from anon, authenticated;
revoke insert, update, delete on public.paper_sizes   from anon, authenticated;
revoke all on public.print_jobs    from anon;
revoke insert, update, delete on public.print_jobs from authenticated;
revoke all on public.print_uploads from anon, authenticated;

grant select on public.school_grades to anon, authenticated;
grant select on public.paper_sizes   to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Creating a print request
--
--    Called by an anonymous browser, exactly like create_public_request.
-- ---------------------------------------------------------------------
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

  -- Same shape of limit the help form uses: no login means no natural
  -- rate limit, so the function enforces its own.
  select count(*) into v_recent
    from public.service_requests sr
   where sr.created_at > now() - interval '10 minutes'
     and sr.requester_name_snapshot = v_name;
  if v_recent >= 5 then
    raise exception 'Too many requests just now. Please wait a few minutes.'
      using errcode = '53400';
  end if;

  -- The file. Consuming the receipt is what stops one upload being
  -- attached to several requests.
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
  -- Server side, because a browser can be edited and this one costs money.
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

  -- Where the job is collected, not where the colleague is sitting.
  --
  -- The print form does not ask, because the answer is always the same
  -- place and nobody reads it. If a building looking like the photocopy
  -- room is configured, that is used; otherwise the request carries a
  -- plain label. Either way the column is never null, so the queue card,
  -- the history and the reports keep working unchanged.
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

  -- Printing is a task the school already configures; fall back to free
  -- text so a fresh install without such a row still works.
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

-- ---------------------------------------------------------------------
-- 7. Reading a print job
--
--    Two doors, and only two.
--
--    admin_print_job  - an administrator, checked by is_admin(), gets
--                       everything including the filename and the path.
--    print_job_public - what everybody else is allowed to know, which is
--                       a sentence. It takes no identity because there is
--                       nothing in it worth protecting.
-- ---------------------------------------------------------------------
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
    -- storage_path is deliberately absent: the Edge Function reads it
    -- with the service role. Nothing that reaches a browser needs it.
  ) into v
  from public.print_jobs pj
  where pj.request_id = p_request_id;

  return v;
end;
$fn$;

/**
 * The public-safe sentence, and only the sentence.
 * Title if the colleague gave one, otherwise nothing identifying at all.
 */
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

-- ---------------------------------------------------------------------
-- 8. The public board
--
--    The one thing an anonymous visitor reads. A print request shows as
--    a title or nothing - never a filename, never a path, never a size.
--    `request_type` is added so the board can draw the two kinds
--    differently, and `print_title` so it can say what it is printing.
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
        'print_title',    (select pj.title from public.print_jobs pj where pj.request_id = sr.id),
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
        'print_title',    (select pj.title from public.print_jobs pj where pj.request_id = sr.id)
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
               (select pj.title from public.print_jobs pj where pj.request_id = sr.id) as print_title
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
-- 9. The requester's own view
--
--    The token is the credential. Whoever holds it sees their own print
--    settings and the filename they themselves uploaded - which they
--    already know. They do NOT get the storage path; downloading still
--    goes through the Edge Function, which re-checks the token.
-- ---------------------------------------------------------------------
create or replace function public.get_request_by_token(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    -- The id is handed back so the holder of this token can ask the
    -- download function for their own document. It is useless without
    -- the token, which that function checks against this very row.
    'id',             sr.id,
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
-- 10. Housekeeping
--
--     An upload nobody turned into a request is litter. This returns the
--     paths so the Edge Function can delete the objects too - SQL cannot
--     reach the storage API on its own.
-- ---------------------------------------------------------------------
create or replace function public.admin_orphaned_uploads(p_older_than_hours integer default 24)
returns table (id uuid, storage_path text)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_admin() then
    raise exception 'Administrators only' using errcode = '42501';
  end if;

  return query
    select u.id, u.storage_path
      from public.print_uploads u
     where u.consumed_at is null
       and u.created_at < now() - make_interval(hours => greatest(p_older_than_hours, 1));
end;
$fn$;

-- ---------------------------------------------------------------------
-- 11. Grants
--
--     anon can create a print request and read its own by token. It can
--     do nothing else: no select on print_jobs, no path to a file.
-- ---------------------------------------------------------------------
revoke all on function public.create_print_request(text, uuid, uuid, text, text, text, text, boolean, text, integer, uuid, text, text, text) from public;
revoke all on function public.admin_print_job(uuid) from public;
revoke all on function public.print_job_public(uuid) from public;
revoke all on function public.admin_orphaned_uploads(integer) from public;

grant execute on function public.create_print_request(text, uuid, uuid, text, text, text, text, boolean, text, integer, uuid, text, text, text) to anon, authenticated;
grant execute on function public.print_job_public(uuid)       to anon, authenticated;
grant execute on function public.admin_print_job(uuid)        to authenticated;
grant execute on function public.admin_orphaned_uploads(integer) to authenticated;

-- ---------------------------------------------------------------------
-- 12. Refresh the board so the new fields appear at once.
-- ---------------------------------------------------------------------
update public.public_board
   set snapshot = public.build_public_snapshot(), updated_at = now()
 where id = 1;

commit;

notify pgrst, 'reload schema';
