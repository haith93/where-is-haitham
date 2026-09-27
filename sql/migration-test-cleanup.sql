-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-test-cleanup.sql
--
--  Run once, after the earlier migrations.
--
--  Tools for the period before the app goes live, when the queue is full
--  of requests you invented to see whether the thing works. Real requests
--  are indistinguishable from test ones once they are in the table, so
--  this provides a way to remove them.
--
--  Everything here is administrator-only, writes to the audit log, and
--  is deliberately awkward enough that nobody triggers it by accident.
--
--  NOTE ON THE WHERE CLAUSES
--  Supabase refuses a DELETE or UPDATE with no WHERE ("DELETE requires a
--  WHERE clause"), which is a good guard against a mistyped statement
--  wiping a table. Clearing a table is genuinely the intent here, so each
--  statement says so explicitly with a predicate that matches every row.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. DELETE ONE REQUEST
--    For the usual case: a single test request that should not appear in
--    anybody's history. Cascades take request_history and notifications
--    with it; the current-status pointers are cleared first so nothing is
--    left referring to a row that no longer exists.
-- ---------------------------------------------------------------------
create or replace function public.admin_delete_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_row public.service_requests;
begin
  if not public.is_admin() then
    raise exception 'Administrators only' using errcode = '42501';
  end if;

  select * into v_row from public.service_requests where id = p_request_id;
  if v_row is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;

  update public.current_status
     set serving_request_id = null
   where serving_request_id = p_request_id;
  update public.current_status
     set next_request_id = null
   where next_request_id = p_request_id;
  update public.status_history
     set request_id = null
   where request_id = p_request_id;

  delete from public.service_requests where id = p_request_id;

  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'request_deleted', 'service_requests', p_request_id,
          jsonb_build_object('number', v_row.request_number,
                             'requester', v_row.requester_name_snapshot));

  return jsonb_build_object('deleted', v_row.request_number);
end;
$fn$;

-- ---------------------------------------------------------------------
-- 2. CLEAR EVERY REQUEST
--    Starting the real log with a clean sheet. Also rewinds the request
--    numbering, so the first real request is REQ-<year>-000001 rather
--    than carrying on from wherever the testing stopped.
-- ---------------------------------------------------------------------
create or replace function public.admin_purge_requests()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_count integer;
begin
  if not public.is_admin() then
    raise exception 'Administrators only' using errcode = '42501';
  end if;

  select count(*) into v_count from public.service_requests;

  update public.current_status
     set serving_request_id = null, next_request_id = null
   where user_id is not null;
  update public.status_history set request_id = null where request_id is not null;

  delete from public.service_requests where id is not null;
  delete from public.notifications     where id is not null;
  delete from public.request_throttle  where device_id is not null;

  -- Restart the numbering for the current year.
  delete from public.request_counters
   where year = extract(year from (now() at time zone 'Asia/Beirut'))::int;

  insert into public.audit_log (actor_id, action, entity, details)
  values (auth.uid(), 'requests_purged', 'service_requests',
          jsonb_build_object('count', v_count));

  return jsonb_build_object('deleted', v_count);
end;
$fn$;

-- ---------------------------------------------------------------------
-- 3. CLEAR THE ACTIVITY LOG
--    Every status you posted while testing, and the current status with
--    it, so reports start from nothing. Requests are untouched.
-- ---------------------------------------------------------------------
create or replace function public.admin_purge_activity()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare v_count integer;
begin
  if not public.is_admin() then
    raise exception 'Administrators only' using errcode = '42501';
  end if;

  select count(*) into v_count from public.status_history;

  delete from public.status_history where id is not null;
  delete from public.current_status where id is not null;

  insert into public.audit_log (actor_id, action, entity, details)
  values (auth.uid(), 'activity_purged', 'status_history',
          jsonb_build_object('count', v_count));

  return jsonb_build_object('deleted', v_count);
end;
$fn$;

-- ---------------------------------------------------------------------
-- 4. GRANTS
-- ---------------------------------------------------------------------
revoke all on function public.admin_delete_request(uuid) from public;
revoke all on function public.admin_purge_requests()     from public;
revoke all on function public.admin_purge_activity()     from public;

grant execute on function public.admin_delete_request(uuid) to authenticated;
grant execute on function public.admin_purge_requests()     to authenticated;
grant execute on function public.admin_purge_activity()     to authenticated;

commit;

notify pgrst, 'reload schema';
