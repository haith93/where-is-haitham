/**
 * Service requests: creating them, reading them and moving them through
 * their lifecycle.
 *
 * Every write is an RPC. The browser cannot insert or update a request
 * row directly — those grants are revoked in rls.sql.
 */
import { sb, errorMessage } from './supabase.js';
import { PRIORITY_META, CHANNEL_KEYS } from './config.js';
import { prefs } from './utils.js';
import { getLang } from './i18n.js';

const REQUEST_COLUMNS = `
  id, request_number, requester_id, requester_name_snapshot,
  location_building_id, custom_location, location_name_snapshot,
  category_task_id, custom_category, category_name_snapshot,
  description, priority, status, queue_position, assigned_to,
  created_at, accepted_at, started_at, completed_at, cancelled_at, updated_at,
  channel, notes, created_by,
  location_name_ar_snapshot, category_name_ar_snapshot
`;

/* Columns added by later migrations. If Supabase has not caught up with the
   deployed frontend, drop back to the original set rather than letting the
   queue screen fail outright. */
const REQUEST_COLUMNS_BASE = `
  id, request_number, requester_id, requester_name_snapshot,
  location_building_id, custom_location, location_name_snapshot,
  category_task_id, custom_category, category_name_snapshot,
  description, priority, status, queue_position, assigned_to,
  created_at, accepted_at, started_at, completed_at, cancelled_at, updated_at
`;

let requestColumns = REQUEST_COLUMNS;

async function queryRequests(shape, failureMessage) {
  const { data, error } = await shape(sb.from('service_requests').select(requestColumns));
  if (!error) return data ?? [];

  const missing = error?.code === '42703' || /column .* does not exist/i.test(error?.message ?? '');
  if (missing && requestColumns !== REQUEST_COLUMNS_BASE) {
    console.warn('[requests] falling back to the base column set; a SQL migration is pending in Supabase.');
    requestColumns = REQUEST_COLUMNS_BASE;
    const retry = await shape(sb.from('service_requests').select(requestColumns));
    if (!retry.error) return retry.data ?? [];
    throw new Error(errorMessage(retry.error, failureMessage));
  }
  throw new Error(errorMessage(error, failureMessage));
}

export const OPEN_STATUSES = ['pending', 'accepted', 'in_progress'];
export const CLOSED_STATUSES = ['completed', 'rejected', 'cancelled'];

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

/**
 * Submit a request as an anonymous visitor.
 *
 * No account, no session. The RPC validates everything, rate-limits by
 * device, and returns only what the requester needs — including a token
 * that lets this device follow the request afterwards.
 */
export async function createPublicRequest(input) {
  const name = String(input.requesterName ?? '').trim().replace(/\s+/g, ' ');
  const customLocation = trimOrNull(input.customLocation);
  const customCategory = trimOrNull(input.customCategory);
  const description = trimOrNull(input.description);
  const priority = String(input.priority || 'normal');

  if (name.length < 2) throw new Error('Please enter your name.');
  if (name.length > 120) throw new Error('That name is too long.');
  if (!PRIORITY_META[priority]) throw new Error('Please choose a priority.');
  if (!input.buildingId && !customLocation) throw new Error('Please choose where you are.');
  if (!input.taskId && !customCategory) throw new Error('Please choose what you need.');
  if (description && description.length > 1000) throw new Error('Please shorten the description (1000 characters maximum).');

  const { data, error } = await sb.rpc('create_public_request', {
    p_requester_name:  name,
    p_building_id:     customLocation ? null : (input.buildingId || null),
    p_custom_location: customLocation,
    p_task_id:         customCategory ? null : (input.taskId || null),
    p_custom_category: customCategory,
    p_description:     description,
    p_priority:        priority,
    p_device_id:       deviceId()
  });
  if (error) throw new Error(errorMessage(error, 'Your request could not be submitted. Please try again.'));
  return data;
}

/**
 * Record a request that arrived by phone, WhatsApp or in person.
 * Produces exactly the same kind of record as an app request.
 */
export async function adminCreateRequest(input) {
  const name = String(input.requesterName ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new Error('Please enter who asked for help.');
  if (!CHANNEL_KEYS.includes(input.channel)) throw new Error('Please choose how the request arrived.');

  const customLocation = trimOrNull(input.customLocation);
  const customCategory = trimOrNull(input.customCategory);

  if (!input.buildingId && !customLocation) throw new Error('Please choose a location.');
  if (!input.taskId && !customCategory) throw new Error('Please choose what they need.');

  const { data, error } = await sb.rpc('admin_create_request', {
    p_requester_name:   name,
    p_channel:          input.channel,
    p_building_id:      customLocation ? null : (input.buildingId || null),
    p_custom_location:  customLocation,
    p_task_id:          customCategory ? null : (input.taskId || null),
    p_custom_category:  customCategory,
    p_description:      trimOrNull(input.description),
    p_priority:         String(input.priority || 'normal'),
    p_notes:            trimOrNull(input.notes),
    p_start_now:        Boolean(input.startNow),
    p_duration_minutes: input.durationMinutes ?? null
  });
  if (error) throw new Error(errorMessage(error, 'Could not record that request.'));
  return data;
}

/* ------------------------------------------------------------------ */
/* Following your own requests, with no account                        */
/*                                                                     */
/* Creation returns an unguessable token. We keep the tokens for this  */
/* device in localStorage — a convenience, not a security boundary:    */
/* the token itself is what the database checks.                      */
/* ------------------------------------------------------------------ */

const TOKENS_KEY = 'myRequests';

export function rememberRequest(result) {
  if (!result?.public_token) return;
  const list = prefs.get(TOKENS_KEY, []);
  const next = [
    { token: result.public_token, number: result.request_number, at: result.created_at },
    ...list.filter(r => r.token !== result.public_token)
  ].slice(0, 20);
  prefs.set(TOKENS_KEY, next);
}

export function forgetRequest(token) {
  prefs.set(TOKENS_KEY, prefs.get(TOKENS_KEY, []).filter(r => r.token !== token));
}

export function rememberedRequests() {
  return prefs.get(TOKENS_KEY, []);
}

/** Live status of every request this device has sent. */
export async function getMyDeviceRequests() {
  const stored = rememberedRequests();
  if (!stored.length) return [];

  const results = await Promise.all(stored.map(async entry => {
    const { data, error } = await sb.rpc('get_request_by_token', { p_token: entry.token });
    if (error || !data) return null;
    return { ...data, token: entry.token };
  }));

  return results.filter(Boolean);
}

export async function cancelMyRequest(token) {
  const { data, error } = await sb.rpc('cancel_request_by_token', { p_token: token });
  if (error) throw new Error(errorMessage(error, 'Could not cancel that request.'));
  return data;
}

/** Stable per-browser id used only for rate limiting. */
function deviceId() {
  let id = prefs.get('deviceId');
  if (!id) {
    id = (crypto.randomUUID?.() ?? `d-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    prefs.set('deviceId', id);
  }
  return id;
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/** Everything still open, for Haitham's queue. */
export async function getOpenRequests() {
  const rows = await queryRequests(
    q => q.in('status', OPEN_STATUSES)
          .order('queue_position', { ascending: true })
          .order('created_at', { ascending: true }),
    'Could not load the queue.'
  );
  return sortQueue(rows);
}

/** Requests in a period, for reports and for the closed-request list. */
export async function getRequestsBetween(from, to, { limit = 2000 } = {}) {
  return queryRequests(
    q => q.gte('created_at', from.toISOString())
          .lt('created_at', to.toISOString())
          .order('created_at', { ascending: false })
          .limit(limit),
    'Could not load the requests.'
  );
}

export async function getRequestById(id) {
  const rows = await queryRequests(q => q.eq('id', id), 'Could not load that request.');
  return rows[0] ?? null;
}

export async function getRequestTimeline(requestId) {
  const { data, error } = await sb
    .from('request_history')
    .select('id, old_status, new_status, notes, created_at')
    .eq('request_id', requestId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(errorMessage(error, 'Could not load the request history.'));
  return data ?? [];
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export async function acceptRequest(id, { travelNow = false, durationMinutes = null } = {}) {
  const { data, error } = await sb.rpc('accept_request', {
    p_request_id: id,
    p_travel_now: Boolean(travelNow),
    p_duration_minutes: durationMinutes ?? null
  });
  if (error) throw new Error(errorMessage(error, 'Could not accept that request.'));
  return data;
}

/** Starts the work AND moves the tracked status to that building. */
export async function startRequest(id, durationMinutes = null) {
  const { data, error } = await sb.rpc('start_request', {
    p_request_id: id,
    p_duration_minutes: durationMinutes ?? null
  });
  if (error) throw new Error(errorMessage(error, 'Could not start that request.'));
  return data;
}

export async function setRequestStatus(id, status, notes = null) {
  const { data, error } = await sb.rpc('set_request_status', {
    p_request_id: id,
    p_new_status: status,
    p_notes: trimOrNull(notes)
  });
  if (error) throw new Error(errorMessage(error, 'Could not update that request.'));
  return data;
}

export const completeRequest = (id, notes) => setRequestStatus(id, 'completed', notes);
export const rejectRequest   = (id, notes) => setRequestStatus(id, 'rejected', notes);
export const cancelRequest   = (id, notes) => setRequestStatus(id, 'cancelled', notes);

export async function setPriority(id, priority) {
  if (!PRIORITY_META[priority]) throw new Error('Unknown priority.');
  const { data, error } = await sb.rpc('set_request_priority', { p_request_id: id, p_priority: priority });
  if (error) throw new Error(errorMessage(error, 'Could not change the priority.'));
  return data;
}

export async function saveQueueOrder(ids) {
  const { error } = await sb.rpc('set_queue_order', { p_request_ids: ids });
  if (error) throw new Error(errorMessage(error, 'Could not save the new order.'));
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Queue order: work in progress first, then by priority, then by the
 * manual position, then oldest first. Nothing is auto-started — this is
 * only the order the list is displayed in.
 */
export function sortQueue(rows) {
  const statusRank = { in_progress: 0, accepted: 1, pending: 2 };
  return [...rows].sort((a, b) =>
    (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) ||
    (PRIORITY_META[a.priority] ?? PRIORITY_META.normal).rank -
    (PRIORITY_META[b.priority] ?? PRIORITY_META.normal).rank ||
    (a.queue_position - b.queue_position) ||
    new Date(a.created_at) - new Date(b.created_at)
  );
}

/** Minutes from creation to completion, for the reports. */
export function completionMinutes(request) {
  if (!request.completed_at) return null;
  return Math.round((new Date(request.completed_at) - new Date(request.created_at)) / 60000);
}

export const requestLocation = r =>
  (getLang() === 'ar' ? (r.location_name_ar_snapshot || r.location_ar) : null)
  || r.location_name_snapshot || r.location || r.custom_location || 'Not stated';

export const requestCategory = r =>
  (getLang() === 'ar' ? (r.category_name_ar_snapshot || r.category_ar) : null)
  || r.category_name_snapshot || r.category || r.custom_category || 'Not stated';
export const requestChannel  = r => r.channel || 'app';

const trimOrNull = v => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};
