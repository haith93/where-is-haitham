/**
 * login.html controller — the employee join page.
 *
 * One job: name + shared access code. No passwords, no e-mail, and no
 * sign-in form for staff, which lives on staff.html instead.
 */
import { configured, sb } from './supabase.js';
import { $ } from './utils.js';
import {
  initTheme, initThemeToggle, initOffline, renderSetupNeeded,
  toastError, withBusy, registerServiceWorker
} from './ui.js';
import {
  getSession, getProfile, isAdmin, isJoined, joinWithCode, accessOptions
} from './auth.js';

initTheme();
initThemeToggle();
initOffline();
registerServiceWorker();

const params = new URLSearchParams(location.search);
const nextUrl = sanitiseNext(params.get('next'));

/** Only ever redirect inside this app — never to an address from the URL bar. */
function sanitiseNext(value) {
  if (!value) return '';
  try {
    const url = new URL(value, location.href);
    if (url.origin !== location.origin) return '';
    return url.pathname + url.search + url.hash;
  } catch {
    return '';
  }
}

if (!configured) {
  $('#auth-card').hidden = true;
  const host = $('#setup-needed');
  host.hidden = false;
  renderSetupNeeded(host);
} else {
  boot().catch(err => {
    console.error(err);
    toastError(err?.message || 'Could not load the join page. Please refresh.');
  });
}

async function boot() {
  wireJoin();

  if (params.get('reason') === 'inactive') {
    notice('Your account is not active. Please ask the administrator.');
  }

  // Already joined on this device? Go straight in.
  const session = await getSession().catch(() => null);
  if (session) {
    const profile = await getProfile().catch(() => null);
    if (isJoined(profile)) {
      await goHome();
      return;
    }
    // A half-finished join: keep the name they gave, let them retry the code.
    if (profile?.full_name && profile.full_name !== 'Not named yet') {
      $('#join-name').value = profile.full_name;
    }
  }

  // If no code exists yet, say so plainly instead of failing on submit.
  try {
    const options = await accessOptions();
    if (!options.code_ready) {
      notice('Joining is not switched on yet. Please ask your administrator for the access code.');
      $('#join-submit').disabled = true;
    }
  } catch (err) {
    console.warn('accessOptions', err);
  }
}

function notice(text) {
  const node = $('#auth-notice');
  node.textContent = text;
  node.hidden = false;
}

function fieldError(message) {
  const node = $('#join-error');
  node.textContent = message || '';
  node.hidden = !message;
}

async function goHome() {
  let profile = null;
  try { profile = await getProfile({ force: true }); } catch { /* ignore */ }
  if (nextUrl) {
    location.replace(nextUrl);
  } else {
    location.replace(isAdmin(profile) ? 'admin.html' : 'index.html');
  }
}

function wireJoin() {
  $('#panel-join')?.addEventListener('submit', async event => {
    event.preventDefault();
    fieldError('');

    const name = $('#join-name').value.trim();
    const code = $('#join-code').value.trim();
    if (!name || !code) {
      fieldError('Enter your name and the access code.');
      return;
    }

    await withBusy($('#join-submit'), 'Checking...', async () => {
      try {
        await joinWithCode(name, code);
        await goHome();
      } catch (err) {
        fieldError(err.message);
      }
    });
  });
}

// Synchronous by design: awaiting a Supabase call inside this callback
// deadlocks the client's auth lock. Defer the work instead.
sb?.auth.onAuthStateChange((event) => {
  if (event !== 'SIGNED_IN') return;
  setTimeout(async () => {
    const profile = await getProfile().catch(() => null);
    if (isJoined(profile)) goHome();
  }, 0);
});
