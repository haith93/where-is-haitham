-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  check-print-state.sql
--
--  READ ONLY. Changes nothing. Safe to run at any time, on production.
--
--  Answers one question: is the print feature's database in the state
--  the current code expects?
--
--  It checks for the things themselves rather than for a record of
--  having run something, so the answer does not depend on remembering
--  what was run, in what order, or how many times.
--
--  Every row should read OK.
-- =====================================================================

with checks as (

  -- ---- The tables -------------------------------------------------
  select 1::numeric as ord, 'print_jobs table' as item,
         case when to_regclass('public.print_jobs') is not null
              then 'OK' else 'MISSING' end as state,
         'Holds one row per document' as detail

  union all
  select 2, 'print_uploads table',
         case when to_regclass('public.print_uploads') is not null
              then 'OK' else 'MISSING' end,
         'Receipts for files that have landed in storage'

  union all
  select 3, 'school_grades seeded',
         case when coalesce((select count(*) from public.school_grades), 0) > 0
              then 'OK' else 'EMPTY' end,
         coalesce((select count(*)::text || ' grades'
                     from public.school_grades where active), '0') || ' active'

  -- ---- Several documents per request ------------------------------
  union all
  select 4, 'print_jobs keyed by id',
         case when exists (
                select 1 from pg_constraint
                 where conrelid = 'public.print_jobs'::regclass
                   and contype = 'p'
                   and conname = 'print_jobs_pkey_id')
              then 'OK' else 'OLD KEY' end,
         'request_id as the key would allow only one document each'

  -- ---- Documents that never arrived as a file ---------------------
  union all
  select 5, 'delivery column',
         case when exists (
                select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'print_jobs'
                   and column_name = 'delivery')
              then 'OK' else 'MISSING' end,
         'How the document reached him'

  union all
  select 6, 'storage columns optional',
         case when not exists (
                select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'print_jobs'
                   and column_name in ('storage_path','original_filename','mime_type','file_size')
                   and is_nullable = 'NO')
              then 'OK' else 'STILL REQUIRED' end,
         'A job handed over on paper has no file to point at'

  union all
  select 7, 'file matches delivery',
         case when exists (
                select 1 from pg_constraint
                 where conrelid = 'public.print_jobs'::regclass
                   and conname = 'print_jobs_file_matches_delivery')
              then 'OK' else 'MISSING' end,
         'An upload must have a file; anything else must have a title'

  -- ---- The functions the frontend calls by name -------------------
  union all
  -- to_regprocedure, not a string compare against
  -- pg_get_function_identity_arguments: that function includes the
  -- parameter NAMES in its output, so comparing it to a list of types
  -- never matches and reports a healthy function as broken.
  select 8, 'create_print_request (public form)',
         case when to_regprocedure(
                'public.create_print_request(text, jsonb, text, text, uuid, text, text)'
              ) is not null
              then 'OK' else 'WRONG SIGNATURE' end,
         -- Saying only "wrong" leaves you guessing. Print what is there.
         coalesce((select string_agg(
                     '(' || pg_get_function_identity_arguments(p.oid) || ')', ' AND ')
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'create_print_request'),
                  'no such function')

  union all
  select 9, 'admin_create_print_request (record form)',
         case when exists (
                select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'admin_create_print_request')
              then 'OK' else 'MISSING' end,
         'Recording a job that arrived by hand'

  union all
  select 10, 'admin_print_jobs returns delivery',
         case when (select pg_get_functiondef(p.oid)
                      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'admin_print_jobs'
                     limit 1) like '%''delivery''%'
              then 'OK' else 'OLD VERSION' end,
         'Without it the console cannot tell a paper job from a file'

  union all
  select 11, 'only one create_print_request',
         case when (select count(*) from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'create_print_request') = 1
              then 'OK' else 'DUPLICATE OVERLOADS' end,
         'Two overloads and PostgREST may pick the wrong one'

  -- ---- Consistency of what is already stored ----------------------
  union all
  select 12, 'no orphaned file-less jobs',
         case when not exists (
                select 1 from public.print_jobs
                 where storage_path is null and title is null)
              then 'OK' else 'FOUND' end,
         'A job with neither a file nor a name cannot be identified'

  union all
  select 13, 'uploads all accounted for',
         'OK',
         coalesce((select count(*)::text from public.print_uploads
                    where consumed_at is null), '0')
         || ' unconsumed (orphans an administrator can purge)'

  -- ---- Where a print request gets filed ---------------------------
  union all
  select 14, 'one place decides the print task',
         case when to_regprocedure('public.print_task()') is not null
               and to_regprocedure('public.print_location()') is not null
              then 'OK' else 'OLD NAME MATCH' end,
         'Otherwise each RPC carries its own guess, and "Printer repair" can win'

  union all
  select 15, 'a photocopying task exists to file under',
         case when exists (
                select 1 from public.tasks
                 where active
                   and (lower(name) like '%photocop%'
                     or lower(name) like '%printing%'
                     or lower(name) like '%copying%'
                     or coalesce(name_ar, '') like '%تصوير%')
                   and lower(name) not like '%repair%')
              then 'OK' else 'FALLBACK' end,
         'Without one, print jobs fall back to free text and lose the task filter'

  union all
  select 16, 'finishing a job frees the status',
         case when to_regprocedure('public.release_status_after_request(uuid)') is not null
              then 'OK' else 'MISSING' end,
         'Without it the board still says he is on a job that is done'

  union all
  select 16.5, 'pages column (migration 15)',
         case when exists (
                select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'print_jobs'
                   and column_name = 'pages')
              then 'OK' else 'MISSING' end,
         'Sheets of paper cannot be counted without it'

  union all
  select 16.6, 'update_my_status takes a return date',
         case when to_regprocedure(
                'public.update_my_status(text, uuid, text, uuid, text, integer, uuid, timestamptz)'
              ) is not null then 'OK' else 'MISSING' end,
         'A finished day says which day he is back'

  union all
  select 16.7, 'annotate_request (notes)',
         case when to_regprocedure('public.annotate_request(uuid, text, text)') is not null
              then 'OK' else 'MISSING' end,
         'A message to the colleague and a private note'

  union all
  select 17, 'print requests are filterable',
         case when not exists (
                select 1 from public.service_requests
                 where request_type = 'print'
                   and (location_building_id is null or category_task_id is null))
              then 'OK' else 'SOME FREE TEXT' end,
         coalesce((select count(*)::text from public.service_requests
                    where request_type = 'print'
                      and location_building_id is not null
                      and category_task_id is not null), '0')
         || ' of '
         || coalesce((select count(*)::text from public.service_requests
                       where request_type = 'print'), '0')
         || ' against a real building and task'
)

select ord as "#", item as "Check", state as "Result", detail as "What it means"
from checks
order by ord;
