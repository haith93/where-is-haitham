-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-collection-visible-to-sender.sql
--
--  Run once, after migration-ready-to-collect.sql (16).
--  Undo:  sql/rollback-collection-visible-to-sender.sql
--
--  WHY
--  ---
--  Migration 16 let a teacher find out that a job is ready. It did not
--  tell the person who sent it whether anybody ever came for it.
--
--  That is the wrong way round. The coordinator who sent the exam is
--  the one who gets asked "did it arrive?", and their own copy of the
--  request simply closed without saying how. They are also the person
--  who clears the request off their phone, and they should not be
--  doing that still wondering.
--
--  WHAT CHANGES
--  ------------
--  get_request_by_token - the one function a requester's device calls
--  about its own request - now returns ready_at, who was expected, and
--  every collection that happened, with names and times.
--
--  No signature change, one function replaced, nothing else touched.
--
--  PRIVACY
--  -------
--  This is not new exposure. The token is already the authorisation:
--  whoever holds it created the request, and already receives the
--  filename, the settings and the title through this same function.
--  Who collected their document is less sensitive than what is in it.
--  The board, which needs no token, still publishes names and numbers
--  only.
-- =====================================================================

begin;

do $do$
begin
  if to_regprocedure('public.record_collection(uuid, text, text)') is null then
    raise exception
      'Run sql/migration-ready-to-collect.sql first (number 16).'
      using errcode = '42883';
  end if;
end
$do$;

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
    -- What Haitham wrote back. `notes` is NOT here, and must never be:
    -- that one is his own and nobody else's.
    'admin_message',    sr.admin_message,

    -- Whether the paper has been collected, and by whom. The person who
    -- sent the job is the one who gets asked "did it arrive?", and
    -- until now they could not answer: the request simply closed.
    'ready_at',         sr.ready_at,
    'expected_collectors',
        to_jsonb(coalesce(sr.expected_collectors, array[]::text[])),
    'collected', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'name', rc.collector_name,
               'note', rc.note,
               'at',   rc.collected_at)
             order by rc.collected_at), '[]'::jsonb)
        from public.request_collections rc
       where rc.request_id = sr.id
    ),
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
        'pages',             pj.pages,
        'sheets',            public.print_sheets(pj.pages, pj.print_sides, pj.copies),
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

revoke all on function public.get_request_by_token(uuid) from public;
grant execute on function public.get_request_by_token(uuid) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
