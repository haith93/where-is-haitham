/**
 * index.html controller — the board everybody looks at.
 *
 * There is no sign-in here at all. Anyone who opens the page can read the
 * board and send a request. The only thing kept on the device is a list of
 * tokens for requests sent from it, so the person can follow their own
 * request without an account.
 */
import { configured } from './supabase.js';
import { PRIORITY_META, REQUEST_STATUS_META } from './config.js';
import { $, $$, esc, el, fmtTime, fmtDateTime, relativeTime, durationText, prefs } from './utils.js';
import { t, apply as applyI18n, applyDocument, initLangToggle, onLangChange } from './i18n.js';
import {
  initTheme, initThemeToggle, initOffline, initSheets, openSheet, closeSheet,
  startClock, toastOk, toastError, toast, withBusy, renderEmpty, renderError,
  renderSetupNeeded, confirmAction, registerServiceWorker
} from './ui.js';
import { getBuildings, getTasks, localName } from './data.js';
import { getPublicStatus, describeStatus, statusLabel } from './status.js';
import {
  createPublicRequest, rememberRequest, forgetRequest, rememberedRequests,
  getMyDeviceRequests, cancelMyRequest, updateMyRequest,
  requestLocation, requestCategory, OPEN_STATUSES
} from './requests.js';
import { subscribeBoard, subscribeConfig, onResume } from './realtime.js';

/* ================================================================== */
/* State                                                              */
/* ================================================================== */

const state = {
  snapshot: null,
  myRequests: [],
  view: 'now',
  booted: false
};

/* ================================================================== */
/* Boot                                                               */
/* ================================================================== */

applyDocument();
initTheme();
initThemeToggle();
initLangToggle();
initOffline(online => { if (online && configured && state.booted) refreshBoard(); });
initSheets();
startClock('#clock');
registerServiceWorker();

// A language switch re-renders everything that JavaScript drew, so the
// current screen and scroll position survive.
onLangChange(() => {
  applyI18n(document);
  if (state.snapshot) paintBoard(state.snapshot, { silent: true });
  paintMine();
});

if (!configured) {
  $('#view-now').hidden = true;
  $('#setup-needed').hidden = false;
  renderSetupNeeded($('#setup-needed'));
} else {
  boot().catch(err => {
    console.error(err);
    renderError($('#hero-host'), err.message || t('error.generic'), () => location.reload());
  });
}

async function boot() {
  state.booted = true;

  wireViews();
  wireRequestForm();
  wireAdminGesture();

  await refreshBoard();
  subscribeBoard(snapshot => paintBoard(snapshot));
  subscribeConfig(() => { populateRequestSelects().catch(console.error); });
  onResume(() => { refreshBoard(); refreshMine(); });

  // Presentation-only tick so "expected time has passed" stays truthful.
  setInterval(() => { if (state.snapshot) paintBoard(state.snapshot, { silent: true }); }, 20000);

  refreshMine();

  if (location.hash === '#request') openRequestSheet();
}

/* ================================================================== */
/* View switching                                                     */
/* ================================================================== */

function wireViews() {
  $$('[data-view]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.preventDefault();
      showView(btn.dataset.view);
    });
  });
}

function showView(view) {
  state.view = view;
  $('#view-now').hidden = view !== 'now';
  $('#view-mine').hidden = view !== 'mine';

  $$('[data-view]').forEach(btn => {
    if (btn.dataset.view === view) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  if (view === 'mine') refreshMine();
  scrollTo({ top: 0, behavior: 'smooth' });
}

/* ================================================================== */
/* The board                                                          */
/* ================================================================== */

async function refreshBoard() {
  try {
    paintBoard(await getPublicStatus());
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

  if (!silent) {
    const title = statusLabel(view, snapshot.serving?.requester ?? null);
    document.title = view.known ? `${title} · ${t('app.name')}` : t('app.name');
  }
}

function paintHero(view, snapshot) {
  const servingName = snapshot.serving?.requester ?? null;
  const locationLine = view.location
    ? `<div class="fact"><span class="ico" aria-hidden="true">📍</span>
         <span class="grow"><span class="k">${esc(t('board.location'))}</span>
         <span class="v">${esc(view.location)}</span></span></div>`
    : '';
  const taskLine = view.task
    ? `<div class="fact"><span class="ico" aria-hidden="true">🛠️</span>
         <span class="grow"><span class="k">${esc(t('board.doing'))}</span>
         <span class="v">${esc(view.task)}</span></span></div>`
    : '';

  const timeBlock = view.startedAt ? `
    <div class="hero-time">
      <div>
        <div class="k">${esc(t('board.started'))}</div>
        <div class="v">${esc(fmtTime(view.startedAt))}</div>
      </div>
      <div>
        <div class="k">${esc(t('board.expectedUntil'))}</div>
        <div class="v">${view.expectedEndAt ? esc(fmtTime(view.expectedEndAt)) : esc(t('board.openEnded'))}</div>
      </div>
      <div style="grid-column:1 / -1">
        <div class="k">${esc(t('board.availability'))}</div>
        <div class="v big">${esc(availabilityText(view))}</div>
      </div>
    </div>` : '';

  const expiredNote = view.expired ? `
    <div class="expired-note" role="status">
      <span aria-hidden="true">⏰</span>
      <span><strong>${esc(t('board.expiredTitle'))}</strong> ${esc(t('board.expiredBody'))}</span>
    </div>` : (view.stale ? `
    <div class="expired-note" role="status">
      <span aria-hidden="true">⏰</span>
      <span><strong>${esc(t('board.staleTitle'))}</strong> ${esc(t('board.expiredBody'))}</span>
    </div>` : '');

  $('#hero-host').innerHTML = `
    <div class="hero" data-tone="${esc(view.meta.tone)}">
      <p class="hero-status ${view.known && !view.expired ? 'live' : ''}">
        <span class="dot" aria-hidden="true"></span>
        <span>${esc(view.known ? statusLabel(view, servingName) : t('board.noStatus'))}</span>
      </p>
      <p class="hero-hint">${esc(view.known ? view.meta.hint : t('board.noStatusHint'))}</p>
      ${locationLine || taskLine ? `<div class="hero-facts">${locationLine}${taskLine}</div>` : ''}
      ${timeBlock}
      ${expiredNote}
      <p class="hero-foot">
        ${view.updatedAt ? `<span>${esc(t('board.lastUpdated'))} ${esc(fmtTime(view.updatedAt))} · ${esc(relativeTime(view.updatedAt))}</span>` : ''}
        ${view.startedAt && !view.isFree ? `<span>· ${esc(t('board.here'))} ${esc(view.elapsedText)}</span>` : ''}
      </p>
    </div>`;
}

/** Localised version of the availability line. */
function availabilityText(view) {
  if (view.isFree) return t('board.now');
  if (!view.expectedEndAt) return t('board.notStated');
  return fmtTime(view.expectedEndAt);
}

function paintServing(serving, next) {
  const card = $('#serving-card');
  const body = $('#serving-body');

  if (serving) {
    body.innerHTML = `
      <p class="serving-person">${esc(serving.requester)}</p>
      <p class="muted">📍 ${esc(requestLocation(serving))}</p>
      <p style="margin-top:6px;font-weight:650">🔧 ${esc(requestCategory(serving))}</p>
      ${serving.started_at ? `<p class="small faint" style="margin-top:8px">
        ${esc(t('board.started'))} ${esc(fmtTime(serving.started_at))} · ${esc(relativeTime(serving.started_at))}</p>` : ''}
      <p class="small faint mono" style="margin-top:4px">${esc(serving.request_number)}</p>`;
    card.hidden = false;
  } else if (next) {
    body.innerHTML = `
      <p class="muted small" style="margin-bottom:6px">${esc(t('board.nextUp'))}</p>
      <p class="serving-person">${esc(next.requester)}</p>
      <p class="muted">📍 ${esc(requestLocation(next))} · 🔧 ${esc(requestCategory(next))}</p>`;
    card.hidden = false;
  } else {
    card.hidden = true;
  }
}

function paintQueue(queue) {
  const body = $('#queue-body');
  $('#queue-count').textContent = queue.length === 0
    ? t('board.nobodyWaiting')
    : t('board.countWaiting', { n: queue.length });

  if (!queue.length) {
    renderEmpty(body, '🎉', t('board.nobodyWaiting'), t('board.nobodyWaitingHint'));
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
          <span class="queue-meta">📍 ${esc(requestLocation(item))} · ${esc(requestCategory(item))}</span>
        </span>
        <span class="badge badge-${esc(priority.tone)}">
          <span aria-hidden="true">${priority.icon}</span>${esc(priority.label)}
        </span>
        <span class="sr-only">${esc(status.label)}</span>
      </li>`;
  }).join('')}</ol>`;
}

function paintCounters(counts) {
  $('#counters').hidden = false;
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
  $('#request-form').hidden = false;
  $('#rq-success').hidden = true;
  $('#rq-error').hidden = true;

  await populateRequestSelects();

  // Most people ask from the same room, and type the same name, every time.
  const lastName = prefs.get('lastName');
  if (lastName && !$('#rq-name').value) $('#rq-name').value = lastName;

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
    fillSelect($('#rq-location'), buildings, t('form.selectLocation'), t('form.customLocation'));
    fillSelect($('#rq-category'), tasks, t('form.selectNeed'), t('form.customNeed'));
  } catch (err) {
    $('#rq-error').textContent = err.message;
    $('#rq-error').hidden = false;
  }
}

function fillSelect(select, rows, placeholder, customLabel) {
  const previous = select.value;
  select.innerHTML =
    `<option value="">${esc(placeholder)}</option>` +
    rows.map(r => `<option value="${esc(r.id)}">${esc(localName(r))}</option>`).join('') +
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
    requesterName: $('#rq-name').value,
    buildingId: locationValue && locationValue !== CUSTOM ? locationValue : null,
    customLocation: locationValue === CUSTOM ? $('#rq-location-custom').value : null,
    taskId: categoryValue && categoryValue !== CUSTOM ? categoryValue : null,
    customCategory: categoryValue === CUSTOM ? $('#rq-category-custom').value : null,
    description: $('#rq-description').value,
    priority: $('#rq-priority input:checked')?.value ?? 'normal'
  };

  await withBusy($('#rq-submit'), t('action.sending'), async () => {
    try {
      const created = await createPublicRequest(payload);
      rememberRequest(created);

      prefs.set('lastName', payload.requesterName.trim());
      if (payload.buildingId) prefs.set('lastRequestBuilding', payload.buildingId);

      $('#request-form').hidden = true;
      $('#rq-success').hidden = false;
      $('#rq-number').textContent = created.request_number;
      $('#rq-eta').textContent = created.people_ahead > 0
        ? t('form.peopleAhead', { n: created.people_ahead })
        : t('form.youAreNext');

      resetRequestForm();
      refreshMine();
    } catch (err) {
      errorNode.textContent = err.message;
      errorNode.hidden = false;
      errorNode.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
}

function resetRequestForm() {
  const name = $('#rq-name').value;
  $('#request-form').reset();
  $('#rq-name').value = name;                 // keep the name for next time
  $('#rq-location-custom-field').hidden = true;
  $('#rq-category-custom-field').hidden = true;
  $('#rq-desc-count').textContent = '0';
}

/* ================================================================== */
/* My requests (this device)                                          */
/* ================================================================== */

async function refreshMine() {
  if (!rememberedRequests().length) {
    state.myRequests = [];
    paintMine();
    return;
  }
  try {
    state.myRequests = await getMyDeviceRequests();
  } catch (err) {
    console.warn(err);
  }
  paintMine();
}

function paintMine() {
  const body = $('#mine-body');
  if (!body) return;

  if (!state.myRequests.length) {
    renderEmpty(body, '📋', t('mine.empty'), t('mine.emptyHint'));
    return;
  }

  body.innerHTML = state.myRequests.map(r => {
    const status = REQUEST_STATUS_META[r.status] ?? REQUEST_STATUS_META.pending;
    const priority = PRIORITY_META[r.priority] ?? PRIORITY_META.normal;
    return `
      <button class="req-card" type="button" data-token="${esc(r.token)}" data-priority="${esc(r.priority)}">
        <span class="req-head">
          <span class="req-num mono">${esc(r.request_number)}</span>
          <span class="badge badge-${esc(status.tone)}">
            <span aria-hidden="true">${status.icon}</span>${esc(status.label)}
          </span>
        </span>
        <span class="req-title">${esc(requestCategory(r))}</span>
        <span class="req-sub">📍 ${esc(requestLocation(r))} · ${esc(t('mine.sent'))} ${esc(fmtDateTime(r.created_at))}</span>
        ${r.status === 'pending' && r.people_ahead > 0
          ? `<span class="req-sub">⏳ ${esc(t('mine.ahead', { n: r.people_ahead }))}</span>` : ''}
        ${r.priority !== 'normal'
          ? `<span class="badge badge-${esc(priority.tone)}" style="margin-top:8px">
               <span aria-hidden="true">${priority.icon}</span>${esc(priority.label)}</span>` : ''}
      </button>`;
  }).join('');

  $$('.req-card', body).forEach(card =>
    card.addEventListener('click', () => openMyRequest(card.dataset.token)));
}

function openMyRequest(token) {
  const request = state.myRequests.find(r => r.token === token);
  if (!request) return;

  const status = REQUEST_STATUS_META[request.status] ?? REQUEST_STATUS_META.pending;
  const priority = PRIORITY_META[request.priority] ?? PRIORITY_META.normal;
  const body = $('#detail-body');

  $('#detail-title').textContent = request.request_number;
  body.innerHTML = `
    <div class="stack-sm">
      <div class="row-wrap">
        <span class="badge badge-${esc(status.tone)}">${status.icon} ${esc(status.label)}</span>
        <span class="badge badge-${esc(priority.tone)}">${priority.icon} ${esc(priority.label)}</span>
      </div>
      <p class="req-title" style="font-size:18px">${esc(requestCategory(request))}</p>
      <p class="muted">📍 ${esc(requestLocation(request))}</p>
      ${request.description ? `<p class="req-desc">${esc(request.description)}</p>` : ''}
      <p class="small faint">${esc(t('mine.sent'))} ${esc(fmtDateTime(request.created_at))}</p>
      ${request.accepted_at ? `<p class="small faint">${esc(REQUEST_STATUS_META.accepted.label)} · ${esc(fmtDateTime(request.accepted_at))}</p>` : ''}
      ${request.started_at ? `<p class="small faint">${esc(REQUEST_STATUS_META.in_progress.label)} · ${esc(fmtDateTime(request.started_at))}</p>` : ''}
      ${request.completed_at ? `<p class="small faint">${esc(REQUEST_STATUS_META.completed.label)} · ${esc(fmtDateTime(request.completed_at))}</p>` : ''}
    </div>`;

  openSheet('#detail-sheet');

  // Editing is for pending only; after that he has planned around it.
  if (request.status === 'pending') {
    const editBtn = el('button', {
      class: 'btn btn-soft btn-block',
      type: 'button',
      text: t('mine.edit'),
      style: 'margin-top:18px'
    });
    editBtn.addEventListener('click', () => openEditRequest(request));
    body.append(editBtn);
  } else if (OPEN_STATUSES.includes(request.status)) {
    body.append(el('p', { class: 'help', style: 'margin-top:14px', text: t('mine.editClosed') }));
  }

  if (OPEN_STATUSES.includes(request.status) && request.status !== 'in_progress') {
    const cancelBtn = el('button', {
      class: 'btn btn-danger btn-block',
      type: 'button',
      text: t('mine.cancel'),
      style: 'margin-top:18px'
    });
    cancelBtn.addEventListener('click', async () => {
      if (!await confirmAction(t('mine.cancelConfirm'), { confirmText: t('mine.cancel'), danger: true })) return;
      await withBusy(cancelBtn, t('action.working'), async () => {
        try {
          await cancelMyRequest(token);
          toastOk(t('mine.cancelled'));
          closeSheet('#detail-sheet');
          refreshMine();
        } catch (err) {
          toastError(err.message);
        }
      });
    });
    body.append(cancelBtn);
  }

  const forgetBtn = el('button', {
    class: 'btn btn-ghost btn-sm btn-block',
    type: 'button',
    text: t('mine.forget'),
    style: 'margin-top:8px',
    onclick: () => {
      forgetRequest(token);
      closeSheet('#detail-sheet');
      refreshMine();
    }
  });
  body.append(forgetBtn);
}

/** Change a pending request: more detail, or a different urgency. */
function openEditRequest(request) {
  const body = $('#detail-body');
  $('#detail-title').textContent = t('mine.editTitle');

  body.innerHTML = `
    <div class="stack">
      <p class="help">${esc(t('mine.editHint'))}</p>
      <div class="field">
        <label class="label" for="edit-desc">${esc(t('form.description'))}</label>
        <textarea class="textarea" id="edit-desc" maxlength="1000">${esc(request.description ?? '')}</textarea>
      </div>
      <fieldset class="field" style="border:0;padding:0;margin:0">
        <legend class="label">${esc(t('form.priority'))}</legend>
        <div class="segmented" id="edit-priority">
          ${Object.entries(PRIORITY_META).map(([key, meta]) => `
            <input type="radio" name="edit_priority" id="ep-${esc(key)}" value="${esc(key)}"
                   ${request.priority === key ? 'checked' : ''}>
            <label for="ep-${esc(key)}">${meta.icon} <span>${esc(meta.label)}</span></label>`).join('')}
        </div>
      </fieldset>
      <p class="error" id="edit-error" role="alert" hidden></p>
    </div>`;

  const save = el('button', {
    class: 'btn btn-primary btn-lg btn-block',
    type: 'button',
    text: t('mine.editSave'),
    style: 'margin-top:18px'
  });
  save.addEventListener('click', async () => {
    await withBusy(save, t('action.saving'), async () => {
      try {
        await updateMyRequest(request.token, {
          description: $('#edit-desc').value,
          priority: $('#edit-priority input:checked')?.value
        });
        toastOk(t('mine.edited'));
        closeSheet('#detail-sheet');
        refreshMine();
      } catch (err) {
        const node = $('#edit-error');
        node.textContent = err.message;
        node.hidden = false;
      }
    });
  });
  body.append(save);
}

/* ================================================================== */
/* Getting to the admin console from an installed app                 */
/*                                                                    */
/* A standalone PWA has no address bar, and the public page carries no */
/* admin link, so Haitham had no way in from his home screen. Ten taps */
/* on the clock opens it and remembers the device, after which a normal */
/* Admin link appears in the navigation.                               */
/*                                                                    */
/* This hides the door; it is not the lock. The console still requires */
/* a password, and RLS still refuses anyone who is not an admin.       */
/* ================================================================== */

/* Declared as a function, not a const: boot() calls wireAdminGesture during
   module evaluation, and a const declared further down the file is still in
   its temporal dead zone at that point. */
function adminUnlocked() {
  return prefs.get('adminUnlocked', false) === true;
}

function revealAdminLinks() {
  ['#admin-link-nav', '#admin-link-desktop'].forEach(sel => {
    const node = $(sel);
    if (node) node.hidden = false;
  });
}

function wireAdminGesture() {
  if (adminUnlocked()) revealAdminLinks();

  const clock = $('#clock');
  if (!clock) return;

  let taps = 0;
  let reset;

  clock.addEventListener('click', () => {
    if (adminUnlocked()) {
      location.href = 'admin.html';
      return;
    }

    taps += 1;
    clearTimeout(reset);
    reset = setTimeout(() => { taps = 0; }, 2000);   // pause and start over

    const left = 10 - taps;
    if (left <= 0) {
      taps = 0;
      prefs.set('adminUnlocked', true);
      revealAdminLinks();
      toastOk(t('admin.unlocked'));
      setTimeout(() => { location.href = 'admin.html'; }, 900);
    } else if (left <= 4) {
      // Quiet countdown once you are clearly doing it on purpose.
      const key = left === 1 ? 'admin.tapsLeft1'
                : left === 2 ? 'admin.tapsLeft2'
                : 'admin.tapsLeft';
      toast(t(key, { n: left }), 'info', 1100);
    }
  });
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
