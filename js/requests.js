/**
 * Service requests: creating them, reading them and moving them through
 * their lifecycle.
 *
 * Every write is an RPC. The browser cannot insert or update a request
 * row directly — those grants are revoked in rls.sql.
 */
import { sb, errorMessage } from './supabase.js';
import { PRIORITY_META } from './config.js';

const REQUEST_COLUMNS = `
  id, request_number, requester_id, requester_name_snapshot,
  location_building_id, custom_location, location_name_snapshot,
  category_task_id, custom_category, category_name_snapshot,
  description, priority, status, queue_position, assigned_to,
  created_at, accepted_at, started_at, completed_at, cancelled_at, updated_at
`;

export const OPEN_STATUSES = ['pending', 'accepted', 'in_progress'];
export const CLOSED_STATUSES = ['completed', 'rejected', 'cancelled'];

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

export async function createRequest(input) {
  const customLocation = trimOrNull(input.customLocation);
  const customCategory = trimOrNull(input.customCategory);
  const description = trimOrNull(input.description);
  const priority = String(input.priority || 'normal');

  if (!PRIORITY_META[priority]) throw new Error('Please choose a priority.');
  if (!input.buildingId && !customLocation) throw new Error('Please choose where you are.');
  if (!input.taskId && !customCategory) throw new Error('Please choose what you need.');
  if (customLocation && customLocation.length > 80) throw new Error('That location name is too long (80 characters maximum).');
  if (customCategory && customCategory.length > 80) throw new Error('That description is too long (80 characters maximum).');
  if (description && description.length > 1000) throw new Error('Please shorten the description (1000 characters maximum).');

  const { data, error } = await sb.rpc('create_service_request', {
    p_building_id:     customLocation ? null : (input.buildingId || null),
    p_custom_location: customLocation,
    p_task_id:         customCategory ? null : (input.taskId || null),
    p_custom_category: customCategory,
    p_description:     description,
    p_priority:        priority
  });
  if (error) throw new Error(errorMessage(error, 'Your request could not be submitted. Please try again.'));
  return data;
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/** The signed-in employee's own requests (RLS restricts this to them). */
export async function getMyRequests(userId, { limit = 50 } = {}) {
  const { data, error } = await sb
    .from('service_requests')
    .select(REQUEST_COLUMNS)
    .eq('requester_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(errorMessage(error, 'Could not load your requests.'));
  return data ?? [];
}

/** Everything still open, for Haitham's queue. */
export async function getOpenRequests() {
  const { data, error } = await sb
    .from('service_requests')
    .select(REQUEST_COLUMNS)
    .in('status', OPEN_STATUSES)
    .order('queue_position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(errorMessage(error, 'Could not load the queue.'));
  return sortQueue(data ?? []);
}

/** Requests in a period, for reports and for the closed-request list. */
export async function getRequestsBetween(from, to, { limit = 2000 } = {}) {
  const { data, error } = await sb
    .from('service_requests')
    .select(REQUEST_COLUMNS)
    .gte('created_at', from.toISOString())
    .lt('created_at', to.toISOString())
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(errorMessage(error, 'Could not load the requests.'));
  return data ?? [];
}

export async function getRequestById(id) {
  const { data, error } = await sb
    .from('service_requests')
    .select(REQUEST_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(errorMessage(error, 'Could not load that request.'));
  return data ?? null;
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

export const requestLocation = r => r.location_name_snapshot || r.custom_location || 'Not stated';
export const requestCategory = r => r.category_name_snapshot || r.custom_category || 'Not stated';

const trimOrNull = v => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};
