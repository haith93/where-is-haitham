/**
 * Presentation helpers shared by every page: theme, toasts, sheets,
 * button busy-states, the live clock and the offline banner.
 *
 * Nothing here touches the database.
 */
import { $, $$, el, esc, fmtClock, prefs } from './utils.js';

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

export function initTheme() {
  const saved = prefs.get('theme');            // 'light' | 'dark' | null (= follow system)
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.dataset.theme = saved;
  }
  syncThemeColor();
}

export function toggleTheme() {
  const current = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  prefs.set('theme', next);
  syncThemeColor();
  return next;
}

/** Keeps the phone's status bar colour in step with the app. */
function syncThemeColor() {
  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = el('meta', { name: 'theme-color' });
    document.head.append(meta);
  }
  meta.setAttribute('content', dark ? '#0b1020' : '#f4f6fa');
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function toastHost() {
  let host = $('.toasts');
  if (!host) {
    host = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

/**
 * @param {string} message
 * @param {'ok'|'error'|'info'} type
 */
export function toast(message, type = 'info', timeout = type === 'error' ? 7000 : 3500) {
  const icon = type === 'ok' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  const node = el('div', { class: `toast toast-${type}` }, [
    el('span', { text: icon, 'aria-hidden': 'true' }),
    el('span', { class: 'grow', text: message }),
    el('button', { type: 'button', 'aria-label': 'Dismiss', text: '×', onclick: () => node.remove() })
  ]);
  toastHost().append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

export const toastOk    = m => toast(m, 'ok');
export const toastError = m => toast(m, 'error');

/* ------------------------------------------------------------------ */
/* Button busy state (also prevents double submission)                 */
/* ------------------------------------------------------------------ */

export function setBusy(button, busy, busyLabel = 'Working…') {
  if (!button) return;
  if (busy) {
    if (button.dataset.idleHtml == null) button.dataset.idleHtml = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(busyLabel)}</span>`;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.idleHtml != null) {
      button.innerHTML = button.dataset.idleHtml;
      delete button.dataset.idleHtml;
    }
  }
}

/**
 * Runs `fn` with the button locked. Any thrown error is surfaced as a
 * toast — an action never fails silently, and never double-fires.
 */
export async function withBusy(button, busyLabel, fn) {
  if (button?.disabled) return undefined;
  setBusy(button, true, busyLabel);
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toastError(err?.message || 'Something went wrong. Please try again.');
    return undefined;
  } finally {
    setBusy(button, false);
  }
}

/* ------------------------------------------------------------------ */
/* Sheets (bottom sheet on phones, centred dialog on desktop)          */
/* ------------------------------------------------------------------ */

export function openSheet(dialog) {
  const node = typeof dialog === 'string' ? $(dialog) : dialog;
  if (!node) return;
  if (!node.open) node.showModal();
  const focusTarget = node.querySelector('[data-autofocus]') || node.querySelector('button, input, select, textarea');
  focusTarget?.focus({ preventScroll: true });
}

export function closeSheet(dialog) {
  const node = typeof dialog === 'string' ? $(dialog) : dialog;
  if (node?.open) node.close();
}

/** Wires every [data-close-sheet] button plus backdrop clicks. */
export function initSheets(root = document) {
  $$('dialog.sheet', root).forEach(dlg => {
    if (dlg.dataset.wired) return;
    dlg.dataset.wired = '1';
    dlg.addEventListener('click', event => {
      // Clicking the dimmed area (the dialog element itself) closes it.
      if (event.target === dlg) dlg.close();
    });
    $$('[data-close-sheet]', dlg).forEach(btn => btn.addEventListener('click', () => dlg.close()));
  });
}

/** Promise-based confirmation, so destructive taps are always deliberate. */
export function confirmAction(message, { title = 'Please confirm', confirmText = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
    const dlg = el('dialog', { class: 'sheet' });
    const panel = el('div', { class: 'sheet-panel' }, [
      el('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet-head' }, [el('h2', { text: title })]),
      el('p', { class: 'muted', text: message }),
      el('div', { class: 'btn-grid', style: 'margin-top:18px' }, [
        el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => { resolve(false); dlg.close(); } }),
        el('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          type: 'button',
          text: confirmText,
          'data-autofocus': true,
          onclick: () => { resolve(true); dlg.close(); }
        })
      ])
    ]);
    dlg.append(panel);
    dlg.addEventListener('close', () => { resolve(false); dlg.remove(); });
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
    panel.querySelector('[data-autofocus]')?.focus();
  });
}

/**
 * Like confirmAction, but with several named choices.
 * Resolves to the chosen option's `value`, or null if the sheet was
 * dismissed — so closing it is never mistaken for picking something.
 *
 * @param {string} message
 * @param {{value:string,label:string,style?:string}[]} options
 */
export function chooseAction(message, options, { title = 'Choose' } = {}) {
  return new Promise(resolve => {
    let picked = null;
    const dlg = el('dialog', { class: 'sheet' });
    const panel = el('div', { class: 'sheet-panel' }, [
      el('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet-head' }, [el('h2', { text: title })]),
      el('p', { class: 'muted', text: message }),
      el('div', { class: 'stack-sm', style: 'margin-top:18px' }, [
        ...options.map((option, index) => el('button', {
          class: `btn btn-block ${option.style ?? 'btn-soft'}`,
          type: 'button',
          text: option.label,
          'data-autofocus': index === 0 || undefined,
          onclick: () => { picked = option.value; dlg.close(); }
        })),
        el('button', { class: 'btn btn-ghost btn-block', type: 'button', text: 'Cancel', onclick: () => dlg.close() })
      ])
    ]);
    dlg.append(panel);
    dlg.addEventListener('close', () => { resolve(picked); dlg.remove(); });
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
    panel.querySelector('[data-autofocus]')?.focus();
  });
}

/* ------------------------------------------------------------------ */
/* Live clock — display only. It never writes anything.                */
/* ------------------------------------------------------------------ */

export function startClock(target) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) return () => {};
  const tick = () => { node.textContent = fmtClock(new Date()); };
  tick();
  const id = setInterval(tick, 1000);
  document.addEventListener('visibilitychange', tick);
  return () => clearInterval(id);
}

/* ------------------------------------------------------------------ */
/* Connectivity                                                        */
/* ------------------------------------------------------------------ */

let offlineBar;

export function initOffline(onChange) {
  const render = () => {
    const online = navigator.onLine;
    if (!online && !offlineBar) {
      offlineBar = el('div', {
        class: 'offline-bar',
        role: 'status',
        text: '⚠️ You are offline. Changes cannot be saved until you reconnect.'
      });
      document.body.prepend(offlineBar);
    } else if (online && offlineBar) {
      offlineBar.remove();
      offlineBar = null;
    }
    onChange?.(online);
  };
  addEventListener('online', render);
  addEventListener('offline', render);
  render();
}

export const isOnline = () => navigator.onLine;

/* ------------------------------------------------------------------ */
/* Generic render states                                               */
/* ------------------------------------------------------------------ */

export function renderSkeleton(container, rows = 3) {
  if (!container) return;
  container.innerHTML = Array.from({ length: rows }, (_, i) =>
    `<div class="skeleton" style="height:${i === 0 ? 72 : 54}px;margin-bottom:10px"></div>`
  ).join('');
}

export function renderEmpty(container, icon, title, hint = '') {
  if (!container) return;
  container.innerHTML = `
    <div class="empty">
      <div class="empty-icon" aria-hidden="true">${esc(icon)}</div>
      <p style="font-weight:700">${esc(title)}</p>
      ${hint ? `<p class="small" style="margin-top:4px">${esc(hint)}</p>` : ''}
    </div>`;
}

export function renderError(container, message, onRetry) {
  if (!container) return;
  container.innerHTML = `
    <div class="notice notice-danger">
      <p style="font-weight:700">${esc(message)}</p>
    </div>`;
  if (onRetry) {
    const btn = el('button', { class: 'btn btn-soft', type: 'button', text: 'Try again', style: 'margin-top:10px' });
    btn.addEventListener('click', onRetry);
    container.append(btn);
  }
}

/* ------------------------------------------------------------------ */
/* Shared chrome                                                       */
/* ------------------------------------------------------------------ */

/** Wires the theme toggle button present in every app bar. */
export function initThemeToggle(selector = '[data-theme-toggle]') {
  $$(selector).forEach(btn => {
    const paint = () => {
      const dark = document.documentElement.dataset.theme === 'dark'
        || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
      btn.textContent = dark ? '☀️' : '🌙';
      btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    };
    btn.addEventListener('click', () => { toggleTheme(); paint(); });
    paint();
  });
}

/** Shown when js/env.js is missing, instead of a blank broken page. */
export function renderSetupNeeded(container) {
  if (!container) return;
  container.innerHTML = `
    <div class="card" style="margin-top:24px">
      <h1 style="font-size:20px;margin-bottom:10px">Almost ready</h1>
      <p class="muted" style="margin-bottom:14px">
        This app has not been connected to a Supabase project yet.
      </p>
      <ol class="muted small" style="padding-left:20px;display:flex;flex-direction:column;gap:8px">
        <li>Copy <code class="mono">js/env.example.js</code> to <code class="mono">js/env.js</code>.</li>
        <li>Paste in your Supabase <strong>Project URL</strong> and <strong>anon public key</strong>.</li>
        <li>Run <code class="mono">sql/schema.sql</code>, <code class="mono">sql/functions.sql</code>,
            <code class="mono">sql/rls.sql</code> and <code class="mono">sql/seed.sql</code> in the Supabase SQL editor.</li>
        <li>Reload this page.</li>
      </ol>
      <p class="small faint" style="margin-top:14px">
        Full instructions are in the project README.
      </p>
    </div>`;
}
