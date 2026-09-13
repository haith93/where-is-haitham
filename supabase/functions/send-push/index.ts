/**
 * send-push — Supabase Edge Function
 *
 * WHY THIS EXISTS
 * ---------------
 * A Web Push message must be signed with the VAPID *private* key. That
 * key can never be shipped to a browser, and GitHub Pages has no server
 * of its own, so the sending half of push lives here instead.
 *
 * HOW IT RUNS
 * -----------
 * A Database Webhook on `public.notifications` (INSERT) calls this
 * function. It looks up the recipient's push subscriptions and delivers
 * the message to each device. Subscriptions the browser has thrown away
 * (404 / 410) are deleted so the table does not fill with dead rows.
 *
 * The whole app works without this function deployed — notifications
 * then appear in-app over Realtime instead. See the README.
 *
 * REQUIRED SECRETS (supabase secrets set ...)
 *   VAPID_PUBLIC_KEY     same value as js/env.js -> vapidPublicKey
 *   VAPID_PRIVATE_KEY    keep secret, never in the frontend
 *   VAPID_SUBJECT        e.g. mailto:it@example.com
 *   PUSH_WEBHOOK_SECRET  any long random string; also set as the
 *                        webhook's custom header (see README)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

interface NotificationRow {
  id: string;
  user_id: string;
  request_id: string | null;
  title: string;
  message: string;
  type: string | null;
}

const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';
const WEBHOOK_SECRET = Deno.env.get('PUSH_WEBHOOK_SECRET') ?? '';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } }
);

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Only our own database webhook may call this.
  if (WEBHOOK_SECRET) {
    const provided = req.headers.get('x-webhook-secret');
    if (provided !== WEBHOOK_SECRET) return json({ error: 'Unauthorized' }, 401);
  }

  if (!VAPID_PRIVATE_KEY) {
    // Not configured: succeed quietly so the database insert is never
    // held up by a push setup that is not finished yet.
    return json({ skipped: 'VAPID keys are not configured' });
  }

  let payload: { type?: string; record?: NotificationRow };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const row = payload.record;
  if (!row?.user_id) return json({ skipped: 'No notification record in the request' });

  const { data: subscriptions, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', row.user_id);

  if (error) {
    console.error('subscription lookup failed', error);
    return json({ error: error.message }, 500);
  }
  if (!subscriptions?.length) return json({ sent: 0, reason: 'No devices registered' });

  // Deep link straight to the thing that changed.
  const url = row.type === 'new_request' ? './admin.html#/requests' : './index.html';
  const body = JSON.stringify({
    title: row.title,
    body: row.message,
    tag: `req-${row.request_id ?? row.id}`,
    url,
    priority: /very urgent/i.test(row.title) ? 'very_urgent' : 'normal'
  });

  const dead: string[] = [];
  let sent = 0;

  await Promise.all(subscriptions.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh ?? '', auth: sub.auth ?? '' } },
        body
      );
      sent += 1;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) dead.push(sub.id);
      else console.error('push failed', status, (err as Error).message);
    }
  }));

  if (dead.length) {
    await supabase.from('push_subscriptions').delete().in('id', dead);
  }

  return json({ sent, removed: dead.length });
});
