/**
 * staff.html controller — e-mail + password sign-in for administrators.
 *
 * Kept separate from the employee join page on purpose: colleagues who
 * only need to send a request should never be shown a password form.
 */
import { configured, sb } from './supabase.js';
import { $, esc } from './utils.js';
import {
  initTheme, initThemeToggle, initOffline, renderSetupNeeded,
  toastOk, toastError, withBusy, registerServiceWorker
} from './ui.js';
import {
  signIn, signUp, sendPasswordReset, updatePassword,
  getSession, getProfile, isAdmin, isJoined, accessOptions
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
    toastError(err?.message || 'Could not load the sign-in page. Please refresh.');
  });
}

async function boot() {
  showNotices();

  // Offer account creation only while it is actually allowed. Before the
  // very first administrator exists this is the only way in.
  try {
    const options = await accessOptions();
    const toSignup = $('#to-signup');
    if (toSignup) toSignup.hidden = options.allow_email_signup === false;
    if (!options.code_ready && options.allow_email_signup !== false) {
      showNotice('No administrator account exists yet. Create one below, then set the employee access code in Admin → Settings.');
      showPanel('signup');
    }
  } catch (err) {
    console.warn('accessOptions', err);
  }

  if (location.hash.includes('type=recovery')) {
    showPanel('recover');
  } else {
    const session = await getSession().catch(() => null);
    if (session) {
      const profile = await getProfile().catch(() => null);
      if (isJoined(profile)) await goHome();
    }
  }

  wire();
}

function showNotice(text) {
  const notice = $('#auth-notice');
  notice.textContent = text;
  notice.hidden = false;
}

function showNotices() {
  const messages = {
    inactive: 'Your account is not active. Ask an administrator to re-enable it.',
    signedout: 'You have been signed out.',
    expired: 'Your session expired. Please sign in again.',
    denied: 'That area is for administrators only.'
  };
  const key = params.get('reason');
  if (key && messages[key]) showNotice(messages[key]);
  else if (params.get('next')) showNotice('Please sign in to continue.');
}

function showPanel(which) {
  const panels = { signin: '#panel-signin', signup: '#panel-signup', recover: '#panel-recover' };
  Object.entries(panels).forEach(([key, sel]) => {
    const node = $(sel);
    if (node) node.hidden = key !== which;
  });
  $(panels[which])?.querySelector('[data-autofocus], input')?.focus({ preventScroll: true });
}

function fieldError(selector, message) {
  const node = $(selector);
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
}

/** Administrators land on their own console; anyone else on the board. */
async function goHome() {
  let profile = null;
  try { profile = await getProfile({ force: true }); } catch { /* ignore */ }
  if (nextUrl) {
    location.replace(nextUrl);
  } else {
    location.replace(isAdmin(profile) ? 'admin.html' : 'index.html');
  }
}

function wire() {
  $('#to-signup')?.addEventListener('click', () => showPanel('signup'));
  $('#back-to-signin')?.addEventListener('click', () => showPanel('signin'));

  $('#panel-signin')?.addEventListener('submit', async event => {
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

  $('#forgot-btn')?.addEventListener('click', async event => {
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

  $('#panel-signup')?.addEventListener('submit', async event => {
    event.preventDefault();
    fieldError('#signup-error', '');

    const name = $('#signup-name').value.trim();
    const email = $('#signup-email').value.trim();
    const password = $('#signup-password').value;

    await withBusy($('#signup-submit'), 'Creating…', async () => {
      try {
        const { needsConfirmation } = await signUp(email, password, name);
        if (needsConfirmation) {
          showNotice(`Account created for ${email}. Open the confirmation e-mail we just sent, then sign in.`);
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

  $('#panel-recover')?.addEventListener('submit', async event => {
    event.preventDefault();
    fieldError('#recover-error', '');

    await withBusy($('#recover-submit'), 'Saving…', async () => {
      try {
        await updatePassword($('#recover-password').value);
        toastOk('Password updated.');
        history.replaceState(null, '', location.pathname);
        await goHome();
      } catch (err) {
        fieldError('#recover-error', err.message);
      }
    });
  });
}

// Synchronous by design: awaiting a Supabase call inside this callback
// deadlocks the client's auth lock. Defer the work instead.
sb?.auth.onAuthStateChange((event) => {
  if (event !== 'SIGNED_IN' || location.hash.includes('type=recovery')) return;
  setTimeout(async () => {
    const profile = await getProfile().catch(() => null);
    if (isJoined(profile)) goHome();
  }, 0);
});
