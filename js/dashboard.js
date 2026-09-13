/**
 * index.html controller — the board everybody else looks at.
 *
 * Three views share one page so that switching is instant on a phone:
 *   now      the status board (readable without an account when enabled)
 *   mine     the signed-in employee's own requests
 *   account  profile, notifications, sign out
 */
import { configured } from './supabase.js';
import { PRIORITY_META, REQUEST_STATUS_META } from './config.js';
import {
  $, $$, esc, el, fmtTime, fmtDateTime, relativeTime, durationText, prefs
} from './utils.js';
import {
  initTheme, initThemeToggle, initOffline, initSheets, openSheet, closeSheet,
  startClock, toastOk, toastError, toast, withBusy, renderEmpty, renderError,
  renderSetupNeeded, confirmAction, registerServiceWorker
} from './ui.js';
import { getProfile, isAdmin, isJoined, signOut, updateMyName, onAuthChange, loginUrl } from './auth.js';
import { getBuildings, getTasks, getSettings } from './data.js';
import { getPublicStatus, describeStatus } from './status.js';
import {
  createRequest, getMyRequests, getRequestTimeline, cancelRequest,
  requestLocation, requestCategory, OPEN_STATUSES
} from './requests.js';
import {
  subscribeBoard, subscribeMyRequests, subscribeNotifications, subscribeConfig, onResume
} from './realtime.js';
import {
  getNotifications, unreadCount, markRead, describePushSetup,
  enablePush, disablePush, showLocalNotification
} from './notifications.js';

/* ================================================================== */
/* State                                                              */
/* ================================================================== */

const state = {
  profile: null,
  snapshot: null,
  myRequests: [],
  mineFilter: prefs.get('mineFilter', 'open'),
  view: 'now',
  unread: 0,
  booted: false
};

/* ================================================================== */
/* Boot                                                               */
/* ================================================================== */

initTheme();
initThemeToggle();
initOffline(online => { if (online && configured && state.booted) refreshBoard(); });
initSheets();
startClock('#clock');
registerServiceWorker();
wireNotificationNavigation();

if (!configured) {
  $('#view-now').hidden = true;
  $('#setup-needed').hidden = false;
  renderSetupNeeded($('#setup-needed'));
} else {
  boot().catch(err => {
    console.error(err);
    renderError($('#hero-host'), err.message || 'Could not start the app.', () => location.reload());
  });
}

async function boot() {
  wireViews();
  wireRequestForm();
  wireAccount();
  wireNotifications();

  if (new URLSearchParams(location.search).get('denied')) {
    toast('That area is for the administrator only.', 'info');
    history.replaceState(null, '', location.pathname);
  }

  state.booted = true;
  const settings = await getSettings();
  state.profile = await loadJoinedProfile();
  applyAuthUI();

  // When the board is private, an unauthenticated visitor gets the
  // sign-in prompt instead of an empty page.
  if (!state.profile && settings.public_dashboard === false) {
    $('#view-now').hidden = true;
    $('#view-signedout').hidden = false;
    return;
  }

  await refreshBoard();
  subscribeBoard(snapshot => paintBoard(snapshot));
  subscribeConfig(() => { populateRequestSelects().catch(console.error); });
  onResume(() => { refreshBoard(); if (state.profile) refreshMine(); });

  // Recompute "expired / time passed" every 20s. Presentation only —
  // this never writes to the database.
  setInterval(() => { if (state.snapshot) paintBoard(state.snapshot, { silent: true }); }, 20000);

  if (state.profile) {
    await Promise.all([refreshMine(), refreshUnread()]);
    subscribeMyRequests(state.profile.id, () => refreshMine());
    subscribeNotifications(state.profile.id, onNotification);
  }

  if (location.hash === '#request') openRequestSheet();
  onAuthChange(async (_event, profile) => {
    state.profile = isJoined(profile) ? profile : null;
    applyAuthUI();
    if (state.profile) { refreshMine(); refreshUnread(); }
  });
}

/**
 * An anonymous account that has not presented the access code yet is
 * inactive: it can see the board, and nothing else. Treat it as signed
 * out so the UI offers the join screen rather than a broken account page.
 */
async function loadJoinedProfile() {
  const profile = await getProfile().catch(() => null);
  return isJoined(profile) ? profile : null;
}

/** Notification clicks ask the open tab to navigate. */
function wireNotificationNavigation() {
  navigator.serviceWorker?.addEventListener?.('message', event => {
    if (event.data?.type === 'navigate' && event.data.url) location.assign(event.data.url);
  });
}

/* ================================================================== */
/* View switching                                                     */
/* ================================================================== */

function wireViews() {
  $$('[data-view]').forEach(btn => {
    btn.addEventListener('click', event => {
      if (btn.tagName === 'A') return;                 // real links navigate
      event.preventDefault();
      showView(btn.dataset.view);
    });
  });
}

function showView(view) {
  state.view = view;
  const authed = Boolean(state.profile);
  const needsAuth = (view === 'mine' || view === 'account') && !authed;

  $('#view-now').hidden = view !== 'now';
  $('#view-mine').hidden = view !== 'mine' || needsAuth;
  $('#view-account').hidden = view !== 'account' || needsAuth;
  $('#view-signedout').hidden = !needsAuth;

  $$('[data-view]').forEach(btn => {
    if (btn.dataset.view === view) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  if (view === 'mine' && authed) refreshMine();
  if (view === 'account' && authed) paintAccount();
  scrollTo({ top: 0, behavior: 'smooth' });
}

function applyAuthUI() {
  const authed = Boolean(state.profile);
  $$('[data-auth-only]').forEach(node => { node.hidden = !authed; });
  $$('[data-admin-only]').forEach(node => { node.hidden = !isAdmin(state.profile); });
  if (!authed && (state.view === 'mine' || state.view === 'account')) showView(state.view);
}

/* ================================================================== */
/* The board                                                          */
/* ================================================================== */

async function refreshBoard() {
  try {
    const snapshot = await getPublicStatus();
    paintBoard(snapshot);
  } catch (err) {
    console.error(err);
    renderError($('#hero-host'), err.message, () => refreshBoard());
  }
}

function paintBoard(snapshot, { silent = false } = {}) {
  state.snapshot = snapshot;
  const view = describeStatus(snapshot.status);

  paintHero(view, snapshot);
  paintServing(snapshot.serving, snapshot.next);
  paintQueue(snapshot.queue ?? []);
  paintCounters(snapshot.counts ?? {});

  if (!silent) document.title = view.known
    ? `${view.meta.label} · Where Is Haitham Now?`
    : 'Where Is Haitham Now?';
}

function paintHero(view, snapshot) {
  const person = snapshot.status?.person || 'Haitham';
  const locationLine = view.location
    ? `<div class="fact"><span class="ico" aria-hidden="true">📍</span>
         <span class="grow"><span class="k">Location</span><span class="v">${esc(view.location)}</span></span></div>`
    : '';
  const taskLine = view.task
    ? `<div class="fact"><span class="ico" aria-hidden="true">🛠️</span>
         <span class="grow"><span class="k">Doing</span><span class="v">${esc(view.task)}</span></span></div>`
    : '';

  const timeBlock = view.startedAt ? `
    <div class="hero-time">
      <div>
        <div class="k">Started</div>
        <div class="v">${esc(fmtTime(view.startedAt))}</div>
      </div>
      <div>
        <div class="k">Expected until</div>
        <div class="v">${view.expectedEndAt ? esc(fmtTime(view.expectedEndAt)) : 'Open ended'}</div>
      </div>
      <div style="grid-column:1 / -1">
        <div class="k">Expected availability</div>
        <div class="v big">${esc(view.availabilityText)}</div>
      </div>
    </div>` : '';

  const expiredNote = view.expired ? `
    <div class="expired-note" role="status">
      <span aria-hidden="true">⏰</span>
      <span>
        <strong>Expected time has passed.</strong>
        ${esc(person)} planned to finish at ${esc(fmtTime(view.expectedEndAt))}
        (${esc(durationText(view.minutesOver))} ago)${view.stale ? ' and has not posted an update yet' : ''}.
        This status may be out of date.
      </span>
    </div>` : '';

  const openTooLong = !view.expired && view.stale ? `
    <div class="expired-note" role="status">
      <span aria-hidden="true">⏰</span>
      <span><strong>This status is a few hours old.</strong> It may be out of date.</span>
    </div>` : '';

  $('#hero-host').innerHTML = `
    <div class="hero" data-tone="${esc(view.meta.tone)}">
      <p class="hero-status ${view.known && !view.expired ? 'live' : ''}">
        <span class="dot" aria-hidden="true"></span>
        <span>${esc(view.meta.label.toUpperCase())}</span>
      </p>
      <p class="hero-hint">${esc(view.known ? view.meta.hint : 'Haitham has not posted a status yet.')}</p>
      ${locationLine || taskLine ? `<div class="hero-facts">${locationLine}${taskLine}</div>` : ''}
      ${timeBlock}
      ${expiredNote}${openTooLong}
      <p class="hero-foot">
        ${view.updatedAt ? `<span>Last updated ${esc(fmtTime(view.updatedAt))} · ${esc(relativeTime(view.updatedAt))}</span>` : ''}
        ${view.startedAt && !view.isFree ? `<span>· Here ${esc(view.elapsedText)}</span>` : ''}
      </p>
    </div>`;
}

function paintServing(serving, next) {
  const card = $('#serving-card');
  const body = $('#serving-body');

  if (serving) {
    body.innerHTML = `
      <p class="serving-person">${esc(serving.requester)}</p>
      <p class="muted">📍 ${esc(serving.location)}</p>
      <p style="margin-top:6px;font-weight:650">🔧 ${esc(serving.category)}</p>
      ${serving.started_at ? `<p class="small faint" style="margin-top:8px">
        Started ${esc(fmtTime(serving.started_at))} · ${esc(relativeTime(serving.started_at))}</p>` : ''}
      <p class="small faint mono" style="margin-top:4px">${esc(serving.request_number)}</p>`;
    card.hidden = false;
  } else if (next) {
    body.innerHTML = `
      <p class="muted small" style="margin-bottom:6px">Nobody is being served right now. Next:</p>
      <p class="serving-person">${esc(next.requester)}</p>
      <p class="muted">📍 ${esc(next.location)} · 🔧 ${esc(next.category)}</p>`;
    card.hidden = false;
  } else {
    card.hidden = true;
  }
}

function paintQueue(queue) {
  const body = $('#queue-body');
  $('#queue-count').textContent = queue.length === 0
    ? 'Nobody waiting'
    : `${queue.length} waiting`;

  if (!queue.length) {
    renderEmpty(body, '🎉', 'Nobody is waiting', 'Haitham has no queue at the moment.');
    return;
  }

  body.innerHTML = `<ol class="queue-list">${queue.map((item, index) => {
    const priority = PRIORITY_META[item.priority] ?? PRIORITY_META.normal;
    const status = REQUEST_STATUS_META[item.status] ?? REQUEST_STATUS_META.pending;
    return `
      <li class="queue-item" data-priority="${esc(item.priority)}">
        <span class="queue-rank" aria-hidden="true">${index + 1}</span>
        <span class="queue-main">
          <span class="queue-name">${esc(item.requester)}</span>
          <span class="queue-meta">📍 ${esc(item.location)} · ${esc(item.category)}</span>
        </span>
        <span class="badge badge-${esc(priority.tone)}">
          <span aria-hidden="true">${priority.icon}</span>${esc(priority.label)}
        </span>
        <span class="sr-only">Status: ${esc(status.label)}</span>
      </li>`;
  }).join('')}</ol>`;
}

function paintCounters(counts) {
  const host = $('#counters');
  host.hidden = false;
  $('#c-waiting').textContent = counts.waiting ?? 0;
  $('#c-urgent').textContent = counts.urgent ?? 0;
  $('#c-very').textContent = counts.very_urgent ?? 0;
}

/* ================================================================== */
/* Request form                                                       */
/* ================================================================== */

const CUSTOM = '__custom__';

function wireRequestForm() {
  $('#request-btn').addEventListener('click', openRequestSheet);
  $('#mine-new').addEventListener('click', openRequestSheet);

  $('#rq-location').addEventListener('change', event => {
    const custom = event.target.value === CUSTOM;
    $('#rq-location-custom-field').hidden = !custom;
    if (custom) $('#rq-location-custom').focus();
  });
  $('#rq-category').addEventListener('change', event => {
    const custom = event.target.value === CUSTOM;
    $('#rq-category-custom-field').hidden = !custom;
    if (custom) $('#rq-category-custom').focus();
  });
  $('#rq-description').addEventListener('input', event => {
    $('#rq-desc-count').textContent = event.target.value.length;
  });

  $('#request-form').addEventListener('submit', onSubmitRequest);
}

async function openRequestSheet() {
  if (!state.profile) {
    location.href = loginUrl('index.html#request');
    return;
  }
  $('#rq-name').textContent = state.profile.full_name;
  $('#request-form').hidden = false;
  $('#rq-success').hidden = true;
  $('#rq-error').hidden = true;

  await populateRequestSelects();

  // Offer the location used last time — most people ask from the same room.
  const lastBuilding = prefs.get('lastRequestBuilding');
  if (lastBuilding && $(`#rq-location option[value="${CSS.escape(lastBuilding)}"]`)) {
    $('#rq-location').value = lastBuilding;
  }

  openSheet('#request-sheet');
}

async function populateRequestSelects() {
  try {
    const [buildings, tasks] = await Promise.all([
      getBuildings({ activeOnly: true }),
      getTasks({ activeOnly: true })
    ]);

    fillSelect($('#rq-location'), buildings, 'Select where you are', '+ Other / custom location');
    fillSelect($('#rq-category'), tasks, 'Select what you need', '+ Other / custom');
  } catch (err) {
    $('#rq-error').textContent = err.message;
    $('#rq-error').hidden = false;
  }
}

function fillSelect(select, rows, placeholder, customLabel) {
  const previous = select.value;
  select.innerHTML =
    `<option value="">${esc(placeholder)}</option>` +
    rows.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('') +
    `<option value="${CUSTOM}">${esc(customLabel)}</option>`;
  if (previous && [...select.options].some(o => o.value === previous)) select.value = previous;
}

async function onSubmitRequest(event) {
  event.preventDefault();
  const errorNode = $('#rq-error');
  errorNode.hidden = true;

  const locationValue = $('#rq-location').value;
  const categoryValue = $('#rq-category').value;

  const payload = {
    buildingId: locationValue && locationValue !== CUSTOM ? locationValue : null,
    customLocation: locationValue === CUSTOM ? $('#rq-location-custom').value : null,
    taskId: categoryValue && categoryValue !== CUSTOM ? categoryValue : null,
    customCategory: categoryValue === CUSTOM ? $('#rq-category-custom').value : null,
    description: $('#rq-description').value,
    priority: $('#rq-priority input:checked')?.value ?? 'normal'
  };

  await withBusy($('#rq-submit'), 'Sending…', async () => {
    try {
      const created = await createRequest(payload);
      if (payload.buildingId) prefs.set('lastRequestBuilding', payload.buildingId);

      $('#request-form').hidden = true;
      $('#rq-success').hidden = false;
      $('#rq-number').textContent = created.request_number;

      const waiting = (state.snapshot?.counts?.waiting ?? 0);
      $('#rq-eta').textContent = waiting > 1
        ? `${waiting - 1} other ${waiting - 1 === 1 ? 'person is' : 'people are'} ahead of you.`
        : 'You are next in the queue.';

      resetRequestForm();
      refreshMine();
      toastOk('Request sent to Haitham.');
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
      errorNode.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
}

function resetRequestForm() {
  $('#request-form').reset();
  $('#rq-location-custom-field').hidden = true;
  $('#rq-category-custom-field').hidden = true;
  $('#rq-desc-count').textContent = '0';
}

/* ================================================================== */
/* My requests                                                        */
/* ================================================================== */

async function refreshMine() {
  if (!state.profile) return;
  const body = $('#mine-body');
  try {
    state.myRequests = await getMyRequests(state.profile.id);
    paintMine();
  } catch (err) {
    renderError(body, err.message, () => refreshMine());
  }
}

$$('[data-mine-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.mineFilter = btn.dataset.mineFilter;
    prefs.set('mineFilter', state.mineFilter);
    $$('[data-mine-filter]').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.mineFilter === state.mineFilter)));
    paintMine();
  });
  btn.setAttribute('aria-pressed', String(btn.dataset.mineFilter === state.mineFilter));
});

function paintMine() {
  const body = $('#mine-body');
  const rows = state.myRequests.filter(r =>
    state.mineFilter === 'all' ? true :
    state.mineFilter === 'open' ? OPEN_STATUSES.includes(r.status) :
    r.status === 'completed');

  if (!rows.length) {
    renderEmpty(body, '📋',
      state.mineFilter === 'open' ? 'No open requests' : 'Nothing here yet',
      'Tap "Request Haitham" when you need help.');
    return;
  }

  body.innerHTML = rows.map(requestCardHTML).join('');
  $$('.req-card', body).forEach(card =>
    card.addEventListener('click', () => openRequestDetail(card.dataset.id)));
}

function requestCardHTML(r) {
  const status = REQUEST_STATUS_META[r.status] ?? REQUEST_STATUS_META.pending;
  const priority = PRIORITY_META[r.priority] ?? PRIORITY_META.normal;
  return `
    <button class="req-card" type="button" data-id="${esc(r.id)}" data-priority="${esc(r.priority)}">
      <span class="req-head">
        <span class="req-num mono">${esc(r.request_number)}</span>
        <span class="badge badge-${esc(status.tone)}">
          <span aria-hidden="true">${status.icon}</span>${esc(status.label)}
        </span>
      </span>
      <span class="req-title">${esc(requestCategory(r))}</span>
      <span class="req-sub">📍 ${esc(requestLocation(r))} · ${esc(fmtDateTime(r.created_at))}</span>
      ${r.priority !== 'normal'
        ? `<span class="badge badge-${esc(priority.tone)}" style="margin-top:8px">
             <span aria-hidden="true">${priority.icon}</span>${esc(priority.label)}</span>`
        : ''}
    </button>`;
}

async function openRequestDetail(id) {
  const request = state.myRequests.find(r => r.id === id);
  if (!request) return;

  const body = $('#detail-body');
  $('#detail-title').textContent = request.request_number;
  body.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  openSheet('#detail-sheet');

  const status = REQUEST_STATUS_META[request.status] ?? REQUEST_STATUS_META.pending;
  const priority = PRIORITY_META[request.priority] ?? PRIORITY_META.normal;

  let timeline = [];
  try {
    timeline = await getRequestTimeline(id);
  } catch (err) {
    console.warn(err);
  }

  body.innerHTML = `
    <div class="stack-sm">
      <div class="row-wrap">
        <span class="badge badge-${esc(status.tone)}"><span aria-hidden="true">${status.icon}</span>${esc(status.label)}</span>
        <span class="badge badge-${esc(priority.tone)}"><span aria-hidden="true">${priority.icon}</span>${esc(priority.label)}</span>
      </div>
      <p class="req-title" style="font-size:18px">${esc(requestCategory(request))}</p>
      <p class="muted">📍 ${esc(requestLocation(request))}</p>
      ${request.description ? `<p class="req-desc">${esc(request.description)}</p>` : ''}
      <p class="small faint">Sent ${esc(fmtDateTime(request.created_at))}</p>
      ${timeline.length ? `<ol class="timeline">${timeline.map(t => `
        <li>
          <strong>${esc(REQUEST_STATUS_META[t.new_status]?.label ?? t.new_status ?? 'Updated')}</strong>
          ${t.notes ? `<div class="small muted">${esc(t.notes)}</div>` : ''}
          <time>${esc(fmtDateTime(t.created_at))}</time>
        </li>`).join('')}</ol>` : ''}
    </div>`;

  if (['pending', 'accepted'].includes(request.status)) {
    const cancelBtn = el('button', {
      class: 'btn btn-danger btn-block',
      type: 'button',
      text: 'Cancel this request',
      style: 'margin-top:18px'
    });
    cancelBtn.addEventListener('click', async () => {
      const ok = await confirmAction(
        'Cancel this request? Haitham will see that you no longer need help.',
        { confirmText: 'Cancel request', danger: true, title: request.request_number });
      if (!ok) return;
      await withBusy(cancelBtn, 'Cancelling…', async () => {
        try {
          await cancelRequest(request.id, 'Cancelled by the requester');
          toastOk('Request cancelled.');
          closeSheet('#detail-sheet');
          refreshMine();
        } catch (err) {
          toastError(err.message);
        }
      });
    });
    body.append(cancelBtn);
  }
}

/* ================================================================== */
/* Notifications                                                      */
/* ================================================================== */

function wireNotifications() {
  $('#bell').addEventListener('click', openNotifications);
  $('#notif-read-all').addEventListener('click', async event => {
    await withBusy(event.currentTarget, 'Marking…', async () => {
      try {
        await markRead(null);
        await refreshUnread();
        await openNotifications({ keepOpen: true });
      } catch (err) {
        toastError(err.message);
      }
    });
  });
}

async function refreshUnread() {
  if (!state.profile) return;
  state.unread = await unreadCount(state.profile.id);
  const dot = $('#bell-dot');
  dot.hidden = state.unread === 0;
  dot.textContent = state.unread > 9 ? '9+' : String(state.unread);
}

async function openNotifications({ keepOpen = false } = {}) {
  if (!state.profile) return;
  const body = $('#notif-body');
  if (!keepOpen) {
    body.innerHTML = '<div class="skeleton" style="height:60px"></div>';
    openSheet('#notif-sheet');
  }
  try {
    const rows = await getNotifications(state.profile.id);
    if (!rows.length) {
      renderEmpty(body, '🔕', 'No notifications yet', 'Updates about your requests appear here.');
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
  refreshMine();
  if (document.visibilityState === 'visible') {
    toast(`${row.title} — ${row.message}`, 'info', 6000);
  } else {
    showLocalNotification(row.title, row.message, { tag: `req-${row.request_id ?? row.id}`, url: 'index.html' });
  }
}

/* ================================================================== */
/* Account                                                            */
/* ================================================================== */

function wireAccount() {
  $('#signout-btn').addEventListener('click', async event => {
    const ok = await confirmAction('Sign out of this device?', { confirmText: 'Sign out' });
    if (!ok) return;
    await withBusy(event.currentTarget, 'Signing out…', async () => {
      try {
        await signOut();
        location.replace('index.html');
      } catch (err) {
        toastError(err.message);
      }
    });
  });

  $('#acct-save-name').addEventListener('click', async event => {
    await withBusy(event.currentTarget, 'Saving…', async () => {
      try {
        state.profile = await updateMyName($('#acct-name-input').value);
        paintAccount();
        toastOk('Name saved.');
      } catch (err) {
        toastError(err.message);
      }
    });
  });

  $('#push-enable').addEventListener('click', async event => {
    await withBusy(event.currentTarget, 'Enabling…', async () => {
      try {
        await enablePush();
        toastOk('Notifications are on for this device.');
      } catch (err) {
        toast(err.message, 'info', 8000);
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
}

function paintAccount() {
  if (!state.profile) return;
  $('#acct-name').textContent = state.profile.full_name;
  $('#acct-email').textContent = state.profile.email
    || 'Joined with an access code on this device';
  $('#acct-name-input').value = state.profile.full_name;
  const role = $('#acct-role');
  role.textContent = isAdmin(state.profile) ? 'Administrator' : 'Employee';
  role.className = `badge ${isAdmin(state.profile) ? 'badge-info' : 'badge-muted'}`;
  paintPushState();
}

async function paintPushState() {
  const setup = await describePushSetup();
  const blocked = ['unsupported', 'not-configured', 'blocked'].includes(setup.level);

  const state = $('#push-state');
  state.textContent = setup.text;
  state.className = blocked ? 'notice notice-warn' : 'small muted';

  $('#push-enable').hidden = setup.level === 'on' || blocked;
  $('#push-enable').disabled = false;
  $('#push-disable').hidden = setup.level !== 'on';
}

/* ================================================================== */
/* Keyboard shortcut: "r" opens the request form on desktop           */
/* ================================================================== */
addEventListener('keydown', event => {
  if (event.key !== 'r' || event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (document.querySelector('dialog[open]')) return;
  openRequestSheet();
});
