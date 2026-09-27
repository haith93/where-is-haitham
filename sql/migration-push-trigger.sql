-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  migration-push-trigger.sql
--
--  Calls the send-push Edge Function whenever a notification row is
--  inserted, without using the dashboard's Database Webhooks screen.
--
--  WHY NOT THE DASHBOARD
--  ---------------------
--  A "Database Webhook" in Supabase is nothing more than a trigger that
--  calls net.http_post(). Writing it here instead means it lives in the
--  repository, can be re-run on a new project, and does not depend on a
--  table appearing in a dropdown.
--
--  BEFORE RUNNING
--  --------------
--  Fill in the two values in section 3. Everything else is automatic.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. pg_net — lets Postgres make outbound HTTP calls
-- ---------------------------------------------------------------------
create schema if not exists extensions;

do $do$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    execute 'create extension pg_net with schema extensions';
  end if;
end
$do$;

-- ---------------------------------------------------------------------
-- 2. WHERE TO CALL, AND WITH WHAT SECRET
--    RLS on and no policies, and every grant revoked: this is reachable
--    only from the SECURITY DEFINER trigger below. The webhook secret
--    must never sit in app_settings, which is world-readable.
-- ---------------------------------------------------------------------
create table if not exists public.push_config (
  id             smallint primary key default 1 check (id = 1),
  function_url   text not null,
  webhook_secret text not null,
  updated_at     timestamptz not null default now()
);

alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. >>> EDIT THESE TWO LINES <<<
--
--    function_url   : Supabase -> Edge Functions -> send-push -> the URL
--    webhook_secret : the same string you set as the PUSH_WEBHOOK_SECRET
--                     secret on that function
-- ---------------------------------------------------------------------
insert into public.push_config (id, function_url, webhook_secret)
values (
  1,
  'https://cjvwwncaftkzbbpwugdi.supabase.co/functions/v1/send-push',
  'PASTE-YOUR-PUSH-WEBHOOK-SECRET-HERE'
)
on conflict (id) do update
  set function_url   = excluded.function_url,
      webhook_secret = excluded.webhook_secret,
      updated_at     = now();

-- ---------------------------------------------------------------------
-- 4. THE TRIGGER
--    Posts the same {type, record} shape the Edge Function already
--    expects, so the function needs no changes.
--
--    net.http_post queues the request and returns immediately, so a slow
--    or unreachable push service can never hold up the insert that
--    created the notification.
-- ---------------------------------------------------------------------
create or replace function public.send_push_for_notification()
returns trigger
language plpgsql
security definer
set search_path = public, net, extensions
as $fn$
declare
  v_url    text;
  v_secret text;
begin
  select function_url, webhook_secret into v_url, v_secret
    from public.push_config where id = 1;

  -- Not configured yet: stay silent. The notification row is still
  -- written and still arrives in-app over Realtime.
  if v_url is null or v_url = '' or v_secret is null or v_secret = ''
     or v_secret = 'PASTE-YOUR-PUSH-WEBHOOK-SECRET-HERE' then
    return null;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',     'application/json',
                 'x-webhook-secret', v_secret
               ),
    body    := jsonb_build_object(
                 'type',   'INSERT',
                 'table',  'notifications',
                 'record', to_jsonb(new)
               ),
    timeout_milliseconds := 5000
  );

  return null;
exception when others then
  -- Push is a convenience. If the call cannot even be queued, log it and
  -- let the notification itself succeed.
  raise warning 'send_push_for_notification failed: %', sqlerrm;
  return null;
end;
$fn$;

drop trigger if exists push_on_notification on public.notifications;
create trigger push_on_notification
  after insert on public.notifications
  for each row execute function public.send_push_for_notification();

commit;

-- =====================================================================
--  CHECKING IT
--  -----------
--  1. Confirm the table the dashboard could not find really is there:
--
--       select table_schema, table_name
--         from information_schema.tables
--        where table_name = 'notifications';
--
--  2. Send yourself a test notification (replace the e-mail):
--
--       insert into public.notifications (user_id, title, message, type)
--       select id, 'Test', 'Checking push delivery', 'system'
--         from public.profiles
--        where lower(email) = lower('haitham@example.com');
--
--  3. Watch the outbound call. pg_net records every response:
--
--       select id, status_code, content, created
--         from net._http_response
--        order by created desc
--        limit 5;
--
--     200  -> delivered; check the Edge Function logs for how many devices
--     401  -> the secret here does not match the function's secret
--     404  -> function_url is wrong
--     no row at all -> the trigger did not fire; re-run this file
-- =====================================================================
