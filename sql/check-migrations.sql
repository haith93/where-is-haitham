-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  check-migrations.sql
--
--  Read-only. Changes nothing. Run it in the SQL editor any time you are
--  unsure which migrations have landed on this database.
--
--  Each row checks for something only that migration creates, so the
--  answer does not depend on remembering what was run.
-- =====================================================================

with checks as (
  select
    '1. public-requests' as migration,
    (to_regclass('public.request_throttle') is not null)
      and exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'service_requests'
                     and column_name = 'channel')
      and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'create_public_request')
      as applied,
    'anonymous requests, channels' as adds

  union all select
    '2. bilingual-names',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'buildings' and column_name = 'name_ar')
      and exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'service_requests'
                     and column_name = 'location_name_ar_snapshot')
      and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'building_name_ar'),
    'Arabic names for buildings and tasks'

  union all select
    '3. buildings-and-interruptions',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'service_requests' and column_name = 'paused_at')
      and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'pause_request')
      and exists (select 1 from public.buildings where name = 'Rihab Zahraa HS'),
    'real building names, put a job on hold'

  union all select
    '4. test-cleanup',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'admin_delete_request'),
    'delete a request, clear test data'

  union all select
    '5. push-trigger (optional)',
    (to_regclass('public.push_config') is not null)
      and exists (select 1 from pg_trigger where tgname = 'push_on_notification'),
    'send push when a notification is written'
)
select migration,
       case when applied then 'OK' else '>>> NOT RUN <<<' end as status,
       adds
  from checks
 order by migration;

-- ---------------------------------------------------------------------
--  If everything says OK and the app still misbehaves, the problem is
--  PostgREST's cached view of the schema rather than the schema itself:
--
--      notify pgrst, 'reload schema';
--
--  And a quick look at what the dropdowns will actually show:
--
--      select name, name_ar, active, display_order
--        from public.buildings
--       order by active desc, display_order, name;
-- ---------------------------------------------------------------------
