/**
 * admin.html controller — Haitham's own console.
 *
 * Built thumb-first: the status update is three taps (status, place,
 * duration) and the queue actions are one tap each. Sections are switched
 * with hash routing so the whole thing stays a single static page that
 * GitHub Pages can serve.
 */
import { configured } from './supabase.js';
import { STATUS_META, PRIORITY_META, REQUEST_STATUS_META, CHANNELS } from './config.js';
import { icon, paintIcons } from './icons.js';
import { availabilityMessage } from './messages.js';
import { t, apply as applyI18n, applyDocument, initLangToggle, onLangChange, getLang } from './i18n.js';
import {
  $, $$, esc, el, fmtTime, fmtDateTime, fmtDateLong, fmtDateShort, relativeTime,
  durationText, dayKey, addDays, startOfWeek, startOfMonth, startOfDay, endOfDay,
  minutesBetween, prefs, weekdayName
} from './utils.js';
import {
  initTheme, initThemeToggle, initOffline, initSheets, openSheet, closeSheet,
  startClock, toast, toastOk, toastError, withBusy, confirmAction, chooseAction,
  renderEmpty, renderError, renderSetupNeeded, registerServiceWorker
} from './ui.js';
import { requireAuth, signOut, NotAdminError } from './auth.js';
import {
  getBuildings, getTasks, addBuilding, addTask, updateBuilding, updateTask,
  moveItem, getUsers, setUserActive, setUserRole, getSettings, saveSetting, getAuditLog,
  localName
} from './data.js';
import {
  getCurrentStatus, updateStatus, finishCurrentTask, setAvailableNow,
  describeStatus, statusLabel, getStatusHistory, historyLocation, historyTask,
  actualMinutes, purgeActivity
} from './status.js';
import {
  getOpenRequests, getRequestsBetween, acceptRequest, startRequest,
  completeRequest, rejectRequest, setPriority, saveQueueOrder, sortQueue,
  requestLocation, requestCategory, requestChannel, adminCreateRequest,
  pauseRequest, resumeRequest, deleteRequest, purgeRequests,
  getRequestTimeline, OPEN_STATUSES
} from './requests.js';
import {
  subscribeAllRequests, subscribeCurrentStatus, subscribeConfig,
  subscribeNotifications, onResume
} from './realtime.js';
import {
  getNotifications, unreadCount, markRead, describePushSetup,
  enablePush, disablePush, showLocalNotification,
  refreshPushSubscription, registeredDeviceCount
} from './notifications.js';
import { buildReport, reportTitle, exportSummaryCSV, exportRequestsCSV, exportActivityCSV } from './reports.js';
import { barChart, proportionBars } from './charts.js';

/* ================================================================== */
/* State                                                              */
/* ================================================================== */

const state = {
  profile: null,
  settings: null,
  current: null,
  openRequests: [],
  closedRequests: [],
  requestFilter: 'open',
  duration: prefs.get('lastDuration', 15),
  section: 'dashboard',
  report: null,
  reportPeriod: 'today',
  reportRange: { from: dayKey(), to: dayKey() },
  reportFilters: {},
  historyRows: [],
  booted: false
};

let previewTimer = null;

/* ================================================================== */
/* Boot                                                               */
/* ================================================================== */

applyDocument();
paintIcons();
initTheme();
initThemeToggle();
initLangToggle();
initOffline(online => { if (online && configured && state.booted) refreshAll(); });
initSheets();
startClock('#clock');
registerServiceWorker();

if (!configured) {
  $('#setup-needed').hidden = false;
  renderSetupNeeded($('#setup-needed'));
} else {
  boot().catch(err => {
    console.error('[admin] boot failed', err);
    if (err instanceof NotAdminError) {
      const who = err.profile?.email || err.profile?.full_name || '';
      showBootError(t('admin.notAdmin', { who }), { retry: false });
      return;
    }
    showBootError(err?.message || t('error.generic'));
  });
}

/**
 * A blank screen is never an acceptable outcome. If start-up fails, or
 * simply never finishes, say so on the page instead of leaving an empty
 * shell behind.
 */
function showBootError(message, { retry = true } = {}) {
  const host = $('#setup-needed');
  if (!host) return;
  host.hidden = false;
  host.innerHTML = `
    <div class="notice notice-danger" style="margin-top:20px">
      <p style="font-weight:700;margin-bottom:6px">${esc(t('error.bootTitle'))}</p>
      <p>${esc(message)}</p>
    </div>`;
  if (retry) {
    host.append(el('button', {
      class: 'btn btn-primary btn-block',
      type: 'button',
      text: t('action.reload'),
      style: 'margin-top:12px',
      onclick: () => location.reload()
    }));
  }

  // Always offered, whether or not reloading could help: it is the way
  // out of both a stuck session and a signed-in-as-the-wrong-account
  // dead end. Reloading alone fixes neither.
  host.append(el('button', {
    class: 'btn btn-soft btn-block',
    type: 'button',
    text: t('admin.signOutAndIn'),
    style: 'margin-top:8px',
    onclick: async () => {
      try { await signOut(); } catch { /* clearing local state is enough */ }
      try {
        Object.keys(localStorage)
          .filter(k => k.startsWith('sb-') || k === 'wih.auth')
          .forEach(k => localStorage.removeItem(k));
      } catch { /* private mode */ }
      location.replace('staff.html');
    }
  }));
}

/** Wiring one section must never be able to blank the whole console. */
function safe(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[admin] could not wire ${label}`, err);
    toastError(`The ${label} screen did not load correctly. Try reloading.`);
  }
}

async function boot() {
  // If sign-in checks stall (an unreachable project, a blocked request),
  // surface it rather than sitting on an empty page for ever.
  const watchdog = setTimeout(() => {
    if (!state.booted) {
      showBootError('The server did not respond. Check your connection, then reload.');
    }
  }, 12000);

  try {
    state.profile = await requireAuth({ admin: true });
  } finally {
    clearTimeout(watchdog);
  }
  if (!state.profile) return;                 // requireAuth already redirected

  state.booted = true;
  $('#shell').hidden = false;
  state.settings = await getSettings();

  // Re-render everything JavaScript drew when the language changes.
  onLangChange(() => {
    applyI18n(document);
    paintCurrent();
    paintQueue();
    paintQueueBadges();
    paintDashboardExtras();
    // Re-render whichever section is on screen. Buildings, tasks and
    // users carry names that differ per language, so they need it too.
    if (state.section === 'buildings') paintBuildings();
    if (state.section === 'tasks')     paintTasks();
    if (state.section === 'users')     paintUsers();
    if (state.section === 'status')    fillStatusSelects();
    if (state.section === 'reports' && state.report) paintReport(state.report);
    if (state.section === 'history')   paintHistory();
  });

  safe('navigation', wireRouter);
  safe('dashboard', wireDashboard);
  safe('status', wireStatusForm);
  safe('requests', wireRequests);
  safe('buildings', wireBuildings);
  safe('tasks', wireTasks);
  safe('users', wireUsers);
  safe('reports', wireReports);
  safe('history', wireHistory);
  safe('settings', wireSettings);
  safe('record a request', wireBehalf);
  safe('notifications', wireNotifications);

  await refreshAll();

  subscribeCurrentStatus(row => { state.current = row; paintCurrent(); });
  subscribeAllRequests(() => refreshQueue());
  subscribeConfig(() => { paintBuildings(); paintTasks(); fillStatusSelects(); });
  subscribeNotifications(state.profile.id, onNotification);

  // Keeps the stored push endpoint current. Silent, and a no-op unless
  // notifications were already switched on for this device.
  refreshPushSubscription().catch(err => console.warn('[push]', err));

  // The service worker tells us when the browser rotated the subscription
  // while the app was closed.
  navigator.serviceWorker?.addEventListener?.('message', event => {
    if (event.data?.type === 'push-subscription-changed') {
      refreshPushSubscription().catch(err => console.warn('[push]', err));
    }
  });
  onResume(() => refreshAll());

  // Expiry is recomputed, never rewritten.
  setInterval(paintCurrent, 20000);

  route();
}

async function refreshAll() {
  await Promise.all([
    refreshCurrent(),
    refreshQueue(),
    refreshUnread()
  ]);
}

/* ================================================================== */
/* Router                                                             */
/* ================================================================== */

const SECTIONS = ['dashboard', 'status', 'requests', 'buildings', 'tasks', 'users', 'reports', 'history', 'settings'];

function wireRouter() {
  addEventListener('hashchange', route);
  $$('[data-go]').forEach(btn =>
    btn.addEventListener('click', () => { location.hash = btn.dataset.go; }));
}

function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/')[0];
  const section = SECTIONS.includes(name) ? name : 'dashboard';
  state.section = section;

  SECTIONS.forEach(key => {
    $(`#s-${key}`)?.classList.toggle('is-active', key === section);
  });
  $$('.admin-side a, .bottomnav a').forEach(link => {
    const target = link.getAttribute('href')?.replace('#/', '');
    if (target === section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  stopPreviewTimer();
  if (section === 'status')    onEnterStatus();
  if (section === 'requests')  paintQueue();
  if (section === 'buildings') paintBuildings();
  if (section === 'tasks')     paintTasks();
  if (section === 'users')     paintUsers();
  if (section === 'reports')   runReport();
  if (section === 'history')   loadHistory();
  if (section === 'settings')  paintSettings();

  scrollTo({ top: 0 });
}

/* ================================================================== */
/* Current status                                                     */
/* ================================================================== */

async function refreshCurrent() {
  try {
    state.current = await getCurrentStatus(state.profile.id);
  } catch (err) {
    console.error(err);
  }
  paintCurrent();
}

function paintCurrent() {
  const view = describeStatus(state.current);

  // Who the current "serving" status refers to, taken from the request
  // actually in progress.
  const serving = state.openRequests.find(r => r.status === 'in_progress');
  const servingName = serving?.requester_name_snapshot ?? null;
  const host = $('#now-host');
  const mirror = $('#status-now-host');

  // The same line colleagues are reading on the board, so Haitham can see
  // what his status is actually saying about him.
  const quip = view.known && !view.expired
    ? availabilityMessage(state.current?.status_type, view.updatedAt)
    : '';

  const html = `
    <div class="now-card" data-tone="${esc(view.meta.tone)}">
      <p class="now-status">${esc(view.known ? statusLabel(view, servingName) : t('admin.noStatusYet'))}</p>
      ${quip ? `<p class="quip quip-quiet">${esc(quip)}</p>` : ''}
      ${view.location ? `<p class="now-line">${icon('pin')} ${esc(view.location)}</p>` : ''}
      ${view.task ? `<p class="now-line">${icon('wrench')} ${esc(view.task)}</p>` : ''}
      ${view.startedAt ? `<p class="now-time">${esc(view.rangeText)}</p>` : ''}
      ${view.expired ? `
        <p class="expired-note" style="margin-top:12px">
          ${icon('alarm')}
          <span>${esc(t('admin.expiredNudge', { ago: durationText(view.minutesOver) }))}</span>
        </p>` : ''}
      ${view.startedAt ? `<p class="small faint" style="margin-top:8px">
          ${esc(t('admin.updatedAgo', { ago: relativeTime(view.updatedAt) }))}${view.isFree ? '' : ` · ${esc(t('board.here'))} ${esc(view.elapsedText)}`}
        </p>` : ''}
    </div>`;

  if (host) host.innerHTML = html;
  if (mirror) mirror.innerHTML = html;

  $('#greeting').textContent = view.known
    ? t('admin.greetingSet', { status: statusLabel(view, servingName) })
    : t('admin.greetingNone');
}

/* ================================================================== */
/* Dashboard                                                          */
/* ================================================================== */

function wireDashboard() {
  $('#quick-available').addEventListener('click', async event => {
    await withBusy(event.currentTarget, 'Updating…', async () => {
      try {
        await setAvailableNow();
        await refreshCurrent();
        toastOk('You are now shown as available.');
      } catch (err) {
        toastError(err.message);
      }
    });
  });

  $('#quick-finish').addEventListener('click', async event => {
    if (!state.current) {
      toast('There is no status to finish yet.', 'info');
      return;
    }
    await withBusy(event.currentTarget, 'Finishing…', async () => {
      try {
        await finishCurrentTask();
        await refreshCurrent();
        toastOk('Task finished. You are shown as available.');
        const next = await confirmAction('Do you want to post what you are doing now?', {
          title: 'Task finished', confirmText: 'Update status'
        });
        if (next) location.hash = '#/status';
      } catch (err) {
        toastError(err.message);
      }
    });
  });
}

async function paintDashboardExtras() {
  const queue = state.openRequests;
  $('#d-life').textContent = queue.filter(r => r.priority === 'life_death' && r.status !== 'in_progress').length;
  $('#d-very').textContent = queue.filter(r => r.priority === 'very_urgent' && r.status !== 'in_progress').length;
  $('#d-urgent').textContent = queue.filter(r => r.priority === 'urgent' && r.status !== 'in_progress').length;
  $('#d-pending').textContent = queue.filter(r => r.status === 'pending').length;
  const pausedCount = queue.filter(r => r.status === 'paused').length;
  const pausedTile = $('#d-paused-tile');
  if (pausedTile) {
    pausedTile.hidden = pausedCount === 0;
    $('#d-paused').textContent = pausedCount;
  }

  const host = $('#d-queue');
  const next = queue.filter(r => r.status !== 'in_progress').slice(0, 3);
  if (!next.length) {
    renderEmpty(host, icon('party'), t('board.nobodyWaiting'));
  } else {
    host.innerHTML = next.map(queueCardHTML).join('');
    wireQueueCards(host);
  }

  // "Today so far" — real elapsed time, not the durations that were chosen.
  try {
    const today = dayKey();
    const rows = await getStatusHistory(startOfDay(today), endOfDay(today));
    const worked = rows
      .filter(r => !['break', 'offsite', 'done'].includes(r.status_type))
      .reduce((sum, r) => sum + actualMinutes(r), 0);
    const completedToday = await getRequestsBetween(startOfDay(today), endOfDay(today));

    $('#d-today').innerHTML = `
      <div class="stat"><div class="n">${esc(durationText(worked))}</div>
        <div class="l">${esc(t('admin.workingTime'))}</div></div>
      <div class="stat"><div class="n">${rows.length}</div>
        <div class="l">${esc(t('admin.activities'))}</div></div>
      <div class="stat"><div class="n">${completedToday.filter(r => r.status === 'completed').length}</div>
        <div class="l">${esc(t('admin.requestsDone'))}</div>
        <div class="sub">${esc(t('admin.received', { n: completedToday.length }))}</div></div>`;
  } catch (err) {
    $('#d-today').innerHTML = `<p class="muted small">${esc(err.message)}</p>`;
  }
}

/* ================================================================== */
/* Status form                                                        */
/* ================================================================== */

const CUSTOM = '__custom__';

function wireStatusForm() {
  $('#st-location').addEventListener('change', event => {
    const custom = event.target.value === CUSTOM;
    $('#st-location-custom-field').hidden = !custom;
    if (custom) $('#st-location-custom').focus();
  });
  $('#st-task').addEventListener('change', event => {
    const custom = event.target.value === CUSTOM;
    $('#st-task-custom-field').hidden = !custom;
    if (custom) $('#st-task-custom').focus();
  });

  $$('#st-type input').forEach(input =>
    input.addEventListener('change', () => {
      // "Available" and "Finished" do not need a place, a task or a length.
      const relaxed = ['available', 'done', 'break', 'offsite'].includes(input.value);
      $('#duration-label').textContent = relaxed ? t('admin.howLongOpt') : t('admin.howLong');
      updatePreview();
    }));

  $('#st-custom-duration').addEventListener('click', () => {
    $('#st-custom-duration-field').hidden = false;
    $('#st-custom-minutes').focus();
    setDuration(null, { keepCustom: true });
  });

  $('#st-no-duration').addEventListener('click', () => {
    $('#st-custom-duration-field').hidden = true;
    $('#st-custom-minutes').value = '';
    setDuration(null);
  });

  $('#st-custom-minutes').addEventListener('input', event => {
    const value = Number(event.target.value);
    state.duration = Number.isInteger(value) && value > 0 ? value : null;
    $$('#st-durations .btn').forEach(b => b.setAttribute('aria-pressed', 'false'));
    updatePreview();
  });

  $('#status-form').addEventListener('submit', onSubmitStatus);
}

async function onEnterStatus() {
  await fillStatusSelects();
  renderDurationButtons();
  renderShortcuts();
  updatePreview();
  startPreviewTimer();
}

async function fillStatusSelects() {
  try {
    const [buildings, tasks] = await Promise.all([
      getBuildings({ activeOnly: true }),
      getTasks({ activeOnly: true })
    ]);

    fillSelect($('#st-location'), buildings, 'No specific location', '+ Other / custom location');
    fillSelect($('#st-task'), tasks, 'No specific task', '+ Other / custom task');

    // Report filters share the same lists.
    fillSelect($('#f-building'), buildings, 'Any building', null);
    fillSelect($('#f-task'), tasks, 'Any task', null);
  } catch (err) {
    toastError(err.message);
  }
}

function fillSelect(select, rows, placeholder, customLabel) {
  if (!select) return;
  const previous = select.value;
  select.innerHTML =
    `<option value="">${esc(placeholder)}</option>` +
    rows.map(r => `<option value="${esc(r.id)}">${esc(localName(r))}</option>`).join('') +
    (customLabel ? `<option value="${CUSTOM}">${esc(customLabel)}</option>` : '');
  if (previous && [...select.options].some(o => o.value === previous)) select.value = previous;
}

function renderDurationButtons() {
  const durations = Array.isArray(state.settings?.quick_durations) && state.settings.quick_durations.length
    ? state.settings.quick_durations
    : [5, 10, 15, 20, 30, 45, 60, 120];

  $('#st-durations').innerHTML = durations.map(minutes => `
    <button class="btn" type="button" data-minutes="${minutes}"
            aria-pressed="${state.duration === minutes}">${esc(durationText(minutes))}</button>`).join('');

  $$('#st-durations .btn').forEach(btn =>
    btn.addEventListener('click', () => setDuration(Number(btn.dataset.minutes))));
}

function setDuration(minutes, { keepCustom = false } = {}) {
  state.duration = minutes;
  if (minutes != null) {
    prefs.set('lastDuration', minutes);
    if (!keepCustom) {
      $('#st-custom-duration-field').hidden = true;
      $('#st-custom-minutes').value = '';
    }
  }
  $$('#st-durations .btn').forEach(btn =>
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.minutes) === minutes)));
  updatePreview();
}

/**
 * Shows the window this update will create.
 *
 * The browser clock is used for the PREVIEW only — the row that gets
 * written is stamped by the database with now(), so the two can differ by
 * a second or so and the stored value is always the authoritative one.
 */
function updatePreview() {
  const now = new Date();
  const rangeNode = $('#st-preview-range');
  const subNode = $('#st-preview-sub');
  if (!rangeNode) return;

  if (state.duration) {
    const end = new Date(now.getTime() + state.duration * 60000);
    rangeNode.textContent = `${fmtTime(now)} → ${fmtTime(end)}`;
    subNode.textContent = t('admin.runsFor', { duration: durationText(state.duration) });
  } else {
    rangeNode.textContent = `${fmtTime(now)} → ${t('board.openEnded')}`;
    subNode.textContent = t('admin.openEndedSub');
  }
}

function startPreviewTimer() {
  stopPreviewTimer();
  previewTimer = setInterval(updatePreview, 1000);
}
function stopPreviewTimer() {
  if (previewTimer) clearInterval(previewTimer);
  previewTimer = null;
}

async function onSubmitStatus(event) {
  event.preventDefault();
  const errorNode = $('#st-error');
  errorNode.hidden = true;

  const locationValue = $('#st-location').value;
  const taskValue = $('#st-task').value;

  const payload = {
    statusType: $('#st-type input:checked')?.value ?? 'busy',
    buildingId: locationValue && locationValue !== CUSTOM ? locationValue : null,
    customLocation: locationValue === CUSTOM ? $('#st-location-custom').value : null,
    taskId: taskValue && taskValue !== CUSTOM ? taskValue : null,
    customTask: taskValue === CUSTOM ? $('#st-task-custom').value : null,
    durationMinutes: state.duration
  };

  await withBusy($('#st-submit'), 'Updating…', async () => {
    try {
      await updateStatus(payload);
      rememberShortcut(payload);
      await refreshCurrent();
      toastOk(t('admin.statusUpdated'));
      location.hash = '#/dashboard';
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
      errorNode.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
}

/* ---- shortcuts: remember combinations, never auto-submit them ----- */

function rememberShortcut(payload) {
  if (!payload.buildingId && !payload.customLocation) return;
  const list = prefs.get('shortcuts', []);
  const entry = {
    statusType: payload.statusType,
    buildingId: payload.buildingId,
    customLocation: payload.customLocation,
    taskId: payload.taskId,
    customTask: payload.customTask,
    duration: payload.durationMinutes,
    label: `${$('#st-location').selectedOptions[0]?.text ?? payload.customLocation ?? ''} · ${$('#st-task').selectedOptions[0]?.text ?? payload.customTask ?? 'No task'}`
  };
  const next = [entry, ...list.filter(s => s.label !== entry.label)].slice(0, 4);
  prefs.set('shortcuts', next);
}

function renderShortcuts() {
  const list = prefs.get('shortcuts', []);
  const host = $('#st-recent');
  if (!list.length) {
    host.innerHTML = `<p class="muted small">${esc(t('admin.shortcutsHint'))}</p>`;
    return;
  }
  host.innerHTML = list.map((s, i) => `
    <button class="btn btn-soft btn-block" type="button" data-shortcut="${i}" style="justify-content:flex-start">
      ${esc(s.label)}${s.duration ? ` · ${esc(durationText(s.duration))}` : ''}
    </button>`).join('');

  $$('[data-shortcut]', host).forEach(btn =>
    btn.addEventListener('click', () => {
      const s = list[Number(btn.dataset.shortcut)];
      applyShortcut(s);
      toast(t('admin.shortcutFilled'), 'info');
    }));
}

function applyShortcut(s) {
  const typeInput = $(`#st-type input[value="${CSS.escape(s.statusType)}"]`);
  if (typeInput) typeInput.checked = true;

  if (s.customLocation) {
    $('#st-location').value = CUSTOM;
    $('#st-location-custom-field').hidden = false;
    $('#st-location-custom').value = s.customLocation;
  } else if (s.buildingId) {
    $('#st-location').value = s.buildingId;
    $('#st-location-custom-field').hidden = true;
  }

  if (s.customTask) {
    $('#st-task').value = CUSTOM;
    $('#st-task-custom-field').hidden = false;
    $('#st-task-custom').value = s.customTask;
  } else if (s.taskId) {
    $('#st-task').value = s.taskId;
    $('#st-task-custom-field').hidden = true;
  }

  setDuration(s.duration ?? null);
  $('#st-submit').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ================================================================== */
/* Requests / queue                                                   */
/* ================================================================== */

function wireRequests() {
  $$('[data-rq-filter]').forEach(btn =>
    btn.addEventListener('click', async () => {
      state.requestFilter = btn.dataset.rqFilter;
      $$('[data-rq-filter]').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.rqFilter === state.requestFilter)));
      if (['today', 'closed'].includes(state.requestFilter)) await loadClosed();
      paintQueue();
    }));
}

async function refreshQueue() {
  try {
    state.openRequests = await getOpenRequests();
  } catch (err) {
    console.error(err);
    renderError($('#queue-host'), err.message, () => refreshQueue());
    return;
  }
  paintQueue();
  paintQueueBadges();
  paintDashboardExtras();
}

async function loadClosed() {
  try {
    const from = startOfDay(addDays(dayKey(), -7));
    const to = endOfDay(dayKey());
    state.closedRequests = await getRequestsBetween(from, to);
  } catch (err) {
    toastError(err.message);
  }
}

function paintQueueBadges() {
  const waiting = state.openRequests.filter(r => r.status !== 'in_progress').length;
  [['#nav-queue-count', waiting], ['#side-queue-count', waiting]].forEach(([sel, value]) => {
    const node = $(sel);
    if (!node) return;
    node.hidden = value === 0;
    node.textContent = value > 9 ? '9+' : String(value);
  });

  const urgent = state.openRequests.filter(r => r.priority !== 'normal').length;
  $('#queue-summary').textContent = waiting === 0
    ? t('admin.nobodyWaitingNow')
    : t('admin.waitingSummary', { n: waiting }) + (urgent ? t('admin.urgentSuffix', { n: urgent }) : '') + '.';
}

function paintQueue() {
  const host = $('#queue-host');
  const filter = state.requestFilter;

  let rows;
  if (filter === 'open') rows = state.openRequests;
  else if (['pending', 'accepted', 'in_progress'].includes(filter)) rows = state.openRequests.filter(r => r.status === filter);
  else if (filter === 'today') rows = state.closedRequests.filter(r => dayKey(r.created_at) === dayKey());
  else rows = state.closedRequests.filter(r => !OPEN_STATUSES.includes(r.status));

  rows = sortQueue(rows);

  if (!rows.length) {
    renderEmpty(host, filter === 'open' ? icon('party') : icon('mailbox'),
      filter === 'open' ? t('admin.queueEmpty') : t('admin.nothingToShow'),
      filter === 'open' ? t('admin.queueEmptyHint') : t('admin.tryAnotherFilter'));
    return;
  }

  const inProgress = rows.filter(r => r.status === 'in_progress');
  const paused = rows.filter(r => r.status === 'paused');
  const waiting = rows.filter(r => !['in_progress', 'paused'].includes(r.status));

  host.innerHTML = [
    inProgress.length ? `<p class="queue-group-title">${esc(t('admin.workingNow'))}</p>${inProgress.map(queueCardHTML).join('')}` : '',
    paused.length ? `<p class="queue-group-title">${esc(t('admin.pausedGroup'))}</p>${paused.map(queueCardHTML).join('')}` : '',
    waiting.length ? `<p class="queue-group-title">${esc(filter === 'open' ? t('admin.waitingGroup') : t('admin.requestsGroup'))}</p>${waiting.map(queueCardHTML).join('')}` : ''
  ].join('');

  wireQueueCards(host);
}

function queueCardHTML(r) {
  const priority = PRIORITY_META[r.priority] ?? PRIORITY_META.normal;
  const status = REQUEST_STATUS_META[r.status] ?? REQUEST_STATUS_META.pending;
  const closed = !OPEN_STATUSES.includes(r.status);

  const actions = closed ? '' : `
    <div class="acts">
      ${r.status === 'pending' ? `
        <button class="btn btn-ok btn-sm" type="button" data-act="accept" data-id="${esc(r.id)}">${esc(t('admin.accept'))}</button>
        <button class="btn btn-danger btn-sm" type="button" data-act="reject" data-id="${esc(r.id)}">${esc(t('admin.reject'))}</button>` : ''}
      ${r.status === 'accepted' ? `
        <button class="btn btn-primary btn-sm" type="button" data-act="start" data-id="${esc(r.id)}">${esc(t('admin.startNow'))}</button>` : ''}
      ${r.status === 'in_progress' ? `
        <button class="btn btn-ok btn-sm" type="button" data-act="complete" data-id="${esc(r.id)}">${esc(t('admin.complete'))}</button>
        <button class="btn btn-soft btn-sm" type="button" data-act="pause" data-id="${esc(r.id)}">${esc(t('admin.pause'))}</button>` : ''}
      ${r.status === 'paused' ? `
        <button class="btn btn-primary btn-sm" type="button" data-act="resume" data-id="${esc(r.id)}">${esc(t('admin.resume'))}</button>
        <button class="btn btn-ok btn-sm" type="button" data-act="complete" data-id="${esc(r.id)}">${esc(t('admin.complete'))}</button>` : ''}
      <button class="btn btn-soft btn-sm" type="button" data-act="more" data-id="${esc(r.id)}">${esc(t('action.more'))}</button>
    </div>`;

  return `
    <article class="queue-card" data-priority="${esc(r.priority)}">
      <div class="row-between">
        <span class="badge badge-${esc(priority.tone)}">
          <span aria-hidden="true">${priority.icon}</span>${esc(priority.label)}
        </span>
        <span class="badge badge-${esc(status.tone)}">
          <span aria-hidden="true">${status.icon}</span>${esc(status.label)}
        </span>
      </div>
      <p class="who" style="margin-top:8px">${esc(r.requester_name_snapshot)}</p>
      <p class="where">${icon('pin')} ${esc(requestLocation(r))} · <span class="mono">${esc(r.request_number)}</span></p>
      <p class="where">${channelBadge(r)}</p>
      <p class="what">${icon('wrench')} ${esc(requestCategory(r))}</p>
      ${r.description ? `<p class="desc">${esc(r.description)}</p>` : ''}
      ${r.status === 'paused' ? `<p class="desc" style="color:var(--urgent)">
        ${icon('pause')} ${esc(t('admin.pausedFor', { d: durationText(minutesBetween(r.paused_at, new Date()) ?? 0) }))}${
          r.pause_reason ? ` — ${esc(r.pause_reason)}` : ''}</p>` : ''}
      <p class="small faint" style="margin-top:6px">
        ${esc(t('admin.sentAt', { time: fmtTime(r.created_at) }))} · ${esc(relativeTime(r.created_at))}
      </p>
      ${actions}
    </article>`;
}

/** Shows how a request reached Haitham, e.g. a speech bubble + "WhatsApp". */
function channelBadge(request) {
  const key = requestChannel(request);
  const meta = CHANNELS[key] ?? CHANNELS.other;
  return `<span aria-hidden="true">${meta.icon}</span> ${esc(meta.label)}`;
}

function wireQueueCards(root) {
  $$('[data-act]', root).forEach(btn =>
    btn.addEventListener('click', () => onQueueAction(btn.dataset.act, btn.dataset.id, btn)));
}

function findRequest(id) {
  return state.openRequests.find(r => r.id === id)
    || state.closedRequests.find(r => r.id === id)
    || null;
}

async function onQueueAction(action, id, button) {
  const request = findRequest(id);
  if (!request) return;

  if (action === 'more') { openRequestActions(request); return; }

  if (action === 'accept') {
    // Three real choices. Dismissing the sheet accepts nothing, so a
    // stray tap can never silently commit you to a request.
    const when = await chooseAction(
      t('admin.needsHelp', { name: request.requester_name_snapshot, place: requestLocation(request) }),
      [
        { value: 'now',   label: t('admin.goingNow'), style: 'btn-primary' },
        { value: 'after', label: t('admin.afterCurrent') }
      ],
      { title: t('admin.accept') });
    if (!when) return;

    await withBusy(button, t('admin.accepting'), async () => {
      try {
        await acceptRequest(id, {
          travelNow: when === 'now',
          durationMinutes: when === 'now' ? state.duration : null
        });
        toastOk(when === 'now' ? t('admin.acceptedTravel') : t('admin.acceptedNext'));
        await Promise.all([refreshQueue(), refreshCurrent()]);
      } catch (err) { toastError(err.message); }
    });
    return;
  }

  if (action === 'start') {
    await withBusy(button, 'Starting…', async () => {
      try {
        await startRequest(id, state.duration);
        toastOk(t('admin.startedToast'));
        await Promise.all([refreshQueue(), refreshCurrent()]);
      } catch (err) { toastError(err.message); }
    });
    return;
  }

  if (action === 'pause') {
    const why = await chooseAction(
      t('admin.pauseWhy', { name: request.requester_name_snapshot }),
      [
        { value: 'urgent',  label: t('admin.pauseUrgent'), style: 'btn-primary' },
        { value: 'blocked', label: t('admin.pauseBlocked') },
        { value: 'other',   label: t('admin.pauseOther') }
      ],
      { title: t('admin.pause') });
    if (!why) return;

    const reason = {
      urgent:  t('admin.pauseUrgent'),
      blocked: t('admin.pauseBlocked'),
      other:   t('admin.pauseOther')
    }[why];

    await withBusy(button, t('action.working'), async () => {
      try {
        await pauseRequest(id, reason);
        toastOk(t('admin.pausedToast'));
        await Promise.all([refreshQueue(), refreshCurrent()]);
      } catch (err) { toastError(err.message); }
    });
    return;
  }

  if (action === 'resume') {
    await withBusy(button, t('action.working'), async () => {
      try {
        await resumeRequest(id, state.duration);
        toastOk(t('admin.resumedToast'));
        await Promise.all([refreshQueue(), refreshCurrent()]);
      } catch (err) { toastError(err.message); }
    });
    return;
  }

  if (action === 'complete') {
    await withBusy(button, 'Completing…', async () => {
      try {
        await completeRequest(id);
        toastOk(t('admin.completedToast'));
        await Promise.all([refreshQueue(), refreshCurrent()]);
      } catch (err) { toastError(err.message); }
    });
    return;
  }

  if (action === 'reject') {
    const ok = await confirmAction(
      t('admin.rejectConfirm'),
      { title: t('admin.reject'), confirmText: t('admin.reject'), danger: true });
    if (!ok) return;
    await withBusy(button, 'Rejecting…', async () => {
      try {
        await rejectRequest(id);
        toastOk('Request rejected.');
        await refreshQueue();
      } catch (err) { toastError(err.message); }
    });
  }
}

async function openRequestActions(request) {
  $('#action-title').textContent = request.request_number;
  const body = $('#action-body');
  const priority = PRIORITY_META[request.priority];
  const status = REQUEST_STATUS_META[request.status];

  body.innerHTML = `
    <div class="stack-sm">
      <div class="row-wrap">
        <span class="badge badge-${esc(status.tone)}">${status.icon} ${esc(status.label)}</span>
        <span class="badge badge-${esc(priority.tone)}">${priority.icon} ${esc(priority.label)}</span>
      </div>
      <p style="font-size:18px;font-weight:750">${esc(request.requester_name_snapshot)}</p>
      <p class="muted">${icon('pin')} ${esc(requestLocation(request))} · ${icon('wrench')} ${esc(requestCategory(request))}</p>
      ${request.description ? `<p class="req-desc">${esc(request.description)}</p>` : ''}
      <p class="small faint">Sent ${esc(fmtDateTime(request.created_at))}</p>
    </div>

    <div class="field" style="margin-top:18px">
      <span class="label">${esc(t('admin.changePriority'))}</span>
      <div class="row-wrap" id="pri-buttons">
        ${Object.entries(PRIORITY_META).map(([key, meta]) => `
          <button class="btn btn-sm ${request.priority === key ? 'btn-primary' : 'btn-soft'}"
                  type="button" data-priority="${esc(key)}">${meta.icon} ${esc(meta.label)}</button>`).join('')}
      </div>
    </div>

    <div class="field" style="margin-top:18px">
      <span class="label">${esc(t('admin.moveInQueue'))}</span>
      <div class="row-wrap">
        <button class="btn btn-sm btn-soft" type="button" data-move="up">${esc(t('admin.earlier'))}</button>
        <button class="btn btn-sm btn-soft" type="button" data-move="down">${esc(t('admin.later'))}</button>
      </div>
      <p class="help">${esc(t('admin.orderHint'))}</p>
    </div>

    <div id="action-timeline" style="margin-top:18px"></div>

    <div class="field" style="margin-top:22px">
      <span class="label">${esc(t('admin.removeSection'))}</span>
      <button class="btn btn-danger btn-block" type="button" id="delete-request">
        ${esc(t('admin.deleteRequest'))}
      </button>
      <p class="help">${esc(t('admin.deleteHint'))}</p>
    </div>`;

  openSheet('#action-sheet');

  $$('#pri-buttons [data-priority]', body).forEach(btn =>
    btn.addEventListener('click', async () => {
      await withBusy(btn, 'Saving…', async () => {
        try {
          await setPriority(request.id, btn.dataset.priority);
          toastOk('Priority updated.');
          await refreshQueue();
          closeSheet('#action-sheet');
        } catch (err) { toastError(err.message); }
      });
    }));

  $$('[data-move]', body).forEach(btn =>
    btn.addEventListener('click', async () => {
      await withBusy(btn, 'Moving…', async () => {
        try {
          await moveInQueue(request.id, btn.dataset.move);
          toastOk('Queue order saved.');
          await refreshQueue();
        } catch (err) { toastError(err.message); }
      });
    }));

  $('#delete-request')?.addEventListener('click', async event => {
    const ok = await confirmAction(
      t('admin.deleteConfirm', { number: request.request_number }),
      { title: t('admin.deleteRequest'), confirmText: t('admin.deleteRequest'), danger: true });
    if (!ok) return;
    await withBusy(event.currentTarget, t('action.working'), async () => {
      try {
        await deleteRequest(request.id);
        toastOk(t('admin.deletedToast', { number: request.request_number }));
        closeSheet('#action-sheet');
        await Promise.all([refreshQueue(), refreshCurrent()]);
      } catch (err) { toastError(err.message); }
    });
  });

  try {
    const timeline = await getRequestTimeline(request.id);
    $('#action-timeline').innerHTML = timeline.length ? `
      <span class="label">${esc(t('admin.requestHistory'))}</span>
      <ol class="timeline">${timeline.map(t => `
        <li>
          <strong>${esc(REQUEST_STATUS_META[t.new_status]?.label ?? t.new_status ?? 'Updated')}</strong>
          ${t.notes ? `<div class="small muted">${esc(t.notes)}</div>` : ''}
          <time>${esc(fmtDateTime(t.created_at))}</time>
        </li>`).join('')}</ol>` : '';
  } catch (err) {
    console.warn(err);
  }
}

async function moveInQueue(id, direction) {
  const waiting = state.openRequests.filter(r => r.status !== 'in_progress');
  const index = waiting.findIndex(r => r.id === id);
  const target = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || target < 0 || target >= waiting.length) return;

  const reordered = [...waiting];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  await saveQueueOrder(reordered.map(r => r.id));
}

/* ================================================================== */
/* Buildings                                                          */
/* ================================================================== */

function wireBuildings() {
  $('#building-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('#building-name');
    await withBusy($('#building-add'), 'Adding…', async () => {
      try {
        await addBuilding(input.value, $('#building-name-ar').value);
        input.value = '';
        $('#building-name-ar').value = '';
        toastOk('Building added.');
        await paintBuildings();
      } catch (err) { toastError(err.message); }
    });
  });
}

async function paintBuildings() {
  await paintConfigList({
    host: $('#buildings-host'),
    load: () => getBuildings({ force: true }),
    table: 'buildings',
    update: updateBuilding,
    noun: 'building'
  });
}

/* ================================================================== */
/* Tasks                                                              */
/* ================================================================== */

function wireTasks() {
  $('#task-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('#task-name');
    await withBusy($('#task-add'), 'Adding…', async () => {
      try {
        await addTask(input.value, $('#task-name-ar').value);
        input.value = '';
        $('#task-name-ar').value = '';
        toastOk('Task added.');
        await paintTasks();
      } catch (err) { toastError(err.message); }
    });
  });
}

async function paintTasks() {
  await paintConfigList({
    host: $('#tasks-host'),
    load: () => getTasks({ force: true }),
    table: 'tasks',
    update: updateTask,
    noun: 'task'
  });
}

/**
 * The name in the language that is NOT currently on screen, so an
 * administrator can see both without the row repeating itself.
 */
function otherName(row) {
  const ar = (row.name_ar ?? '').trim();
  return getLang() === 'ar' ? (row.name ?? '') : ar;
}

/** Buildings and tasks are managed identically, so they share a renderer. */
async function paintConfigList({ host, load, table, update, noun }) {
  if (!host) return;
  try {
    const rows = await load();
    if (!rows.length) {
      renderEmpty(host, icon('mailbox'), `No ${noun}s yet`, `Add your first ${noun} above.`);
      return;
    }

    host.innerHTML = rows.map((row, index) => `
      <div class="cfg-row ${row.active ? '' : 'is-off'}" data-id="${esc(row.id)}">
        <span class="cfg-move">
          <button type="button" data-move="up" ${index === 0 ? 'disabled' : ''} aria-label="Move ${esc(row.name)} up">${icon('caretUp')}</button>
          <button type="button" data-move="down" ${index === rows.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(row.name)} down">${icon('caretDown')}</button>
        </span>
        <span class="grow">
          <span class="cfg-name">${esc(localName(row))}</span>
          <span class="cfg-sub">
            ${otherName(row)
              ? esc(otherName(row))
              : `<em style="color:var(--warn)">${esc(t('admin.noArabicName'))}</em>`}
            · ${esc(row.active ? t('admin.active') : t('admin.disabled'))}
            · ${esc(t('admin.position', { n: index + 1 }))}
          </span>
        </span>
        <button class="btn btn-sm btn-soft" type="button" data-edit aria-label="Rename ${esc(row.name)}">${esc(t('action.edit'))}</button>
        <button class="btn btn-sm ${row.active ? 'btn-ghost' : 'btn-ok'}" type="button" data-toggle>
          ${esc(row.active ? t('action.disable') : t('action.enable'))}
        </button>
      </div>`).join('');

    $$('.cfg-row', host).forEach(rowNode => {
      const id = rowNode.dataset.id;
      const row = rows.find(r => r.id === id);

      $$('[data-move]', rowNode).forEach(btn =>
        btn.addEventListener('click', async () => {
          try {
            await moveItem(table, id, btn.dataset.move);
            await paintConfigList({ host, load, table, update, noun });
          } catch (err) { toastError(err.message); }
        }));

      $('[data-edit]', rowNode).addEventListener('click', async () => {
        const next = prompt(t('admin.renameEn', { noun }), row.name);
        if (next == null) return;
        const nextAr = prompt(t('admin.renameAr', { noun }), row.name_ar ?? '');
        if (nextAr == null) return;
        if (next.trim() === row.name && (nextAr.trim() || null) === (row.name_ar ?? null)) return;
        try {
          await update(id, { name: next, name_ar: nextAr });
          toastOk(`${noun[0].toUpperCase()}${noun.slice(1)} renamed. Old records keep their original name.`);
          await paintConfigList({ host, load, table, update, noun });
        } catch (err) { toastError(err.message); }
      });

      $('[data-toggle]', rowNode).addEventListener('click', async event => {
        if (row.active) {
          const ok = await confirmAction(
            `Disable "${row.name}"? It disappears from the menus but stays in old reports.`,
            { title: `Disable ${noun}`, confirmText: 'Disable' });
          if (!ok) return;
        }
        await withBusy(event.currentTarget, '…', async () => {
          try {
            await update(id, { active: !row.active });
            await paintConfigList({ host, load, table, update, noun });
          } catch (err) { toastError(err.message); }
        });
      });
    });
  } catch (err) {
    renderError(host, err.message, () => paintConfigList({ host, load, table, update, noun }));
  }
}

/* ================================================================== */
/* Users                                                              */
/* ================================================================== */

function wireUsers() {
  $('#user-search').addEventListener('input', () => paintUsers());
}

async function paintUsers() {
  const host = $('#users-host');
  try {
    const term = $('#user-search').value.trim().toLowerCase();
    const users = await getUsers();
    const rows = term
      ? users.filter(u => `${u.full_name} ${u.email ?? ''}`.toLowerCase().includes(term))
      : users;

    if (!rows.length) {
      renderEmpty(host, icon('users'), t('admin.noChanges'));
      return;
    }

    host.innerHTML = rows.map(u => `
      <div class="cfg-row ${u.active ? '' : 'is-off'}" data-id="${esc(u.id)}">
        <span class="grow">
          <span class="cfg-name">${esc(u.full_name)}</span>
          <span class="cfg-sub">${esc(u.email ?? 'no e-mail')} · joined ${esc(fmtDateShort(u.created_at))}</span>
        </span>
        <span class="badge ${u.role === 'admin' ? 'badge-info' : 'badge-muted'}">
          ${esc(u.role === 'admin' ? t('app.admin') : 'Employee')}
        </span>
        <button class="btn btn-sm btn-soft" type="button" data-role>
          ${esc(u.role === 'admin' ? t('admin.makeEmployee') : t('admin.makeAdmin'))}
        </button>
        <button class="btn btn-sm ${u.active ? 'btn-ghost' : 'btn-ok'}" type="button" data-active>
          ${esc(u.active ? t('admin.deactivate') : t('admin.activate'))}
        </button>
      </div>`).join('');

    $$('.cfg-row', host).forEach(node => {
      const id = node.dataset.id;
      const user = rows.find(u => u.id === id);

      $('[data-role]', node).addEventListener('click', async event => {
        const nextRole = user.role === 'admin' ? 'employee' : 'admin';
        const ok = await confirmAction(
          nextRole === 'admin'
            ? `Give ${user.full_name} full administrator access?`
            : `Remove administrator access from ${user.full_name}?`,
          { title: 'Change role', confirmText: 'Change role', danger: nextRole === 'employee' });
        if (!ok) return;
        await withBusy(event.currentTarget, 'Saving…', async () => {
          try {
            await setUserRole(id, nextRole);
            toastOk('Role updated.');
            await paintUsers();
          } catch (err) { toastError(err.message); }
        });
      });

      $('[data-active]', node).addEventListener('click', async event => {
        if (user.active) {
          const ok = await confirmAction(
            `Deactivate ${user.full_name}? They will not be able to sign in. Their past requests are kept.`,
            { title: 'Deactivate user', confirmText: 'Deactivate', danger: true });
          if (!ok) return;
        }
        await withBusy(event.currentTarget, 'Saving…', async () => {
          try {
            await setUserActive(id, !user.active);
            await paintUsers();
          } catch (err) { toastError(err.message); }
        });
      });
    });
  } catch (err) {
    renderError(host, err.message, () => paintUsers());
  }
}

/* ================================================================== */
/* Reports                                                            */
/* ================================================================== */

function wireReports() {
  $$('[data-period]').forEach(btn =>
    btn.addEventListener('click', () => {
      state.reportPeriod = btn.dataset.period;
      $$('[data-period]').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.period === state.reportPeriod)));
      $('#custom-range').hidden = state.reportPeriod !== 'custom';
      if (state.reportPeriod !== 'custom') {
        state.reportRange = periodRange(state.reportPeriod);
        runReport();
      }
    }));

  $('#range-apply').addEventListener('click', () => {
    const from = $('#range-from').value;
    const to = $('#range-to').value;
    if (!from || !to) { toast('Choose both dates.', 'info'); return; }
    if (from > to) { toast('The "from" date must come first.', 'info'); return; }
    state.reportRange = { from, to };
    runReport();
  });

  ['#f-building', '#f-task', '#f-priority', '#f-status', '#f-channel'].forEach(sel =>
    $(sel).addEventListener('change', () => {
      state.reportFilters = {
        buildingId: $('#f-building').value || null,
        taskId: $('#f-task').value || null,
        priority: $('#f-priority').value || null,
        status: $('#f-status').value || null,
        channel: $('#f-channel').value || null
      };
      runReport();
    }));

  $('#f-clear').addEventListener('click', () => {
    ['#f-building', '#f-task', '#f-priority', '#f-status', '#f-channel'].forEach(sel => { $(sel).value = ''; });
    state.reportFilters = {};
    runReport();
  });

  $('#ex-summary').addEventListener('click', () => state.report && exportSummaryCSV(state.report));
  $('#ex-requests').addEventListener('click', () => state.report && exportRequestsCSV(state.report));
  $('#ex-activity').addEventListener('click', () => state.report && exportActivityCSV(state.report));
  $('#ex-print').addEventListener('click', () => print());
}

function periodRange(period) {
  const today = dayKey();
  if (period === 'today') return { from: today, to: today };
  if (period === 'yesterday') { const y = addDays(today, -1); return { from: y, to: y }; }
  if (period === 'week') return { from: startOfWeek(today), to: today };
  if (period === 'month') return { from: startOfMonth(today), to: today };
  return { from: today, to: today };
}

async function runReport() {
  const host = $('#report-host');
  host.innerHTML = '<div class="skeleton" style="height:200px"></div>';
  try {
    const { from, to } = state.reportRange;
    state.report = await buildReport(from, to, state.reportFilters);
    $('#report-period').textContent = reportTitle(state.report);
    paintReport(state.report);
  } catch (err) {
    renderError(host, err.message, () => runReport());
  }
}

function paintReport(report) {
  const multiDay = report.range.dayCount > 1;
  const exp = report.expectation;

  const dayChart = multiDay ? barChart(
    report.breakdown.byDay.map(d => ({
      label: report.range.dayCount > 14 ? d.key.slice(8) : weekdayName(startOfDay(d.key)).slice(0, 3),
      value: d.value,
      title: `${fmtDateLong(startOfDay(d.key))}: ${d.value} request${d.value === 1 ? '' : 's'}`
    })),
    { ariaLabel: 'Requests per day', valueFormat: v => (v ? String(v) : '') }
  ) : '';

  $('#report-host').innerHTML = `
    <div class="stack">
      <div class="stat-grid">
        <div class="stat"><div class="n">${report.counts.total}</div><div class="l">${esc(t('admin.requestsLabel'))}</div>
          <div class="sub">${esc(multiDay ? t('admin.perDay', { n: report.perDay }) : t('admin.todayLower'))}</div></div>
        <div class="stat"><div class="n">${report.counts.completed}</div><div class="l">${esc(t('admin.completed'))}</div>
          <div class="sub">${esc(t('admin.ofTotal', { n: report.counts.total ? Math.round((report.counts.completed / report.counts.total) * 100) : 0 }))}</div></div>
        <div class="stat"><div class="n">${report.counts.pending + report.counts.accepted + report.counts.inProgress}</div>
          <div class="l">${esc(t('admin.stillOpen'))}</div>
          <div class="sub">${esc(t('admin.pendingSub', { n: report.counts.pending }))}</div></div>
        <div class="stat"><div class="n">${report.counts.urgent + report.counts.veryUrgent}</div><div class="l">${esc(t('counters.urgent'))}</div>
          <div class="sub">${esc(t('admin.veryUrgentSub', { n: report.counts.veryUrgent }))}</div></div>
        <div class="stat"><div class="n">${esc(durationText(report.time.workingMinutes))}</div><div class="l">${esc(t('admin.workingTime'))}</div>
          <div class="sub">${esc(t('admin.tracked', { d: durationText(report.time.trackedMinutes) }))}</div></div>
        <div class="stat"><div class="n">${report.avgCompletion != null ? esc(durationText(report.avgCompletion)) : '—'}</div>
          <div class="l">${esc(t('admin.avgCompletion'))}</div>
          <div class="sub">${report.avgResponse != null ? esc(t('admin.toAccept', { d: durationText(report.avgResponse) })) : esc(t('admin.noDataShort'))}</div></div>
      </div>

      ${multiDay ? `
        <section class="card">
          <h2 class="card-title">${esc(t('admin.requestsPerDay'))}</h2>
          <div class="table-wrap">${dayChart}</div>
        </section>` : ''}

      <section class="card">
        <h2 class="card-title">${esc(t('admin.timeByLocation'))}</h2>
        ${proportionBars(report.time.byLocation.map(r => ({
          label: r.label, value: r.value, display: durationText(r.value)
        })), { emptyText: t('admin.noActivity') })}
      </section>

      <section class="card">
        <h2 class="card-title">${esc(t('admin.timeByTask'))}</h2>
        ${proportionBars(report.time.byTaskDuration.map(r => ({
          label: r.label, value: r.value, display: durationText(r.value), tone: 'info'
        })), { emptyText: t('admin.noActivity') })}
      </section>

      <section class="card">
        <h2 class="card-title">${esc(t('admin.tasksByCount'))}</h2>
        ${proportionBars(report.time.byTaskCount.map(r => ({
          label: r.label, value: r.value, display: `${r.value}×`, tone: 'ok'
        })), { emptyText: t('admin.noActivity') })}
      </section>

      <section class="card">
        <h2 class="card-title">${esc(t('admin.byCategory'))}</h2>
        ${proportionBars(report.breakdown.byCategory, { emptyText: t('admin.noRequests') })}
      </section>

      <section class="card">
        <h2 class="card-title">${esc(t('admin.byBuilding'))}</h2>
        ${proportionBars(report.breakdown.byLocation, { emptyText: t('admin.noRequests') })}
      </section>

      <section class="card">
        <h2 class="card-title">${esc(t('admin.byChannel'))}</h2>
        ${proportionBars(report.breakdown.byChannel, { emptyText: t('admin.noData') })}
        <p class="help" style="margin-top:10px">${esc(t('admin.recordedNote'))}</p>
      </section>

      <section class="card">
        <h2 class="card-title">${esc(t('admin.byPriority'))}</h2>
        ${proportionBars(report.breakdown.byPriority.filter(p => p.value > 0),
          { emptyText: t('admin.noRequests') })}
      </section>

      <section class="card">
        <h2 class="card-title">${esc(t('admin.expectedActual'))}</h2>
        ${exp.comparableCount ? `
          <div class="stat-grid">
            <div class="stat"><div class="n">${esc(durationText(exp.avgExpected))}</div><div class="l">${esc(t('admin.avgPlanned'))}</div></div>
            <div class="stat"><div class="n">${esc(durationText(exp.avgActual))}</div><div class="l">${esc(t('admin.avgActual'))}</div></div>
            <div class="stat"><div class="n">${exp.overrunCount}</div><div class="l">${esc(t('admin.ranOver'))}</div>
              <div class="sub">${esc(t('admin.ofFinished', { n: exp.comparableCount }))}</div></div>
          </div>
          <p class="help" style="margin-top:10px">${esc(t('admin.expectedNote'))}</p>`
          : `<p class="muted small">${esc(t('admin.notEnough'))}</p>`}
      </section>

      ${report.highlights.mostCommonTask || report.highlights.mostActiveLocation ? `
        <section class="card">
          <h2 class="card-title">${esc(t('admin.highlights'))}</h2>
          <ul class="stack-sm" style="list-style:none;padding:0;margin:0">
            ${report.highlights.mostCommonTask ? `<li>${icon('wrench')} ${esc(t('admin.mostCommonTask'))}:
              <strong>${esc(report.highlights.mostCommonTask.label)}</strong>
              (${report.highlights.mostCommonTask.value}×)</li>` : ''}
            ${report.highlights.mostActiveLocation ? `<li>${icon('pin')} ${esc(t('admin.mostTimeAt'))}:
              <strong>${esc(report.highlights.mostActiveLocation.label)}</strong>
              (${esc(durationText(report.highlights.mostActiveLocation.value))})</li>` : ''}
            ${report.highlights.busiestDay && report.highlights.busiestDay.value > 0 ? `<li>${icon('chart')} ${esc(t('admin.busiestDay'))}:
              <strong>${esc(fmtDateLong(startOfDay(report.highlights.busiestDay.key)))}</strong>
              (${report.highlights.busiestDay.value} requests)</li>` : ''}
          </ul>
        </section>` : ''}
    </div>`;
}

/* ================================================================== */
/* History                                                            */
/* ================================================================== */

function wireHistory() {
  const today = dayKey();
  $('#hist-from').value = addDays(today, -6);
  $('#hist-to').value = today;
  $('#hist-from').addEventListener('change', loadHistory);
  $('#hist-to').addEventListener('change', loadHistory);
  $('#hist-search').addEventListener('input', paintHistory);
}

async function loadHistory() {
  const host = $('#history-host');
  const from = $('#hist-from').value || dayKey();
  const to = $('#hist-to').value || dayKey();
  if (from > to) { toast('The "from" date must come first.', 'info'); return; }

  host.innerHTML = '<div class="skeleton" style="height:160px"></div>';
  try {
    state.historyRows = await getStatusHistory(startOfDay(from), endOfDay(to));
    paintHistory();
  } catch (err) {
    renderError(host, err.message, () => loadHistory());
  }
}

function paintHistory() {
  const host = $('#history-host');
  const term = $('#hist-search').value.trim().toLowerCase();

  const rows = state.historyRows.filter(row => {
    if (!term) return true;
    return `${historyLocation(row)} ${historyTask(row) ?? ''}`.toLowerCase().includes(term);
  });

  if (!rows.length) {
    renderEmpty(host, icon('clock'), t('admin.nothingRecorded'), t('admin.widerRange'));
    return;
  }

  const byDay = new Map();
  rows.forEach(row => {
    const key = dayKey(row.started_at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(row);
  });

  host.innerHTML = [...byDay.entries()].map(([key, dayRows]) => {
    const worked = dayRows
      .filter(r => !['break', 'offsite', 'done'].includes(r.status_type))
      .reduce((sum, r) => sum + actualMinutes(r), 0);

    return `
      <section>
        <h2 class="day-head">${esc(fmtDateLong(startOfDay(key)))} · ${esc(t('admin.working', { d: durationText(worked) }))}</h2>
        ${dayRows.map(historyRowHTML).join('')}
      </section>`;
  }).join('');
}

function historyRowHTML(row) {
  const meta = STATUS_META[row.status_type] ?? STATUS_META.busy;
  const actual = row.actual_minutes != null ? Number(row.actual_minutes) : null;
  const planned = row.duration_minutes;
  const open = row.actual_end_at == null;

  const diff = actual != null && planned != null ? Math.round(actual - planned) : null;
  const diffText = diff == null ? '' :
    diff > 2 ? ` · ${t('admin.overPlan', { d: durationText(diff) })}` :
    diff < -2 ? ` · ${t('admin.underPlan', { d: durationText(Math.abs(diff)) })}` : ` · ${t('admin.onPlan')}`;

  return `
    <div class="hist-item">
      <div class="hist-time">
        ${esc(fmtTime(row.started_at))}<br>
        <span class="faint">${open ? 'now' : esc(fmtTime(row.actual_end_at))}</span>
      </div>
      <div>
        <div class="hist-what">${meta.icon} ${esc(historyTask(row) ?? meta.label)}</div>
        <div class="hist-where">${icon('pin')} ${esc(historyLocation(row))}</div>
        <div class="hist-dur">
          ${open ? esc(t('admin.stillOpenRow')) : esc(durationText(actual ?? 0))}${esc(diffText)}
          ${planned ? ` · ${esc(t('admin.planned', { d: durationText(planned) }))}` : ''}
        </div>
      </div>
    </div>`;
}

/* ================================================================== */
/* Settings                                                           */
/* ================================================================== */

function wireSettings() {
  $('#set-save').addEventListener('click', async event => {
    await withBusy(event.currentTarget, 'Saving…', async () => {
      try {
        const durations = $('#set-durations').value
          .split(',')
          .map(v => Number(v.trim()))
          .filter(v => Number.isInteger(v) && v > 0 && v <= 1440);

        if (!durations.length) throw new Error('Enter at least one valid duration in minutes.');

        await Promise.all([
          saveSetting('org_name', $('#set-org').value.trim() || 'Our Organisation'),
          saveSetting('tracked_person', $('#set-person').value.trim() || 'Haitham'),
          saveSetting('quick_durations', durations.slice(0, 8))
        ]);
        state.settings = await getSettings({ force: true });
        renderDurationButtons();
        toastOk('Settings saved.');
      } catch (err) { toastError(err.message); }
    });
  });

  $('#set-email-signup').addEventListener('change', async event => {
    const value = event.target.checked;
    try {
      await saveSetting('allow_email_signup', value);
      toastOk(value
        ? 'New administrators may sign up by e-mail.'
        : 'E-mail sign-up is off.');
    } catch (err) {
      event.target.checked = !value;
      toastError(err.message);
    }
  });

  $('#push-enable').addEventListener('click', async event => {
    await withBusy(event.currentTarget, 'Enabling…', async () => {
      try {
        await enablePush();
        toastOk('Notifications are on for this device.');
      } catch (err) {
        toast(err.message, 'info', 9000);
      }
      paintPushState();
    });
  });

  $('#push-disable').addEventListener('click', async event => {
    await withBusy(event.currentTarget, 'Turning off…', async () => {
      await disablePush();
      toastOk('Notifications turned off for this device.');
      paintPushState();
    });
  });

  $('#push-rereg').addEventListener('click', async event => {
    await withBusy(event.currentTarget, t('action.working'), async () => {
      const ok = await refreshPushSubscription();
      toast(ok ? t('admin.pushReregistered') : t('admin.pushReregisterFailed'),
            ok ? 'ok' : 'error', 6000);
      paintPushState();
    });
  });

  $('#push-test').addEventListener('click', async () => {
    const shown = await showLocalNotification(
      'Test notification',
      'This is what a new request will look like.',
      { tag: 'test' });
    if (!shown) toast('Your browser did not show it. Check the site notification permission.', 'info');
  });

  // Two taps, and the second one states the real count, so nobody clears
  // a live queue by reflex.
  $('#purge-requests').addEventListener('click', async event => {
    if (!await confirmAction(t('admin.purgeRequestsQ'),
        { title: t('admin.purgeRequests'), confirmText: t('action.confirm'), danger: true })) return;

    const count = state.openRequests.length;
    if (!await confirmAction(t('admin.purgeRequestsQ2', { n: count }),
        { title: t('admin.purgeRequests'), confirmText: t('admin.purgeYes'), danger: true })) return;

    await withBusy(event.currentTarget, t('action.working'), async () => {
      try {
        const result = await purgeRequests();
        toastOk(t('admin.purgedToast', { n: result?.deleted ?? 0 }));
        await Promise.all([refreshQueue(), refreshCurrent()]);
      } catch (err) { toastError(err.message); }
    });
  });

  $('#purge-activity').addEventListener('click', async event => {
    if (!await confirmAction(t('admin.purgeActivityQ'),
        { title: t('admin.purgeActivity'), confirmText: t('admin.purgeYes'), danger: true })) return;

    await withBusy(event.currentTarget, t('action.working'), async () => {
      try {
        const result = await purgeActivity();
        toastOk(t('admin.purgedActivityToast', { n: result?.deleted ?? 0 }));
        await refreshCurrent();
      } catch (err) { toastError(err.message); }
    });
  });

  $('#hide-admin-link').addEventListener('click', async event => {
    const ok = await confirmAction(t('admin.hideLinkConfirm'), { confirmText: t('action.confirm') });
    if (!ok) return;
    // Both keys: the old boolean so a device unlocked before the reveal
    // gained an expiry is cleared too, and the current timestamp.
    prefs.remove('adminUnlocked');
    prefs.remove('adminUnlockedUntil');
    toastOk(t('admin.hiddenToast'));
  });

  $('#signout-btn').addEventListener('click', async event => {
    const ok = await confirmAction(t('admin.signOutConfirm'), { confirmText: t('admin.signOut') });
    if (!ok) return;
    await withBusy(event.currentTarget, 'Signing out…', async () => {
      try {
        await signOut();
        location.replace('index.html');
      } catch (err) { toastError(err.message); }
    });
  });
}

async function paintSettings() {
  const settings = await getSettings({ force: true });
  state.settings = settings;

  $('#set-org').value = settings.org_name ?? '';
  $('#set-person').value = settings.tracked_person ?? '';
  $('#set-durations').value = (settings.quick_durations ?? []).join(', ');
  $('#admin-identity').textContent = `${state.profile.full_name} · ${state.profile.email ?? ''}`;

  $('#set-email-signup').checked = settings.allow_email_signup !== false;
  paintPushState();

  try {
    const log = await getAuditLog(25);
    const host = $('#audit-host');
    if (!log.length) {
      renderEmpty(host, icon('files'), t('admin.noChanges'));
    } else {
      host.innerHTML = log.map(entry => `
        <p class="small" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <strong>${esc(describeAudit(entry))}</strong><br>
          <span class="faint">${esc(fmtDateTime(entry.created_at))}</span>
        </p>`).join('');
    }
  } catch (err) {
    $('#audit-host').innerHTML = `<p class="muted small">${esc(err.message)}</p>`;
  }
}

function describeAudit(entry) {
  const noun = entry.entity === 'buildings' ? 'Building'
    : entry.entity === 'tasks' ? 'Task'
    : 'User';
  const d = entry.details ?? {};
  switch (entry.action) {
    case 'created':  return `${noun} added: ${d.name ?? ''}`;
    case 'renamed':  return `${noun} renamed: ${d.from ?? ''} → ${d.to ?? ''}`;
    case 'enabled':  return `${noun} re-enabled: ${d.name ?? ''}`;
    case 'disabled': return `${noun} disabled: ${d.name ?? ''}`;
    case 'user_activated':   return `User activated: ${d.name ?? ''}`;
    case 'user_deactivated': return `User deactivated: ${d.name ?? ''}`;
    case 'role_changed':     return `Role changed: ${d.name ?? ''} (${d.from} → ${d.to})`;
    default: return `${noun} ${entry.action}`;
  }
}

async function paintPushState() {
  const setup = await describePushSetup();
  // A greyed-out button that cannot ever be pressed just looks broken.
  // Where the answer is "not possible here", hide the control and
  // explain why instead.
  const blocked = ['unsupported', 'not-configured', 'blocked'].includes(setup.level);

  let text = setup.text;
  if (setup.level === 'on') {
    // Seeing the device count makes a silent failure obvious: zero means
    // the subscription was dropped and nothing re-registered it.
    const devices = await registeredDeviceCount(state.profile.id);
    if (devices != null) {
      text += ' ' + t(devices === 1 ? 'admin.pushDevices1' : 'admin.pushDevices', { n: devices });
    }
  }

  const node = $('#push-state');
  node.textContent = text;
  node.className = blocked ? 'notice notice-warn' : 'small muted';

  $('#push-enable').hidden = setup.level === 'on' || blocked;
  $('#push-enable').disabled = false;
  $('#push-disable').hidden = setup.level !== 'on';
  $('#push-test').hidden = setup.level !== 'on';
  $('#push-rereg').hidden = setup.level !== 'on';
}

/* ================================================================== */
/* Recording a request on someone's behalf                            */
/*                                                                    */
/* Phone calls, WhatsApp messages and corridor requests become the    */
/* same standardised record as an app request, so the queue, history  */
/* and reports stay complete however someone got in touch.            */
/* ================================================================== */

function wireBehalf() {
  $('#behalf-open').addEventListener('click', openBehalfSheet);

  $('#bh-location').addEventListener('change', event => {
    const custom = event.target.value === CUSTOM;
    $('#bh-location-custom-field').hidden = !custom;
    if (custom) $('#bh-location-custom').focus();
  });
  $('#bh-category').addEventListener('change', event => {
    const custom = event.target.value === CUSTOM;
    $('#bh-category-custom-field').hidden = !custom;
    if (custom) $('#bh-category-custom').focus();
  });

  $('#behalf-form').addEventListener('submit', onSubmitBehalf);
}

async function openBehalfSheet() {
  $('#bh-error').hidden = true;
  try {
    const [buildings, tasks] = await Promise.all([
      getBuildings({ activeOnly: true }),
      getTasks({ activeOnly: true })
    ]);
    fillSelect($('#bh-location'), buildings, t('form.selectLocation'), t('admin.customLocation'));
    fillSelect($('#bh-category'), tasks, t('form.selectNeed'), t('admin.customTask'));
  } catch (err) {
    toastError(err.message);
    return;
  }
  openSheet('#behalf-sheet');
}

async function onSubmitBehalf(event) {
  event.preventDefault();
  const errorNode = $('#bh-error');
  errorNode.hidden = true;

  const locationValue = $('#bh-location').value;
  const categoryValue = $('#bh-category').value;
  const startNow = $('#bh-start-now').checked;

  const payload = {
    requesterName: $('#bh-name').value,
    channel: $('#bh-channel input:checked')?.value ?? 'phone',
    buildingId: locationValue && locationValue !== CUSTOM ? locationValue : null,
    customLocation: locationValue === CUSTOM ? $('#bh-location-custom').value : null,
    taskId: categoryValue && categoryValue !== CUSTOM ? categoryValue : null,
    customCategory: categoryValue === CUSTOM ? $('#bh-category-custom').value : null,
    description: $('#bh-description').value,
    priority: $('#bh-priority input:checked')?.value ?? 'normal',
    notes: $('#bh-notes').value,
    startNow,
    // If he is already on it, reuse the duration he last picked.
    durationMinutes: startNow ? state.duration : null
  };

  await withBusy($('#bh-submit'), t('action.saving'), async () => {
    try {
      const created = await adminCreateRequest(payload);
      toastOk(startNow
        ? t('behalf.savedStarted')
        : t('behalf.saved', { number: created.request_number }));

      $('#behalf-form').reset();
      $('#bh-location-custom-field').hidden = true;
      $('#bh-category-custom-field').hidden = true;
      closeSheet('#behalf-sheet');

      await Promise.all([refreshQueue(), refreshCurrent()]);
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
      errorNode.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
}

/* ================================================================== */
/* Notifications                                                      */
/* ================================================================== */

function wireNotifications() {
  $('#bell').addEventListener('click', () => openNotifications());
  $('#notif-read-all').addEventListener('click', async event => {
    await withBusy(event.currentTarget, 'Marking…', async () => {
      try {
        await markRead(null);
        await refreshUnread();
        await openNotifications({ keepOpen: true });
      } catch (err) { toastError(err.message); }
    });
  });
}

async function refreshUnread() {
  const count = await unreadCount(state.profile.id);
  const dot = $('#bell-dot');
  dot.hidden = count === 0;
  dot.textContent = count > 9 ? '9+' : String(count);
}

async function openNotifications({ keepOpen = false } = {}) {
  const body = $('#notif-body');
  if (!keepOpen) {
    body.innerHTML = '<div class="skeleton" style="height:60px"></div>';
    openSheet('#notif-sheet');
  }
  try {
    const rows = await getNotifications(state.profile.id, { limit: 40 });
    if (!rows.length) {
      renderEmpty(body, icon('bellOff'), 'No notifications yet');
      return;
    }
    body.innerHTML = rows.map(n => `
      <div class="card card-tight" style="${n.read ? '' : 'border-color:var(--accent)'}">
        <div class="row-between">
          <strong>${esc(n.title)}</strong>
          ${n.read ? '' : '<span class="badge badge-info">New</span>'}
        </div>
        <p class="small muted" style="margin-top:4px">${esc(n.message)}</p>
        <p class="small faint" style="margin-top:6px">${esc(fmtDateTime(n.created_at))}</p>
      </div>`).join('');
  } catch (err) {
    renderError(body, err.message, () => openNotifications());
  }
}

function onNotification(row) {
  refreshUnread();
  refreshQueue();
  if (document.visibilityState === 'visible') {
    toast(`${row.title} — ${row.message}`, 'info', 7000);
  } else {
    showLocalNotification(row.title, row.message, {
      tag: `req-${row.request_id ?? row.id}`,
      url: 'admin.html#/requests'
    });
  }
}
