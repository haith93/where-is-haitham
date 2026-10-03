/**
 * index.html controller — the board everybody looks at.
 *
 * There is no sign-in here at all. Anyone who opens the page can read the
 * board and send a request. The only thing kept on the device is a list of
 * tokens for requests sent from it, so the person can follow their own
 * request without an account.
 */
import { configured } from './supabase.js';
import { icon, paintIcons } from './icons.js';
import { PRIORITY_META, REQUEST_STATUS_META } from './config.js';
import { $, $$, esc, el, fmtTime, fmtDateTime, relativeTime, durationText, prefs } from './utils.js';
import { t, apply as applyI18n, applyDocument, initLangToggle, onLangChange, getLang } from './i18n.js';
import { priorityMessage, availabilityMessage } from './messages.js';
import {
  initTheme, initThemeToggle, initOffline, initSheets, openSheet, closeSheet,
  startClock, toastOk, toastError, toast, withBusy, renderEmpty, renderError,
  renderSetupNeeded, confirmAction, registerServiceWorker
} from './ui.js';
import { getBuildings, getTasks, localName } from './data.js';
import {
  uploadDocument, createPrintRequest, getPaperSizes, openPrintDocument,
  checkFile, fileSizeText, settingsLine, publicPrintLine,
  MAX_FILE_BYTES, ACCEPT_ATTRIBUTE
} from './print.js';
import { getGrades, sectionsOf, levelsOf, gradesOf, destinationText } from './school.js';
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
paintIcons();
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
  paintPriorityQuip();
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
  wirePrintForm();
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
  // The joke sits next to the plain hint, never instead of it: somebody
  // deciding whether to walk across the complex needs the fact first.
  const quip = view.known && !view.expired
    ? availabilityMessage(snapshot.status?.status_type, snapshot.status?.updated_at)
    : '';
  const locationLine = view.location
    ? `<div class="fact"><span class="ico">${icon('pin')}</span>
         <span class="grow"><span class="k">${esc(t('board.location'))}</span>
         <span class="v">${esc(view.location)}</span></span></div>`
    : '';
  const taskLine = view.task
    ? `<div class="fact"><span class="ico">${icon('wrench')}</span>
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
      ${icon('alarm')}
      <span><strong>${esc(t('board.expiredTitle'))}</strong> ${esc(t('board.expiredBody'))}</span>
    </div>` : (view.stale ? `
    <div class="expired-note" role="status">
      ${icon('alarm')}
      <span><strong>${esc(t('board.staleTitle'))}</strong> ${esc(t('board.expiredBody'))}</span>
    </div>` : '');

  $('#hero-host').innerHTML = `
    <div class="hero" data-tone="${esc(view.meta.tone)}">
      <p class="hero-status ${view.known && !view.expired ? 'live' : ''}">
        <span class="dot" aria-hidden="true"></span>
        <span>${esc(view.known ? statusLabel(view, servingName) : t('board.noStatus'))}</span>
      </p>
      <p class="hero-hint">${esc(view.known ? view.meta.hint : t('board.noStatusHint'))}</p>
      ${quip ? `<p class="quip quip-quiet">${esc(quip)}</p>` : ''}
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
      <p class="muted">${icon('pin')} ${esc(requestLocation(serving))}</p>
      <p style="margin-top:6px;font-weight:650">${serving.request_type === 'print'
        ? `${icon('files')} ${esc(publicPrintLine(serving.requester, serving.print_title))}`
        : `${icon('wrench')} ${esc(requestCategory(serving))}`}</p>
      ${serving.started_at ? `<p class="small faint" style="margin-top:8px">
        ${esc(t('board.started'))} ${esc(fmtTime(serving.started_at))} · ${esc(relativeTime(serving.started_at))}</p>` : ''}
      <p class="small faint mono" style="margin-top:4px">${esc(serving.request_number)}</p>`;
    card.hidden = false;
  } else if (next) {
    body.innerHTML = `
      <p class="muted small" style="margin-bottom:6px">${esc(t('board.nextUp'))}</p>
      <p class="serving-person">${esc(next.requester)}</p>
      <p class="muted">${icon('pin')} ${esc(requestLocation(next))} · ${icon('wrench')} ${esc(requestCategory(next))}</p>`;
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
    renderEmpty(body, icon('party'), t('board.nobodyWaiting'), t('board.nobodyWaitingHint'));
    return;
  }

  body.innerHTML = `<ol class="queue-list">${queue.map((item, index) => {
    const priority = PRIORITY_META[item.priority] ?? PRIORITY_META.normal;
    const status = REQUEST_STATUS_META[item.status] ?? REQUEST_STATUS_META.pending;
    return `
      <li class="queue-item" data-priority="${esc(item.priority)}"
          data-type="${esc(item.request_type ?? 'help')}">
        <span class="queue-rank" aria-hidden="true">${index + 1}</span>
        <span class="queue-main">
          <span class="queue-name">${esc(item.requester)}</span>
          <span class="queue-meta">${item.request_type === 'print'
            ? `${icon('files')} ${esc(publicPrintLine(item.requester, item.print_title))}`
            : `${icon('pin')} ${esc(requestLocation(item))} · ${esc(requestCategory(item))}`}</span>
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
  $('#c-life').textContent = counts.life_death ?? 0;
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

  // Delegated, so a fifth urgency would need no new listener.
  $('#rq-priority').addEventListener('change', paintPriorityQuip);

  $('#request-form').addEventListener('submit', onSubmitRequest);
}

/** The playful line under the urgency picker. Wording lives in messages.js. */
function paintPriorityQuip() {
  const chosen = $('#rq-priority input:checked')?.value ?? 'normal';
  const node = $('#rq-quip');
  if (!node) return;
  node.textContent = priorityMessage(chosen);
  node.dataset.priority = chosen;
}

async function openRequestSheet() {
  $('#request-form').hidden = false;
  $('#rq-success').hidden = true;
  $('#rq-error').hidden = true;

  await populateRequestSelects();
  paintPriorityQuip();
  await preparePrintForm();

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
  paintPriorityQuip();
}


/* ================================================================== */
/* Print requests                                                     */
/*                                                                    */
/* A second form beside the help one, not a change to it. The two      */
/* share the sheet, the location dropdown and the urgency scale, and   */
/* nothing here touches the help path.                                 */
/* ================================================================== */

const printState = {
  file: null,       // the File the colleague chose
  upload: null,     // the receipt once it has been stored
  grades: [],
  busy: false
};

/** Show one of the two forms. */
function showRequestTab(which) {
  const printing = which === 'print';
  $('#request-form').hidden = printing;
  $('#print-form').hidden = !printing;
  $$('[data-reqtab]').forEach(btn => {
    btn.setAttribute('aria-selected', String(btn.dataset.reqtab === which));
  });
  prefs.set('requestTab', which);
  const sheet = $('#request-sheet .sheet-panel');
  if (sheet) sheet.scrollTop = 0;
}

function wirePrintForm() {
  $$('[data-reqtab]').forEach(btn => {
    btn.addEventListener('click', () => showRequestTab(btn.dataset.reqtab));
  });

  const file = $('#pq-file');
  file.setAttribute('accept', ACCEPT_ATTRIBUTE);

  $('#pq-file-btn').addEventListener('click', () => file.click());
  file.addEventListener('change', onPickFile);

  // Colour is the only field that reveals another. Asking the permission
  // question for a black and white job would be noise.
  $('#pq-colour').addEventListener('change', paintColourFields);
  $('#pq-permission').addEventListener('change', paintColourFields);

  $('#pq-section').addEventListener('change', paintLevels);
  $('#pq-level').addEventListener('change', paintGrades);

  $('#pq-note').addEventListener('input', event => {
    $('#pq-note-count').textContent = event.target.value.length;
  });

  $('#pq-priority').addEventListener('change', paintPrintQuip);

  $('#print-form').addEventListener('submit', onSubmitPrint);
}

/** Fill the dropdowns the print form needs. Cheap after the first time. */
async function preparePrintForm() {
  const help = $('#pq-file-help');
  if (help) help.textContent = t('print.fileHelp', { max: fileSizeText(MAX_FILE_BYTES) });

  const sizes = await getPaperSizes();
  $('#pq-paper').innerHTML = sizes
    .map(row => `<option value="${esc(row.code)}">${esc(getLangLabel(row))}</option>`)
    .join('');

  printState.grades = await getGrades();
  paintSections();
  paintColourFields();
  paintPrintQuip();
  $('#pq-note-count').textContent = String($('#pq-note').value.length);

  showRequestTab(prefs.get('requestTab', 'help') === 'print' ? 'print' : 'help');
}

const getLangLabel = row => (getLang() === 'ar' && row.label_ar) ? row.label_ar : row.label;

function paintSections() {
  const sections = sectionsOf(printState.grades);
  $('#pq-section').innerHTML =
    `<option value="">${esc(t('print.anySection'))}</option>` +
    sections.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  paintLevels();
}

function paintLevels() {
  const section = $('#pq-section').value;
  const levels = section ? levelsOf(printState.grades, section) : [];
  $('#pq-level-field').hidden = levels.length === 0;
  $('#pq-level').innerHTML =
    `<option value="">${esc(t('print.chooseLevel'))}</option>` +
    levels.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  paintGrades();
}

function paintGrades() {
  const section = $('#pq-section').value;
  const level = $('#pq-level').value;
  const grades = (section && level) ? gradesOf(printState.grades, section, level) : [];
  $('#pq-grade-field').hidden = grades.length === 0;
  $('#pq-grade').innerHTML =
    `<option value="">${esc(t('print.chooseGrade'))}</option>` +
    grades.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
}

function paintColourFields() {
  const colour = $('#pq-colour input:checked')?.value === 'color';
  $('#pq-permission-field').hidden = !colour;

  // Answering "No" is not ignored: it is shown as the reason the button
  // will not work, which is friendlier than a failed submit.
  const refused = colour && $('#pq-permission input:checked')?.value === 'no';
  $('#pq-permission-warn').hidden = !refused;
  $('#pq-submit').disabled = refused;
}

function paintPrintQuip() {
  const chosen = $('#pq-priority input:checked')?.value ?? 'normal';
  const node = $('#pq-quip');
  if (!node) return;
  node.textContent = priorityMessage(chosen);
  node.dataset.priority = chosen;
}

/**
 * The file is uploaded as soon as it is chosen, not on submit: by the
 * time the colleague has filled in the rest, the slow part is done.
 */
async function onPickFile(event) {
  const file = event.target.files?.[0] ?? null;
  printState.file = file;
  printState.upload = null;
  $('#pq-error').hidden = true;

  const chip = $('#pq-file-chip');
  if (!file) { chip.hidden = true; return; }

  const problem = checkFile(file);
  if (problem) {
    chip.hidden = true;
    showPrintError(problem);
    event.target.value = '';
    printState.file = null;
    return;
  }

  chip.hidden = false;
  chip.innerHTML = `<span class="filechip">
      <span class="ico" data-icon="files" aria-hidden="true"></span>
      <span class="grow">${esc(file.name)}</span>
      <span class="mono">${esc(fileSizeText(file.size))}</span>
    </span>`;
  paintIcons(chip);
  $('#pq-file-btn-text').textContent = t('print.change');

  const bar = $('#pq-progress');
  const fill = $('#pq-progress-fill');
  bar.hidden = false;
  fill.style.width = '0%';
  $('#pq-submit').disabled = true;

  try {
    printState.upload = await uploadDocument(file, percent => {
      fill.style.width = percent + '%';
      chip.querySelector('.mono').textContent = t('print.uploading', { n: percent });
    });
    fill.style.width = '100%';
    chip.querySelector('.mono').textContent = t('print.uploaded');
  } catch (err) {
    bar.hidden = true;
    chip.hidden = true;
    printState.file = null;
    event.target.value = '';
    $('#pq-file-btn-text').textContent = t('print.choose');
    showPrintError(err.message);
  } finally {
    paintColourFields();     // restores the disabled state correctly
  }
}

function showPrintError(message) {
  const node = $('#pq-error');
  node.textContent = message;
  node.hidden = false;
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function onSubmitPrint(event) {
  event.preventDefault();
  if (printState.busy) return;
  $('#pq-error').hidden = true;

  if (!printState.upload) {
    showPrintError(t('print.errNoFile'));
    return;
  }

  const input = {
    requesterName:   $('#pq-name').value,
    uploadId:        printState.upload.upload_id,
    // No location: a print job is collected from wherever Haitham prints,
    // so the form does not ask and the RPC fills it in.
    buildingId:      null,
    customLocation:  null,
    title:           $('#pq-title').value,
    paperSize:       $('#pq-paper').value,
    colorMode:       $('#pq-colour input:checked')?.value ?? 'bw',
    colorPermission: $('#pq-permission input:checked')?.value === 'yes',
    printSides:      $('#pq-sides input:checked')?.value ?? 'single',
    copies:          Number($('#pq-copies').value),
    gradeId:         $('#pq-grade').value || null,
    note:            $('#pq-note').value,
    priority:        $('#pq-priority input:checked')?.value ?? 'normal'
  };

  printState.busy = true;
  try {
    await withBusy($('#pq-submit'), t('action.sending'), async () => {
      const result = await createPrintRequest(input);
      rememberRequest(result);
      prefs.set('lastName', input.requesterName.trim());
      showPrintSuccess(result);
      refreshBoard();
      refreshMine();
    });
  } catch (err) {
    showPrintError(err.message);
  } finally {
    printState.busy = false;
  }
}

function showPrintSuccess(result) {
  $('#print-form').hidden = true;
  $('#request-form').hidden = true;
  $('.reqtabs').hidden = true;
  $('#rq-success').hidden = false;
  $('#rq-number').textContent = result.request_number;
  $('#rq-eta').textContent = result.people_ahead > 0
    ? t('form.peopleAhead', { n: result.people_ahead })
    : t('form.youAreNext');
  resetPrintForm();
}

function resetPrintForm() {
  const name = $('#pq-name').value;
  $('#print-form').reset();
  $('#pq-name').value = name;
  printState.file = null;
  printState.upload = null;
  $('#pq-file-chip').hidden = true;
  $('#pq-progress').hidden = true;
  $('#pq-file-btn-text').textContent = t('print.choose');
  $('#pq-note-count').textContent = '0';
  paintSections();
  paintColourFields();
  paintPrintQuip();
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
    renderEmpty(body, icon('clipboard'), t('mine.empty'), t('mine.emptyHint'));
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
        <span class="req-sub">${icon('pin')} ${esc(requestLocation(r))} · ${esc(t('mine.sent'))} ${esc(fmtDateTime(r.created_at))}</span>
        ${r.status === 'pending' && r.people_ahead > 0
          ? `<span class="req-sub">${icon('hourglass')} ${esc(t('mine.ahead', { n: r.people_ahead }))}</span>` : ''}
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
      <p class="req-title" style="font-size:18px">${esc(
        request.print?.title || requestCategory(request))}</p>
      <p class="muted">${icon('pin')} ${esc(requestLocation(request))}</p>
      ${request.print ? printOwnerBlock(request) : ''}
      ${request.description ? `<p class="req-desc">${esc(request.description)}</p>` : ''}
      <p class="small faint">${esc(t('mine.sent'))} ${esc(fmtDateTime(request.created_at))}</p>
      ${request.accepted_at ? `<p class="small faint">${esc(REQUEST_STATUS_META.accepted.label)} · ${esc(fmtDateTime(request.accepted_at))}</p>` : ''}
      ${request.started_at ? `<p class="small faint">${esc(REQUEST_STATUS_META.in_progress.label)} · ${esc(fmtDateTime(request.started_at))}</p>` : ''}
      ${request.completed_at ? `<p class="small faint">${esc(REQUEST_STATUS_META.completed.label)} · ${esc(fmtDateTime(request.completed_at))}</p>` : ''}
    </div>`;

  openSheet('#detail-sheet');

  if (request.print) appendDownloadButton(body, request);

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
/**
 * What the person who sent a print request sees about their own document.
 * Their filename and their settings - nothing they did not already know,
 * and nothing another colleague could reach even with this token missing,
 * because the server checks it again.
 */
function printOwnerBlock(request) {
  const job = request.print;
  const where = destinationText(job);
  return `
    <div class="printbox">
      <p class="printbox-file">${icon('files')} <span class="mono">${esc(job.original_filename)}</span></p>
      <p class="printbox-line">${esc(settingsLine(job))}</p>
      ${where ? `<p class="printbox-line">${esc(t('print.destination'))}: ${esc(where)}</p>` : ''}
      ${job.note ? `<p class="printbox-line">${esc(job.note)}</p>` : ''}
    </div>`;
}

/**
 * Fetching the document is a round trip, not a link: the bucket is
 * private, so the Edge Function has to authorise first and mint a URL
 * that dies in a minute. Opening in a new tab keeps the board loaded.
 */
function appendDownloadButton(body, request) {
  const btn = el('button', {
    class: 'btn btn-soft btn-block',
    type: 'button',
    html: `${icon('inbox')} <span>${esc(t('print.openDoc'))}</span>`,
    style: 'margin-top:14px'
  });
  btn.addEventListener('click', () => withBusy(btn, t('print.opening'), async () => {
    try {
      const { url } = await openPrintDocument(request.id ?? request.request_id, request.token);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toastError(err.message);
    }
  }));
  body.append(btn);
}

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

/* How long a reveal lasts. Long enough that Haitham taps once at the
   start of a shift and the link is there all day; short enough that a
   colleague who borrows the device tomorrow finds the door shut again.
   Without an expiry the first reveal was permanent, which quietly
   undid the concealment it was supposed to provide. */
const ADMIN_REVEAL_MS = 12 * 60 * 60 * 1000;

/* Declared as a function, not a const: boot() calls wireAdminGesture during
   module evaluation, and a const declared further down the file is still in
   its temporal dead zone at that point. */
function adminUnlocked() {
  const until = Number(prefs.get('adminUnlockedUntil', 0));
  if (!until) return false;
  if (Date.now() > until) {
    prefs.remove('adminUnlockedUntil');
    return false;
  }
  return true;
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

  /* The counter starts at zero on every page load, is cleared the moment
     the door opens, and is cleared again after a pause: ten taps have to
     be ten deliberate taps in one go, so no amount of idle fidgeting
     with the clock will ever get there by accident. */
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
      clearTimeout(reset);
      prefs.set('adminUnlockedUntil', Date.now() + ADMIN_REVEAL_MS);
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
