-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  rollback-print-offline-delivery.sql
--
--  Undoes sql/migration-print-offline-delivery.sql.
--
--  WHAT IT CANNOT DO
--  -----------------
--  The old shape required every print job to have a file. If any job was
--  recorded as arriving by hand, on WhatsApp or by email while this
--  feature was live, it has no file and cannot exist under the old rules.
--  This script REFUSES rather than deleting somebody's record of work
--  they actually did, and the message names the one statement that would
--  discard them if that is genuinely what you want.
--
--  The `delivery` column is left in place. It is harmless, the old code
--  never reads it, and dropping a column is the one step here that could
--  not itself be undone.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Refuse to destroy data
-- ---------------------------------------------------------------------
do $$
declare
  v_offline integer;
begin
  select count(*) into v_offline
    from public.print_jobs
   where storage_path is null;

  if v_offline > 0 then
    raise exception
      'Refusing to roll back: % print job(s) have no attached file because '
      'the document arrived by hand or another way. They cannot exist under '
      'the old NOT NULL rules. To discard them, run: delete from '
      'public.print_jobs where storage_path is null;',
      v_offline;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. The constraints and the NOT NULLs, as they were
-- ---------------------------------------------------------------------
alter table public.print_jobs
  drop constraint if exists print_jobs_file_matches_delivery;

alter table public.print_jobs
  alter column storage_path      set not null,
  alter column original_filename set not null,
  alter column mime_type         set not null,
  alter column file_size         set not null;

-- ---------------------------------------------------------------------
-- 2. The administrator's print form is gone
-- ---------------------------------------------------------------------
drop function if exists public.admin_create_print_request(
  text, jsonb, text, text, text, text, uuid, text, boolean, integer);

-- ---------------------------------------------------------------------
-- 3. The reader, without `delivery`
-- ---------------------------------------------------------------------
create or replace function public.admin_print_jobs(p_request_id uuid)
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',                pj.id,
    'position',          pj.position,
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
  ) order by pj.position), '[]'::jsonb) into v
  from public.print_jobs pj
  where pj.request_id = p_request_id;

  return v;
end;
$fn$;

commit;

notify pgrst, 'reload schema';
