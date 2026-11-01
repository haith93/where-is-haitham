-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  rollback-collection-visible-to-sender.sql
--
--  Undoes sql/migration-collection-visible-to-sender.sql.
--
--  get_request_by_token goes back to the migration 15 version, so a
--  requester's own device can no longer see whether their document was
--  collected. Nothing is deleted: request_collections is untouched and
--  the console still shows every collection.
-- =====================================================================

begin;

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
