-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  fix-print-request-overload.sql
--
--  Run this ONLY if check-print-state.sql row 8 says WRONG SIGNATURE
--  and names a ten-argument create_print_request.
--
--  Safe to run more than once. Safe to run when there is nothing to
--  fix: it checks first and says so.
--
--  WHAT HAPPENED
--  -------------
--  create_print_request has had three shapes. Migration 9 gave it ten
--  arguments, with colour and the note applying to the whole request.
--  Migration 10 moved those onto each document, which made the shape
--  seven arguments, and dropped the ten-argument one.
--
--  rollback-print-per-file-colour.sql does the reverse: it drops the
--  seven and restores the ten. Running it undoes migrations 10, 12, 14
--  and 15 as far as this one function is concerned, because each of
--  those only ever replaced the seven-argument form.
--
--  WHY IT IS NOT OBVIOUS FROM THE APP
--  ----------------------------------
--  PostgREST matches a call by parameter NAME. The ten-argument version
--  contains all seven of the names the website sends, and its three
--  extra arguments have defaults - so every call still resolves and
--  every print request still appears to work.
--
--  What silently stops working is everything added after migration 9:
--  per-document colour and its permission, the per-document note, a
--  document that arrived by hand with no file, and the page count.
--  Those keys are sent inside p_files and the old body simply ignores
--  them.
--
--  WHAT THIS DOES
--  --------------
--  Removes the stale ten-argument function. It does NOT recreate the
--  current one - re-run migration 15 immediately afterwards, which
--  defines it properly along with everything that depends on it.
--
--  No data is touched.
-- =====================================================================

begin;

do $do$
declare
  v_old  oid := to_regprocedure(
    'public.create_print_request(text, jsonb, text, text, boolean, text, text, uuid, text, text)');
  v_new  oid := to_regprocedure(
    'public.create_print_request(text, jsonb, text, text, uuid, text, text)');
begin
  if v_old is null then
    raise notice
      'No ten-argument create_print_request here, so there is nothing to remove.';
  else
    drop function public.create_print_request(
      text, jsonb, text, text, boolean, text, text, uuid, text, text);
    raise notice 'Removed the ten-argument create_print_request.';
  end if;

  if v_new is null then
    raise notice
      'The current seven-argument version is missing. Run '
      'sql/migration-end-of-day-notes-and-pages.sql now to put it back.';
  else
    raise notice
      'The seven-argument version is present. Re-run migration 15 anyway '
      'if you are unsure which body it holds - it is idempotent.';
  end if;
end
$do$;

commit;

notify pgrst, 'reload schema';
