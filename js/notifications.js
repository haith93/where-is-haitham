/**
 * Notifications, in two layers.
 *
 * 1. IN-APP  — rows in `public.notifications`, delivered over Realtime.
 *              Always works, in every browser, while the app is open.
 *
 * 2. WEB PUSH — reaches the phone when the app is closed. GitHub Pages
 *              cannot send push messages (it has no server), so the
 *              sending half lives in a Supabase Edge Function; see
 *              supabase/functions/send-push. If that function or the
 *              VAPID key is not set up, or the browser does not support
 *              push, everything degrades to layer 1 and the settings
 *              screen says so plainly.
 *
 * Permission is never requested silently: enablePush() is only ever
 * called from a button the user pressed.
 */
import { sb, errorMessage } from './supabase.js';
import { CONFIG } from './config.js';

/* ------------------------------------------------------------------ */
/* In-app notifications                                                */
/* ------------------------------------------------------------------ */

export async function getNotifications(userId, { limit = 30 } = {}) {
  const { data, error } = await sb
    .from('notifications')
    .select('id, title, message, type, read, request_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(errorMessage(error, 'Could not load your notifications.'));
  return data ?? [];
}

export async function unreadCount(userId) {
  const { count, error } = await sb
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('read', false);
  if (error) {
    console.warn('unreadCount', error);
    return 0;
  }
  return count ?? 0;
}

export async function markRead(ids = null) {
  const { error } = await sb.rpc('mark_notifications_read', { p_ids: ids });
  if (error) throw new Error(errorMessage(error, 'Could not mark those as read.'));
}

/* ------------------------------------------------------------------ */
/* Capability checks                                                   */
/* ------------------------------------------------------------------ */

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const pushConfigured = () => Boolean(CONFIG.vapidPublicKey);

/** 'default' | 'granted' | 'denied' | 'unsupported' */
export function permissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/**
 * iOS only allows push for an app added to the Home Screen. Telling the
 * user that up front is much kinder than a permission prompt that fails.
 */
export function needsInstallFirst() {
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return iOS && !standalone;
}

/* ------------------------------------------------------------------ */
/* Web Push subscription                                               */
/* ------------------------------------------------------------------ */

async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.ready;
}

export async function isPushEnabled() {
  if (!pushSupported()) return false;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  return Boolean(sub);
}

/**
 * Asks for permission and stores the subscription. Must be called from a
 * user gesture. Returns a short explanation when it cannot be done.
 */
export async function enablePush() {
  if (!pushSupported()) {
    throw new Error('This browser cannot show notifications when the app is closed. You will still see alerts while the app is open.');
  }
  if (needsInstallFirst()) {
    throw new Error('On iPhone and iPad, add this app to your Home Screen first (Share → Add to Home Screen), then turn notifications on from there.');
  }
  if (!pushConfigured()) {
    throw new Error('Push notifications are not configured for this installation yet. In-app alerts are working normally.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notifications are blocked. You can allow them in your browser settings for this site.');
  }

  const reg = await registration();
  if (!reg) throw new Error('The offline service worker is not ready yet. Reload the page and try again.');

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(CONFIG.vapidPublicKey)
    });
  }

  const json = sub.toJSON();
  const { error } = await sb.rpc('save_push_subscription', {
    p_endpoint: sub.endpoint,
    p_p256dh: json.keys?.p256dh ?? null,
    p_auth: json.keys?.auth ?? null,
    p_user_agent: navigator.userAgent
  });
  if (error) {
    await sub.unsubscribe().catch(() => {});
    throw new Error(errorMessage(error, 'Could not save your notification settings.'));
  }
  return true;
}

export async function disablePush() {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;

  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  const { error } = await sb.rpc('delete_push_subscription', { p_endpoint: endpoint });
  if (error) console.warn('delete_push_subscription', error);
}

/**
 * A local notification for something that happened while the app is open
 * but hidden (another tab, screen locked with the tab alive). This is a
 * real notification, not a simulated one — if permission was never
 * granted it simply does nothing.
 */
export async function showLocalNotification(title, body, data = {}) {
  if (permissionState() !== 'granted') return false;
  try {
    const reg = await registration();
    if (!reg) return false;
    await reg.showNotification(title, {
      body,
      icon: 'assets/icons/icon-192.png',
      badge: 'assets/icons/badge.png',
      tag: data.tag || 'wih',
      renotify: Boolean(data.tag),
      data
    });
    return true;
  } catch (err) {
    console.warn('showNotification', err);
    return false;
  }
}

/** VAPID keys are base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/* ------------------------------------------------------------------ */
/* Status summary for the settings screen                              */
/* ------------------------------------------------------------------ */

export async function describePushSetup() {
  if (!pushSupported()) {
    return { level: 'unsupported', text: 'This browser cannot deliver notifications when the app is closed. In-app alerts still work.' };
  }
  if (needsInstallFirst()) {
    return { level: 'install', text: 'Add this app to your Home Screen first, then notifications can be switched on.' };
  }
  if (!pushConfigured()) {
    return { level: 'not-configured', text: 'Push is not configured for this installation (no VAPID key). In-app alerts work normally.' };
  }
  if (permissionState() === 'denied') {
    return { level: 'blocked', text: 'Notifications are blocked in your browser settings for this site.' };
  }
  if (await isPushEnabled()) {
    return { level: 'on', text: 'This device will receive notifications even when the app is closed.' };
  }
  return { level: 'off', text: 'Notifications are off on this device.' };
}
