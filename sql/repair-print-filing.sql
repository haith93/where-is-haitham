-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  repair-print-filing.sql
--
--  Safe to run more than once. Changes data; see exactly what, below.
--
--  WHY
--  ---
--  A print request is filed against a building and a task so the
--  reports can group and filter by them. When no matching row existed,
--  create_print_request fell back to writing the names as free text -
--  which reads the same on screen and is invisible to both filters,
--  because free text has no id to filter on.
--
--  Migration 14 re-filed what it could at the time. If the photocopying
--  task was added afterwards, that pass found nothing to point at and
--  the older requests are still on free text. This script is that pass,
--  run again now the rows exist.
--
--  WHAT IT CHANGES
--  ---------------
--  Only requests where request_type = 'print', and only where the field
--  is currently free text:
--
--    * location_building_id is null  ->  the photocopy building
--    * category_task_id     is null  ->  the photocopying task
--
--  A request that already points at a real row is left exactly as it
--  is. That matters: the record form lets Haitham choose a building by
--  hand, and a deliberate choice is not a mistake to correct.
--
--  Nothing else is touched. status_history is left alone - it records
--  what the board actually displayed, and that is a fact about the past
--  rather than a value to fix.
--
--  There is no rollback. Restoring free text over a correct link would
--  be re-breaking the filters on purpose.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. What will change, before anything does
-- ---------------------------------------------------------------------
select 'before' as when_,
       count(*)                                          as print_requests,
       count(*) filter (where location_building_id is null) as free_text_location,
       count(*) filter (where category_task_id is null)     as free_text_task
  from public.service_requests
 where request_type = 'print';

-- ---------------------------------------------------------------------
-- 2. The repair
-- ---------------------------------------------------------------------
do $do$
declare
  v_task public.tasks     := public.print_task();
  v_bld  public.buildings := public.print_location();
  v_n    integer;
begin
  if v_task.id is null then
    raise warning
      'No photocopying task exists. Add one named "Photocopying" in the '
      'admin console, then run this again.';
  else
    update public.service_requests sr
       set category_task_id          = v_task.id,
           custom_category           = null,
           category_name_snapshot    = v_task.name,
           category_name_ar_snapshot = coalesce(v_task.name_ar, v_task.name)
     where sr.request_type = 'print'
       and sr.category_task_id is null;
    get diagnostics v_n = row_count;
    raise notice 'Re-filed under task "%": % requests', v_task.name, v_n;
  end if;

  if v_bld.id is null then
    raise warning
      'No photocopy building exists, so print requests keep a free-text '
      'location and cannot be filtered by building.';
  else
    update public.service_requests sr
       set location_building_id      = v_bld.id,
           custom_location           = null,
           location_name_snapshot    = v_bld.name,
           location_name_ar_snapshot = coalesce(v_bld.name_ar, v_bld.name)
     where sr.request_type = 'print'
       and sr.location_building_id is null;
    get diagnostics v_n = row_count;
    raise notice 'Re-filed at building "%": % requests', v_bld.name, v_n;
  end if;
end
$do$;

-- ---------------------------------------------------------------------
-- 3. And what it looks like now
-- ---------------------------------------------------------------------
select 'after' as when_,
       count(*)                                          as print_requests,
       count(*) filter (where location_building_id is null) as free_text_location,
       count(*) filter (where category_task_id is null)     as free_text_task
  from public.service_requests
 where request_type = 'print';

commit;
