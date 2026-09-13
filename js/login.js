/**
 * login.html controller: sign in, sign up and password recovery.
 */
import { configured, sb } from './supabase.js';
import { $, esc } from './utils.js';
import { initTheme, initThemeToggle, initOffline, renderSetupNeeded, toastOk, toastError, withBusy } from './ui.js';
import { signIn, signUp, sendPasswordReset, updatePassword, getSession, getProfile, isAdmin } from './auth.js';

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

  // Arriving from a "reset password" e-mail puts a recovery session in place.
  if (location.hash.includes('type=recovery')) {
    showPanel('recover');
  } else {
    const session = await getSession();
    if (session) await goHome();
  }

  wireTabs();
  wireSignIn();
  wireSignUp();
  wireRecover();
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
  const panels = { signin: '#panel-signin', signup: '#panel-signup', recover: '#panel-recover' };
  Object.entries(panels).forEach(([key, sel]) => { $(sel).hidden = key !== which; });

  const signinTab = $('#tab-signin');
  const signupTab = $('#tab-signup');
  const showTabs = which !== 'recover';
  signinTab.parentElement.hidden = !showTabs;

  signinTab.setAttribute('aria-selected', String(which === 'signin'));
  signupTab.setAttribute('aria-selected', String(which === 'signup'));
  signinTab.className = which === 'signin' ? 'btn btn-soft grow' : 'btn btn-ghost grow';
  signupTab.className = which === 'signup' ? 'btn btn-soft grow' : 'btn btn-ghost grow';
}

function wireTabs() {
  $('#tab-signin').addEventListener('click', () => showPanel('signin'));
  $('#tab-signup').addEventListener('click', () => showPanel('signup'));
  if (params.get('mode') === 'signup') showPanel('signup');
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
sb?.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN' && !location.hash.includes('type=recovery')) goHome();
});
