/**
 * Reporting.
 *
 * Reports are derived from the historical tables — nothing is entered by
 * hand and nothing is pre-aggregated, so a report always reflects what
 * actually happened.
 *
 * The volume is small (one technician, a few dozen requests a day), so
 * the rows for the period are fetched once and aggregated in the browser.
 * That keeps every filter combination instant and avoids a pile of
 * single-purpose SQL.
 *
 * KEY RULE: time spent is measured with actual_end_at - started_at.
 * The duration Haitham picked is only an *expectation* and is reported
 * separately, so "planned 10 minutes, actually took 17" stays visible.
 */
import {
  startOfDay, endOfDay, daysBetween, dayKey, durationText,
  fmtDateLong, fmtDateTime, fmtTime, weekdayName, toCSV, downloadFile
} from './utils.js';
import { getStatusHistory, historyLocation, historyTask, actualMinutes } from './status.js';
import { getRequestsBetween, completionMinutes, requestLocation, requestCategory } from './requests.js';
import { PRIORITY_META, REQUEST_STATUS_META, STATUS_META } from './config.js';

/** Status types that do not count as working time. */
const NON_WORK = new Set(['break', 'offsite', 'done']);

/* ------------------------------------------------------------------ */
/* Building a report                                                   */
/* ------------------------------------------------------------------ */

/**
 * @param {string} fromKey  'YYYY-MM-DD' in Asia/Beirut, inclusive
 * @param {string} toKey    'YYYY-MM-DD' in Asia/Beirut, inclusive
 * @param {object} filters  { buildingId, taskId, priority, status }
 */
export async function buildReport(fromKey, toKey, filters = {}) {
  const from = startOfDay(fromKey);
  const to = endOfDay(toKey);
  const now = new Date();

  const [historyRaw, requestsRaw] = await Promise.all([
    getStatusHistory(from, to),
    getRequestsBetween(from, to)
  ]);

  const history = historyRaw.filter(row => {
    if (filters.buildingId && row.building_id !== filters.buildingId) return false;
    if (filters.taskId && row.task_id !== filters.taskId) return false;
    return true;
  });

  const requests = requestsRaw.filter(row => {
    if (filters.buildingId && row.location_building_id !== filters.buildingId) return false;
    if (filters.taskId && row.category_task_id !== filters.taskId) return false;
    if (filters.priority && row.priority !== filters.priority) return false;
    if (filters.status && row.status !== filters.status) return false;
    return true;
  });

  const days = daysBetween(fromKey, toKey);

  /* ---- time ---- */
  let trackedMinutes = 0;
  let workingMinutes = 0;
  const byLocation = new Map();
  const byTaskDuration = new Map();
  const byTaskCount = new Map();
  const byStatusType = new Map();

  let expectedTotal = 0;
  let expectedComparableActual = 0;
  let comparableCount = 0;
  let overrunCount = 0;

  for (const row of history) {
    const minutes = actualMinutes(row, now);
    trackedMinutes += minutes;
    if (!NON_WORK.has(row.status_type)) workingMinutes += minutes;

    add(byStatusType, STATUS_META[row.status_type]?.label ?? row.status_type, minutes);
    add(byLocation, historyLocation(row), minutes);

    const task = historyTask(row);
    if (task) {
      add(byTaskDuration, task, minutes);
      add(byTaskCount, task, 1);
    }

    // Expected vs actual, only for finished rows that had an expectation.
    if (row.duration_minutes != null && row.actual_minutes != null) {
      expectedTotal += Number(row.duration_minutes);
      expectedComparableActual += Number(row.actual_minutes);
      comparableCount += 1;
      if (Number(row.actual_minutes) > Number(row.duration_minutes) + 2) overrunCount += 1;
    }
  }

  /* ---- requests ---- */
  const counts = {
    total: requests.length,
    completed: requests.filter(r => r.status === 'completed').length,
    pending: requests.filter(r => r.status === 'pending').length,
    accepted: requests.filter(r => r.status === 'accepted').length,
    inProgress: requests.filter(r => r.status === 'in_progress').length,
    cancelled: requests.filter(r => r.status === 'cancelled').length,
    rejected: requests.filter(r => r.status === 'rejected').length,
    urgent: requests.filter(r => r.priority === 'urgent').length,
    veryUrgent: requests.filter(r => r.priority === 'very_urgent').length,
    normal: requests.filter(r => r.priority === 'normal').length
  };

  const completionTimes = requests.map(completionMinutes).filter(v => v != null);
  const avgCompletion = completionTimes.length
    ? Math.round(completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length)
    : null;

  const responseTimes = requests
    .filter(r => r.accepted_at)
    .map(r => Math.round((new Date(r.accepted_at) - new Date(r.created_at)) / 60000));
  const avgResponse = responseTimes.length
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
    : null;

  const byCategory = new Map();
  const byRequestLocation = new Map();
  const byDay = new Map(days.map(d => [d, 0]));

  for (const r of requests) {
    add(byCategory, requestCategory(r), 1);
    add(byRequestLocation, requestLocation(r), 1);
    const key = dayKey(r.created_at);
    if (byDay.has(key)) byDay.set(key, byDay.get(key) + 1);
  }

  return {
    range: { fromKey, toKey, from, to, days, dayCount: days.length },
    filters,
    history,
    requests,

    time: {
      trackedMinutes: Math.round(trackedMinutes),
      workingMinutes: Math.round(workingMinutes),
      byLocation: sortDesc(byLocation),
      byTaskDuration: sortDesc(byTaskDuration),
      byTaskCount: sortDesc(byTaskCount),
      byStatusType: sortDesc(byStatusType),
      activityCount: history.length
    },

    expectation: {
      comparableCount,
      avgExpected: comparableCount ? Math.round(expectedTotal / comparableCount) : null,
      avgActual: comparableCount ? Math.round(expectedComparableActual / comparableCount) : null,
      overrunCount
    },

    counts,
    avgCompletion,
    avgResponse,
    perDay: counts.total && days.length ? Math.round((counts.total / days.length) * 10) / 10 : 0,

    breakdown: {
      byCategory: sortDesc(byCategory),
      byLocation: sortDesc(byRequestLocation),
      byDay: days.map(d => ({ key: d, value: byDay.get(d) ?? 0 })),
      byPriority: [
        { key: 'very_urgent', label: PRIORITY_META.very_urgent.label, value: counts.veryUrgent, tone: 'danger' },
        { key: 'urgent',      label: PRIORITY_META.urgent.label,      value: counts.urgent,     tone: 'urgent' },
        { key: 'normal',      label: PRIORITY_META.normal.label,      value: counts.normal,     tone: 'warn' }
      ],
      byStatus: Object.entries(REQUEST_STATUS_META).map(([key, meta]) => ({
        key, label: meta.label, value: requests.filter(r => r.status === key).length
      })).filter(row => row.value > 0)
    },

    highlights: {
      mostCommonTask: topOf(byTaskCount),
      mostActiveLocation: topOf(byLocation),
      busiestDay: days.length > 1
        ? days.map(d => ({ key: d, value: byDay.get(d) ?? 0 })).sort((a, b) => b.value - a.value)[0]
        : null
    }
  };
}

function add(map, key, amount) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortDesc(map) {
  return [...map.entries()]
    .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }))
    .sort((a, b) => b.value - a.value);
}

function topOf(map) {
  const rows = sortDesc(map);
  return rows.length ? rows[0] : null;
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

export function reportTitle(report) {
  const { fromKey, toKey } = report.range;
  if (fromKey === toKey) return fmtDateLong(startOfDay(fromKey));
  return `${fmtDateLong(startOfDay(fromKey))} — ${fmtDateLong(startOfDay(toKey))}`;
}

/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */

export function exportSummaryCSV(report) {
  const rows = [
    ['Where Is Haitham Now? — report'],
    ['Period', reportTitle(report)],
    ['Days in period', report.range.dayCount],
    ['Generated', fmtDateTime(new Date())],
    [],
    ['ACTIVITY'],
    ['Total tracked time', durationText(report.time.trackedMinutes)],
    ['Working time (excludes break / off site / finished)', durationText(report.time.workingMinutes)],
    ['Status changes recorded', report.time.activityCount],
    [],
    ['EXPECTED VS ACTUAL'],
    ['Comparable finished activities', report.expectation.comparableCount],
    ['Average expected duration (min)', report.expectation.avgExpected ?? ''],
    ['Average actual duration (min)', report.expectation.avgActual ?? ''],
    ['Activities that ran over', report.expectation.overrunCount],
    [],
    ['SERVICE REQUESTS'],
    ['Total', report.counts.total],
    ['Completed', report.counts.completed],
    ['Pending', report.counts.pending],
    ['Accepted', report.counts.accepted],
    ['In progress', report.counts.inProgress],
    ['Cancelled', report.counts.cancelled],
    ['Rejected', report.counts.rejected],
    ['Urgent', report.counts.urgent],
    ['Very urgent', report.counts.veryUrgent],
    ['Average per day', report.perDay],
    ['Average time to accept (min)', report.avgResponse ?? ''],
    ['Average time to complete (min)', report.avgCompletion ?? ''],
    [],
    ['TIME BY LOCATION'],
    ['Location', 'Minutes', 'Readable'],
    ...report.time.byLocation.map(r => [r.label, r.value, durationText(r.value)]),
    [],
    ['TIME BY TASK'],
    ['Task', 'Minutes', 'Readable'],
    ...report.time.byTaskDuration.map(r => [r.label, r.value, durationText(r.value)]),
    [],
    ['TASKS BY COUNT'],
    ['Task', 'Times'],
    ...report.time.byTaskCount.map(r => [r.label, r.value]),
    [],
    ['REQUESTS BY CATEGORY'],
    ['Category', 'Requests'],
    ...report.breakdown.byCategory.map(r => [r.label, r.value]),
    [],
    ['REQUESTS BY LOCATION'],
    ['Location', 'Requests'],
    ...report.breakdown.byLocation.map(r => [r.label, r.value]),
    [],
    ['REQUESTS PER DAY'],
    ['Day', 'Weekday', 'Requests'],
    ...report.breakdown.byDay.map(d => [d.key, weekdayName(startOfDay(d.key)), d.value])
  ];
  downloadFile(`haitham-report-${report.range.fromKey}_to_${report.range.toKey}.csv`, toCSV(rows));
}

export function exportRequestsCSV(report) {
  const rows = [
    ['Request number', 'Created', 'Requester', 'Location', 'Category', 'Priority',
     'Status', 'Description', 'Accepted', 'Started', 'Completed', 'Minutes to accept', 'Minutes to complete'],
    ...report.requests.map(r => [
      r.request_number,
      fmtDateTime(r.created_at),
      r.requester_name_snapshot,
      requestLocation(r),
      requestCategory(r),
      PRIORITY_META[r.priority]?.label ?? r.priority,
      REQUEST_STATUS_META[r.status]?.label ?? r.status,
      r.description ?? '',
      r.accepted_at ? fmtDateTime(r.accepted_at) : '',
      r.started_at ? fmtDateTime(r.started_at) : '',
      r.completed_at ? fmtDateTime(r.completed_at) : '',
      r.accepted_at ? Math.round((new Date(r.accepted_at) - new Date(r.created_at)) / 60000) : '',
      completionMinutes(r) ?? ''
    ])
  ];
  downloadFile(`haitham-requests-${report.range.fromKey}_to_${report.range.toKey}.csv`, toCSV(rows));
}

export function exportActivityCSV(report) {
  const rows = [
    ['Date', 'Started', 'Expected end', 'Actual end', 'Status', 'Location', 'Task',
     'Expected minutes', 'Actual minutes', 'Difference'],
    ...report.history.map(row => {
      const expected = row.duration_minutes ?? '';
      const actual = row.actual_minutes ?? '';
      return [
        dayKey(row.started_at),
        fmtTime(row.started_at),
        row.expected_end_at ? fmtTime(row.expected_end_at) : '',
        row.actual_end_at ? fmtTime(row.actual_end_at) : 'still open',
        STATUS_META[row.status_type]?.label ?? row.status_type,
        historyLocation(row),
        historyTask(row) ?? '',
        expected,
        actual,
        expected !== '' && actual !== '' ? Math.round((actual - expected) * 10) / 10 : ''
      ];
    })
  ];
  downloadFile(`haitham-activity-${report.range.fromKey}_to_${report.range.toKey}.csv`, toCSV(rows));
}
