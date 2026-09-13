/**
 * login.html controller: sign in, sign up and password recovery.
 */
import { configured, sb } from './supabase.js';
import { $, esc } from './utils.js';
import { initTheme, initThemeToggle, initOffline, renderSetupNeeded, toastOk, toastError, withBusy } from './ui.js';
import {
  signIn, signUp, sendPasswordReset, updatePassword, getSession, getProfile,
  isAdmin, isJoined, joinWithCode, accessOptions
} from './auth.js';

initTheme();
initThemeToggle();
initOffline();

const params = new URLSearchParams(location.search);
const nextUrl = sanitiseNext(params.get('next'));

/** Only ever redirect inside this app — never to an address from the URL bar. */
function sanitiseNext(value) {
  if (!value) return 'index.html';
  try {
    const url = new URL(value, location.href);
    if (url.origin !== location.origin) return 'index.html';
    return url.pathname + url.search + url.hash;
  } catch {
    return 'index.html';
  }
}

if (!configured) {
  $('#auth-card').hidden = true;
  const host = $('#setup-needed');
  host.hidden = false;
  renderSetupNeeded(host);
} else {
  boot();
}

async function boot() {
  showNotices();

  const options = await accessOptions();
  applyOptions(options);

  // Arriving from a "reset password" e-mail puts a recovery session in place.
  if (location.hash.includes('type=recovery')) {
    showPanel('recover');
  } else {
    const session = await getSession();
    if (session) {
      const profile = await getProfile().catch(() => null);
      if (isJoined(profile)) {
        await goHome();
      } else {
        // A session exists but the code was never accepted. Let them
        // finish joining rather than stranding them.
        showPanel('join');
        if (profile?.full_name && profile.full_name !== 'Not named yet') {
          $('#join-name').value = profile.full_name;
        }
      }
    }
  }

  wireTabs();
  wireJoin();
  wireSignIn();
  wireSignUp();
  wireRecover();
}

/**
 * The sign-in page adapts to how the site is configured: no code set up
 * yet (first run) means e-mail is the only way in, which is exactly what
 * the administrator needs in order to bootstrap.
 */
function applyOptions(options) {
  $('#to-signup').hidden = options.allow_email_signup === false;

  if (!options.code_ready) {
    $('#tab-join').hidden = true;
    $('#tab-signin').className = 'btn btn-soft grow';
    showPanel(options.allow_email_signup === false ? 'signin' : 'signup');
    const notice = $('#auth-notice');
    if (!notice.textContent) {
      notice.textContent = 'No access code has been set up yet. Create the administrator account first, then set the code in Admin → Settings.';
      notice.hidden = false;
    }
  }
}

function showNotices() {
  const notice = $('#auth-notice');
  const messages = {
    inactive: 'Your account is not active. Please ask the administrator to re-enable it.',
    signedout: 'You have been signed out.',
    expired: 'Your session expired. Please sign in again.'
  };
  const key = params.get('reason');
  if (key && messages[key]) {
    notice.textContent = messages[key];
    notice.hidden = false;
  } else if (params.get('next')) {
    notice.textContent = 'Please sign in to continue.';
    notice.hidden = false;
  }
}

function showPanel(which) {
  const panels = {
    join: '#panel-join',
    signin: '#panel-signin',
    signup: '#panel-signup',
    recover: '#panel-recover'
  };
  Object.entries(panels).forEach(([key, sel]) => { $(sel).hidden = key !== which; });

  const joinTab = $('#tab-join');
  const signinTab = $('#tab-signin');
  const showTabs = which !== 'recover' && which !== 'signup';
  joinTab.parentElement.hidden = !showTabs;

  joinTab.setAttribute('aria-selected', String(which === 'join'));
  signinTab.setAttribute('aria-selected', String(which === 'signin'));
  joinTab.className = which === 'join' ? 'btn btn-soft grow' : 'btn btn-ghost grow';
  signinTab.className = which === 'signin' ? 'btn btn-soft grow' : 'btn btn-ghost grow';

  $(panels[which])?.querySelector('[data-autofocus], input')?.focus({ preventScroll: true });
}

function wireTabs() {
  $('#tab-join').addEventListener('click', () => showPanel('join'));
  $('#tab-signin').addEventListener('click', () => showPanel('signin'));
  $('#to-signup').addEventListener('click', () => showPanel('signup'));
  $('#back-to-join').addEventListener('click', () => showPanel('join'));
  if (params.get('mode') === 'signup') showPanel('signup');
  if (params.get('mode') === 'signin') showPanel('signin');
}

function wireJoin() {
  $('#panel-join').addEventListener('submit', async event => {
    event.preventDefault();
    fieldError('#join-error', '');

    const name = $('#join-name').value.trim();
    const code = $('#join-code').value.trim();
    if (!name || !code) {
      fieldError('#join-error', 'Enter your name and the access code.');
      return;
    }

    await withBusy($('#join-submit'), 'Checking…', async () => {
      try {
        await joinWithCode(name, code);
        await goHome();
      } catch (err) {
        fieldError('#join-error', err.message);
      }
    });
  });
}

function fieldError(selector, message) {
  const node = $(selector);
  node.textContent = message || '';
  node.hidden = !message;
}

/** Administrators land on their own console; everybody else on the board. */
async function goHome() {
  let profile = null;
  try { profile = await getProfile({ force: true }); } catch { /* ignore */ }
  if (nextUrl !== 'index.html') {
    location.replace(nextUrl);
  } else {
    location.replace(isAdmin(profile) ? 'admin.html' : 'index.html');
  }
}

function wireSignIn() {
  const form = $('#panel-signin');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    fieldError('#signin-error', '');

    const email = $('#signin-email').value.trim();
    const password = $('#signin-password').value;
    if (!email || !password) {
      fieldError('#signin-error', 'Enter your e-mail address and password.');
      return;
    }

    await withBusy($('#signin-submit'), 'Signing in…', async () => {
      try {
        await signIn(email, password);
        await goHome();
      } catch (err) {
        fieldError('#signin-error', err.message);
      }
    });
  });

  $('#forgot-btn').addEventListener('click', async event => {
    const email = $('#signin-email').value.trim();
    if (!email) {
      fieldError('#signin-error', 'Type your e-mail address first, then tap "Forgot your password?".');
      $('#signin-email').focus();
      return;
    }
    await withBusy(event.currentTarget, 'Sending…', async () => {
      try {
        await sendPasswordReset(email);
        toastOk('Check your inbox for a password reset link.');
      } catch (err) {
        toastError(err.message);
      }
    });
  });
}

function wireSignUp() {
  const form = $('#panel-signup');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    fieldError('#signup-error', '');

    const name = $('#signup-name').value.trim();
    const email = $('#signup-email').value.trim();
    const password = $('#signup-password').value;

    await withBusy($('#signup-submit'), 'Creating…', async () => {
      try {
        const { needsConfirmation } = await signUp(email, password, name);
        if (needsConfirmation) {
          $('#auth-notice').innerHTML =
            `Account created for <strong>${esc(email)}</strong>. ` +
            'Open the confirmation e-mail we just sent, then come back and sign in.';
          $('#auth-notice').hidden = false;
          showPanel('signin');
          $('#signin-email').value = email;
        } else {
          await goHome();
        }
      } catch (err) {
        fieldError('#signup-error', err.message);
      }
    });
  });
}

function wireRecover() {
  $('#panel-recover').addEventListener('submit', async event => {
    event.preventDefault();
    fieldError('#recover-error', '');
    const password = $('#recover-password').value;

    await withBusy($('#recover-submit'), 'Saving…', async () => {
      try {
        await updatePassword(password);
        toastOk('Password updated.');
        history.replaceState(null, '', location.pathname);
        await goHome();
      } catch (err) {
        fieldError('#recover-error', err.message);
      }
    });
  });
}

// Keep the tab in step if the session changes in another tab.
sb?.auth.onAuthStateChange(async (event) => {
  if (event !== 'SIGNED_IN' || location.hash.includes('type=recovery')) return;
  // An anonymous session created for a join attempt is not "signed in"
  // until the code has actually been accepted.
  const profile = await getProfile().catch(() => null);
  if (isJoined(profile)) goHome();
});
