-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-ui-skin.sql
--
--  Run once. Makes the interface style a site-wide setting instead of a
--  per-device preference, and sets the brutalist skin as the default.
--
--  app_settings is readable without an account, which is what lets the
--  public board pick the style up for colleagues who never sign in.
--  Only an administrator can write it (see settings_admin_write in
--  rls.sql), so nobody else can restyle the board.
--
--  Adding another skin later needs no migration: the value is just an
--  id that the frontend registry in js/skins.js knows about.
-- =====================================================================

insert into public.app_settings (key, value)
values ('ui_skin', '"brutal"'::jsonb)
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();

notify pgrst, 'reload schema';

-- Check:
--   select key, value from public.app_settings where key = 'ui_skin';
