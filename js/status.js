/**
 * Status: reading the board, updating it, and working out what the
 * current status *means* right now.
 *
 * The only thing the browser ever sends is a duration in minutes. The
 * database stamps started_at with now() and computes expected_end_at,
 * so a start or end time can never be typed by hand.
 */
import { sb, errorMessage } from './supabase.js';
import { toneDot } from './icons.js';
import { STATUS_META } from './config.js';
import { toDate, minutesBetween, fmtTime, durationText, dayKey, endOfDay,
         startOfDay, addDays, weekdayName, fmtDateLong } from './utils.js';
import { getLang, t } from './i18n.js';

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
    p_request_id:       payload.requestId,
    p_back_at:          payload.backAt
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

  // A finished day is answered with a date, not a length. It is stored
  // as the start of that local day: "back Sunday" means the morning.
  let backAt = null;
  if (input.backOn) {
    const start = startOfDay(String(input.backOn));
    if (Number.isNaN(start?.getTime?.())) throw new Error('That is not a valid date.');
    backAt = start.toISOString();
  }

  return {
    statusType, buildingId, customLocation, taskId, customTask, durationMinutes,
    backAt,
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
/* When he is back, said the way a person would say it. No date given
   means he did not say, which is different from "tomorrow". */
export function backDayText(expectedEndAt) {
  if (!expectedEndAt) return t('board.notStated');
  const key = dayKey(expectedEndAt);
  if (key === addDays(dayKey(), 1)) return t('board.backTomorrow');
  if (key === dayKey()) return t('board.backToday');
  const date = startOfDay(key);
  return `${weekdayName(date)} ${fmtDateLong(date)}`;
}

/**
 * Which of the three "finished" messages fits: tomorrow, a later day,
 * or he did not say.
 */
export function backKind(expectedEndAt) {
  if (!expectedEndAt) return 'unknown';
  const key = dayKey(expectedEndAt);
  return key === addDays(dayKey(), 1) ? 'tomorrow' : 'later';
}

export function describeStatus(status, now = new Date()) {
  if (!status || !status.status_type) {
    return {
      known: false,
      meta: { label: 'Not set yet', icon: toneDot('muted-fill'), tone: 'muted', hint: 'No status has been posted yet.' },
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
  // A finished day with a return date is not an overrunning job: the
  // date is a plan, not a promise that has lapsed.
  const stale = status.status_type === 'done'
    ? false
    : (expired && minutesOver > 15) || openTooLong;

  const isFree = status.status_type === 'available';
  const availabilityText = isFree
    ? 'Now'
    : status.status_type === 'done'
      ? backDayText(expectedEndAt)
      : expectedEndAt
        ? (expired ? `${fmtTime(expectedEndAt)} · passed` : fmtTime(expectedEndAt))
        : 'Not stated';

  return {
    known: true,
    meta,
    statusType: status.status_type,
    location: pickName(status, 'location'),
    task: pickName(status, 'task'),
    startedAt,
    expectedEndAt,
    updatedAt,
    expired,
    minutesOver,
    stale,
    isFree,
    rangeText: !startedAt ? ''
      : status.status_type === 'done'
        ? `${t('board.dayOver')} · ${fmtTime(startedAt)}`
      : expectedEndAt ? `${fmtTime(startedAt)} → ${fmtTime(expectedEndAt)}`
      : `${fmtTime(startedAt)} → ${t('board.openEnded')}`,
    availabilityText,
    elapsedText: startedAt ? durationText(minutesBetween(startedAt, now)) : ''
  };
}

/**
 * Picks the Arabic or English name from whichever shape the caller has:
 * the board snapshot (`location` / `location_ar`) or a raw current_status
 * row (`location_name_snapshot` / `location_name_ar_snapshot`).
 */
function pickName(status, field) {
  const ar = getLang() === 'ar';
  const candidates = ar
    ? [status[`${field}_ar`], status[`${field}_name_ar_snapshot`],
       status[field], status[`${field}_name_snapshot`]]
    : [status[field], status[`${field}_name_snapshot`]];
  const custom = field === 'location' ? status.custom_location : status.custom_task;
  return candidates.find(v => v) || custom || null;
}

/** Clear the whole activity log. For test data, before going live. */
export async function purgeActivity() {
  const { data, error } = await sb.rpc('admin_purge_activity');
  if (error) throw new Error(errorMessage(error, 'Could not clear the activity log.'));
  return data;
}

/**
 * The status line to display. "With someone" is what the system knows;
 * "With Sarah Mansour" is what is actually useful to a colleague reading
 * the board, and it is already public in the queue below it.
 */
export function statusLabel(view, servingName) {
  if (view?.statusType === 'serving' && servingName) {
    return t('status.servingWith', { name: servingName });
  }
  return view?.meta?.label ?? '';
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
export const historyLocation = row =>
  (getLang() === 'ar' ? row.location_name_ar_snapshot : null)
  || row.location_name_snapshot || row.custom_location || 'Not stated';

export const historyTask = row =>
  (getLang() === 'ar' ? row.task_name_ar_snapshot : null)
  || row.task_name_snapshot || row.custom_task || null;

/**
 * Real minutes spent on a history row. Open rows count up to `now`, which
 * is what makes "today so far" honest. The chosen duration is never used
 * as if it were actual time.
 *
 * An open row never counts past midnight of the day it started. A status
 * left running overnight is a forgotten status, not a nineteen-hour job,
 * and reading it as the latter put "23 hours in the HS building" on a
 * report. Capping it is a guess, but it is a bounded one, and the row
 * still shows as "still open" in the activity export.
 */
export function actualMinutes(row, now = new Date()) {
  if (row.actual_minutes != null) return Number(row.actual_minutes);
  const started = toDate(row.started_at);
  if (!started) return 0;
  const midnight = endOfDay(dayKey(started));
  const until = now < midnight ? now : midnight;
  return Math.max(0, minutesBetween(started, until));
}
