/**
 * Status: reading the board, updating it, and working out what the
 * current status *means* right now.
 *
 * The only thing the browser ever sends is a duration in minutes. The
 * database stamps started_at with now() and computes expected_end_at,
 * so a start or end time can never be typed by hand.
 */
import { sb, errorMessage } from './supabase.js';
import { STATUS_META } from './config.js';
import { toDate, minutesBetween, fmtTime, durationText } from './utils.js';

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** The privacy-filtered board: safe for employees and anonymous visitors. */
export async function getPublicStatus() {
  const { data, error } = await sb.rpc('get_public_status');
  if (error) throw new Error(errorMessage(error, 'Could not load the status board.'));
  return data ?? {};
}

/** The full current_status row. Admin only (RLS allows read to signed-in users). */
export async function getCurrentStatus(userId) {
  let query = sb
    .from('current_status')
    .select(`
      id, user_id, status_type, started_at, expected_end_at, updated_at,
      building_id, custom_location, location_name_snapshot,
      task_id, custom_task, task_name_snapshot,
      history_id, serving_request_id, next_request_id
    `)
    .limit(1);
  if (userId) query = query.eq('user_id', userId);

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(errorMessage(error, 'Could not load the current status.'));
  return data ?? null;
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {object} input
 * @param {string} input.statusType     one of STATUS_META
 * @param {string|null} input.buildingId
 * @param {string|null} input.customLocation
 * @param {string|null} input.taskId
 * @param {string|null} input.customTask
 * @param {number|null} input.durationMinutes  minutes only — never a clock time
 * @param {string|null} input.requestId
 */
export async function updateStatus(input) {
  const payload = normaliseStatusInput(input);

  const { data, error } = await sb.rpc('update_my_status', {
    p_status_type:      payload.statusType,
    p_building_id:      payload.buildingId,
    p_custom_location:  payload.customLocation,
    p_task_id:          payload.taskId,
    p_custom_task:      payload.customTask,
    p_duration_minutes: payload.durationMinutes,
    p_request_id:       payload.requestId
  });
  if (error) throw new Error(errorMessage(error, 'Unable to update your status. Please check your connection and try again.'));
  return data;
}

/** Big red "I am done with this" button: records the real end time. */
export async function finishCurrentTask() {
  const { data, error } = await sb.rpc('finish_current_task');
  if (error) throw new Error(errorMessage(error, 'Unable to finish the current task. Please try again.'));
  return data;
}

/** "Available now": no task, no duration, open ended. */
export async function setAvailableNow() {
  return updateStatus({ statusType: 'available' });
}

function normaliseStatusInput(input = {}) {
  const statusType = String(input.statusType || '').trim();
  if (!STATUS_META[statusType]) throw new Error('Please choose a status.');

  const customLocation = trimOrNull(input.customLocation);
  const customTask = trimOrNull(input.customTask);
  const buildingId = customLocation ? null : (input.buildingId || null);
  const taskId = customTask ? null : (input.taskId || null);

  if (customLocation && customLocation.length > 80) throw new Error('That location name is too long (80 characters maximum).');
  if (customTask && customTask.length > 80) throw new Error('That task name is too long (80 characters maximum).');

  let durationMinutes = input.durationMinutes == null || input.durationMinutes === ''
    ? null
    : Number(input.durationMinutes);
  if (durationMinutes != null) {
    if (!Number.isFinite(durationMinutes) || !Number.isInteger(durationMinutes)) {
      throw new Error('Enter the duration as a whole number of minutes.');
    }
    if (durationMinutes < 1 || durationMinutes > 1440) {
      throw new Error('Choose a duration between 1 minute and 24 hours.');
    }
  }

  // Statuses that describe work need somewhere to be.
  if (['busy', 'serving', 'traveling', 'meeting'].includes(statusType) && !buildingId && !customLocation) {
    throw new Error('Please choose where you are (or type a custom location).');
  }

  return {
    statusType, buildingId, customLocation, taskId, customTask, durationMinutes,
    requestId: input.requestId || null
  };
}

const trimOrNull = v => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
};

/* ------------------------------------------------------------------ */
/* Derived display state                                               */
/* ------------------------------------------------------------------ */

/**
 * Turns a raw status (from the board snapshot or from current_status)
 * into everything the UI needs, including whether it has run out.
 *
 * IMPORTANT: an expired status is never rewritten. We only *report* that
 * the expected time has passed — we never guess a new location, and we
 * never pretend expected_end_at was the actual end.
 */
export function describeStatus(status, now = new Date()) {
  if (!status || !status.status_type) {
    return {
      known: false,
      meta: { label: 'Not set yet', icon: '⚪', tone: 'muted', hint: 'No status has been posted yet.' },
      location: null, task: null,
      startedAt: null, expectedEndAt: null,
      expired: false, stale: false,
      rangeText: '', availabilityText: 'Unknown', elapsedText: ''
    };
  }

  const meta = STATUS_META[status.status_type] ?? STATUS_META.busy;
  const startedAt = toDate(status.started_at);
  const expectedEndAt = toDate(status.expected_end_at);
  const updatedAt = toDate(status.updated_at) || startedAt;

  const expired = Boolean(expectedEndAt && now.getTime() >= expectedEndAt.getTime());
  const minutesOver = expired ? minutesBetween(expectedEndAt, now) : 0;

  // "Stale" = expired a long time ago, or an open-ended busy status left
  // untouched for hours. Worth nudging about, still never auto-changed.
  const openTooLong = !expectedEndAt
    && ['busy', 'serving', 'traveling', 'meeting'].includes(status.status_type)
    && minutesBetween(startedAt, now) > 180;
  const stale = (expired && minutesOver > 15) || openTooLong;

  const isFree = status.status_type === 'available';
  const availabilityText = isFree
    ? 'Now'
    : expectedEndAt
      ? (expired ? `${fmtTime(expectedEndAt)} · passed` : fmtTime(expectedEndAt))
      : 'Not stated';

  return {
    known: true,
    meta,
    statusType: status.status_type,
    location: status.location || status.location_name_snapshot || status.custom_location || null,
    task: status.task || status.task_name_snapshot || status.custom_task || null,
    startedAt,
    expectedEndAt,
    updatedAt,
    expired,
    minutesOver,
    stale,
    isFree,
    rangeText: startedAt ? (expectedEndAt ? `${fmtTime(startedAt)} → ${fmtTime(expectedEndAt)}` : `${fmtTime(startedAt)} → open ended`) : '',
    availabilityText,
    elapsedText: startedAt ? durationText(minutesBetween(startedAt, now)) : ''
  };
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/**
 * Status history for a period. `from`/`to` are real Date objects built
 * from Asia/Beirut day boundaries by utils.startOfDay / endOfDay.
 */
export async function getStatusHistory(from, to, { limit = 1000 } = {}) {
  const { data, error } = await sb
    .from('status_history')
    .select(`
      id, status_type, started_at, expected_end_at, actual_end_at,
      duration_minutes, actual_minutes,
      building_id, custom_location, location_name_snapshot,
      task_id, custom_task, task_name_snapshot, request_id
    `)
    .gte('started_at', from.toISOString())
    .lt('started_at', to.toISOString())
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(errorMessage(error, 'Could not load the history.'));
  return data ?? [];
}

/** Display name helpers used by history and reports. */
export const historyLocation = row => row.location_name_snapshot || row.custom_location || 'Not stated';
export const historyTask     = row => row.task_name_snapshot || row.custom_task || null;

/**
 * Real minutes spent on a history row. Open rows count up to `now`, which
 * is what makes "today so far" honest. The chosen duration is never used
 * as if it were actual time.
 */
export function actualMinutes(row, now = new Date()) {
  if (row.actual_minutes != null) return Number(row.actual_minutes);
  const started = toDate(row.started_at);
  if (!started) return 0;
  return Math.max(0, minutesBetween(started, now));
}
