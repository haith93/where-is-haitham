-- =====================================================================
--  WHERE IS HAITHAM NOW?  --  diagnose-push.sql
--
--  The in-app bell and the phone's notification panel are two different
--  things. The bell is Realtime: the browser is already connected and a
--  new row appears. The notification panel needs a whole chain:
--
--    request created
--      -> a row in public.notifications          (the bell works from here)
--      -> trigger push_on_notification
--      -> pg_net posts to the send-push function
--      -> the function signs with VAPID and calls Google/FCM
--      -> the phone wakes the service worker
--      -> showNotification()
--
--  PART 1 is read-only and tells you which link is broken.
--  PART 2 sends one real notification through the whole chain.
-- =====================================================================


-- =====================================================================
--  PART 1 — WHERE IS IT BROKEN?  (changes nothing)
-- =====================================================================

with checks as (
  select 1 as step, 'Devices registered for push' as what,
    (select count(*)::text from public.push_subscriptions) as value,
    (select count(*) from public.push_subscriptions) > 0 as ok,
    'Zero means the phone never registered. Open the admin console on the phone, Settings, Turn on notifications. If the button is missing, VAPID_PUBLIC_KEY is not in the deployed js/env.js.' as if_wrong

  union all select 2, 'pg_net extension installed',
    coalesce((select 'yes' from pg_extension where extname = 'pg_net'), 'no'),
    exists (select 1 from pg_extension where extname = 'pg_net'),
    'Run migration-push-trigger.sql.'

  union all select 3, 'Trigger on notifications',
    coalesce((select 'yes' from pg_trigger where tgname = 'push_on_notification'), 'no'),
    exists (select 1 from pg_trigger where tgname = 'push_on_notification'),
    'Run migration-push-trigger.sql.'

  union all select 4, 'Function URL and secret set',
    coalesce((select case
                when webhook_secret = 'PASTE-YOUR-PUSH-WEBHOOK-SECRET-HERE' then 'placeholder still there'
                when coalesce(trim(function_url), '') = '' then 'url empty'
                else 'set' end
              from public.push_config where id = 1), 'no push_config row'),
    coalesce((select webhook_secret <> 'PASTE-YOUR-PUSH-WEBHOOK-SECRET-HERE'
                     and coalesce(trim(function_url), '') <> ''
              from public.push_config where id = 1), false),
    'Edit section 3 of migration-push-trigger.sql with the real function URL and the PUSH_WEBHOOK_SECRET you set on the Edge Function, then run it again.'

  union all select 5, 'Notification rows written',
    (select count(*)::text from public.notifications where created_at > now() - interval '7 days'),
    (select count(*) from public.notifications where created_at > now() - interval '7 days') > 0,
    'No rows means no request reached the database, which is a different problem from push.'

  union all select 6, 'Outbound calls attempted',
    coalesce((select count(*)::text from net._http_response where created > now() - interval '7 days'), '0'),
    coalesce((select count(*) from net._http_response where created > now() - interval '7 days'), 0) > 0,
    'Rows in notifications but none here means the trigger is not firing. Re-run migration-push-trigger.sql.'
)
select step,
       what,
       value,
       case when ok then 'OK' else '>>> PROBLEM <<<' end as status,
       case when ok then '' else if_wrong end as what_to_do
  from checks
 order by step;


-- ---------------------------------------------------------------------
--  The last few calls the database actually made.
--
--    200  delivered to Google. If the phone still shows nothing, the
--         problem is on the device (see the checklist below).
--    401  the secret in push_config does not match the one set on the
--         Edge Function.
--    404  function_url is wrong, or the function is not deployed.
--    546 / 5xx  the function itself failed - open its logs in Supabase.
--    no rows at all  the trigger never ran.
-- ---------------------------------------------------------------------
select id, status_code, left(content, 300) as response, created
  from net._http_response
 order by created desc
 limit 10;


-- =====================================================================
--  PART 2 — SEND ONE THROUGH THE REAL CHAIN
--
--  Unlike "Send a test" in the app, this goes through the trigger, the
--  Edge Function and Google, exactly as a real request does.
--
--  Put your own e-mail in, run it, then wait about ten seconds and run
--  the net._http_response query above again.
-- =====================================================================

-- insert into public.notifications (user_id, title, message, type)
-- select id, 'Real push test', 'If this reaches your phone, the chain works.', 'system'
--   from public.profiles
--  where lower(email) = lower('haitham@example.com');


-- =====================================================================
--  IF EVERY STEP SAYS OK AND status_code IS 200
--
--  The server side is fine and the problem is the phone. On a Galaxy
--  A16, in this order:
--
--  1. Settings -> Apps -> (the installed app) -> Battery
--       -> Unrestricted.  Samsung's power saving silently holds
--          background notifications; this is the usual culprit.
--
--  2. Settings -> Apps -> (the installed app) -> Notifications
--       -> allowed, and the category switched on.
--
--  3. Open the app from the HOME SCREEN icon, not a Chrome tab. A tab
--     does not keep a push subscription reliably.
--
--  4. Settings -> Battery -> Background usage limits
--       -> make sure the app is not in "Sleeping" or "Deep sleeping".
--
--  5. Turn notifications off and on again in the app's Settings, which
--     registers a fresh subscription.
-- =====================================================================
