/**
 * Supabase Realtime subscriptions.
 *
 * Nothing in this app polls. Every screen subscribes to the tables it
 * cares about and re-renders when the database tells it to. Realtime
 * honours RLS, so an employee's socket only ever carries rows they are
 * allowed to see.
 *
 * The one thing we *do* run on a timer is the clock/expiry tick, which
 * is pure presentation and never touches the network.
 */
import { sb } from './supabase.js';
import { invalidate } from './data.js';

const channels = new Map();

function channel(name, build) {
  if (channels.has(name)) return channels.get(name);

  const ch = sb.channel(name);
  build(ch);
  ch.subscribe(status => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      console.warn(`[realtime] ${name}: ${status} — the client will retry automatically.`);
    }
  });
  channels.set(name, ch);
  return ch;
}

/* ------------------------------------------------------------------ */
/* Public board — one row, already privacy-filtered by the database    */
/* ------------------------------------------------------------------ */

export function subscribeBoard(onSnapshot) {
  return channel('board', ch =>
    ch.on('postgres_changes',
      { event: '*', schema: 'public', table: 'public_board' },
      payload => {
        const snapshot = payload.new?.snapshot;
        if (snapshot) onSnapshot(snapshot);
      })
  );
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

/** Admin: every request change. */
export function subscribeAllRequests(onChange) {
  return channel('requests-all', ch =>
    ch.on('postgres_changes',
      { event: '*', schema: 'public', table: 'service_requests' },
      payload => onChange(payload.eventType, payload.new ?? payload.old))
  );
}

/** Employee: only their own rows are delivered, because RLS filters them. */
export function subscribeMyRequests(userId, onChange) {
  return channel(`requests-mine-${userId}`, ch =>
    ch.on('postgres_changes',
      { event: '*', schema: 'public', table: 'service_requests', filter: `requester_id=eq.${userId}` },
      payload => onChange(payload.eventType, payload.new ?? payload.old))
  );
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export function subscribeNotifications(userId, onInsert) {
  return channel(`notifications-${userId}`, ch =>
    ch.on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      payload => onInsert(payload.new))
  );
}

/* ------------------------------------------------------------------ */
/* Tracked status (admin screens need the raw row, not the snapshot)   */
/* ------------------------------------------------------------------ */

export function subscribeCurrentStatus(onChange) {
  return channel('current-status', ch =>
    ch.on('postgres_changes',
      { event: '*', schema: 'public', table: 'current_status' },
      payload => onChange(payload.new ?? null))
  );
}

/* ------------------------------------------------------------------ */
/* Configuration (buildings / tasks) — keeps every open tab in step    */
/* ------------------------------------------------------------------ */

export function subscribeConfig(onChange) {
  return channel('config', ch => {
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'buildings' }, () => {
      invalidate('buildings');
      onChange?.('buildings');
    });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
      invalidate('tasks');
      onChange?.('tasks');
    });
  });
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/**
 * Phones suspend sockets in the background. When the tab comes back we
 * ask the caller to re-fetch once, so the screen is never quietly stale.
 */
export function onResume(callback) {
  const handler = () => { if (document.visibilityState === 'visible') callback(); };
  document.addEventListener('visibilitychange', handler);
  addEventListener('online', callback);
  return () => {
    document.removeEventListener('visibilitychange', handler);
    removeEventListener('online', callback);
  };
}

export function unsubscribeAll() {
  channels.forEach(ch => sb.removeChannel(ch));
  channels.clear();
}

addEventListener('pagehide', () => unsubscribeAll());
