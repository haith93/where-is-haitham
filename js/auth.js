/**
 * Authentication and the signed-in profile.
 *
 * Roles are read from `public.profiles`, never from anything the browser
 * can set. The UI uses the role only to decide what to *show*; what a
 * user may actually *do* is enforced by RLS and by the SECURITY DEFINER
 * functions in the database.
 */
import { sb, configured, errorMessage } from './supabase.js';

let cachedProfile = null;
let cachedUserId = null;
const listeners = new Set();

/**
 * Nothing in the sign-in path may hang for ever.
 *
 * A refresh-token round trip, or the cross-tab lock supabase-js takes
 * around the session, can occasionally never settle. Without a ceiling
 * that leaves a page waiting on a promise that will never resolve, which
 * shows up as a blank screen and no error at all. A timeout turns that
 * into an ordinary failure the caller can recover from.
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms))
  ]);
}

export class AuthTimeoutError extends Error {}

/* ------------------------------------------------------------------ */
/* Session + profile                                                   */
/* ------------------------------------------------------------------ */

export async function getSession() {
  if (!configured) return null;
  try {
    const { data, error } = await withTimeout(sb.auth.getSession(), 8000, 'Reading your session');
    if (error) {
      console.warn('getSession', error);
      return null;
    }
    return data.session ?? null;
  } catch (err) {
    console.warn('getSession', err);
    // Treated as "no usable session": the caller sends the user to sign
    // in again, which is recoverable. Hanging is not.
    throw new AuthTimeoutError(err.message);
  }
}

/** The signed-in user's profile row, or null when signed out. */
export async function getProfile({ force = false } = {}) {
  const session = await getSession();
  if (!session) {
    cachedProfile = null;
    cachedUserId = null;
    return null;
  }
  if (!force && cachedProfile && cachedUserId === session.user.id) return cachedProfile;

  const { data, error } = await withTimeout(
    sb.from('profiles')
      .select('id, full_name, email, role, active, created_at')
      .eq('id', session.user.id)
      .maybeSingle(),
    10000,
    'Loading your account'
  );

  if (error) {
    console.error('profile load', error);
    throw new Error(errorMessage(error, 'Could not load your account.'));
  }

  cachedProfile = data ?? null;
  cachedUserId = session.user.id;
  return cachedProfile;
}

export const isAdmin = profile => profile?.role === 'admin' && profile?.active === true;

/**
 * A profile only counts as "signed in" once it is active. An anonymous
 * account that has not presented the access code yet is inactive, and is
 * treated everywhere as not signed in.
 */
export const isJoined = profile => profile?.active === true;

/** True when there is a session but the access code has not been accepted. */
export async function needsClaim() {
  const session = await getSession();
  if (!session) return false;
  const profile = await getProfile().catch(() => null);
  return Boolean(profile) && profile.active !== true;
}

/* ------------------------------------------------------------------ */
/* Joining with the shared access code                                 */
/* ------------------------------------------------------------------ */

/** What the sign-in page is allowed to know: is a code set up at all? */
export async function accessOptions() {
  const { data, error } = await sb.rpc('access_options');
  if (error) {
    console.warn('access_options', error);
    return { code_ready: false, allow_email_signup: true };
  }
  return data ?? { code_ready: false, allow_email_signup: true };
}

/**
 * Join with a name and the shared code — no e-mail, no password.
 *
 * Signs in anonymously (or reuses the anonymous session from a previous
 * attempt, so retrying a mistyped code does not litter the user table),
 * then asks the database to verify the code. The code is never checked
 * in the browser: an inactive profile can do nothing at all until the
 * server says the code was right.
 */
export async function joinWithCode(fullName, code) {
  const name = String(fullName || '').trim();
  if (name.length < 2) throw new Error('Please enter your full name.');
  if (!String(code || '').trim()) throw new Error('Please enter the access code.');

  let session = await getSession();
  if (!session) {
    const { error } = await sb.auth.signInAnonymously();
    if (error) {
      throw new Error(
        /disabled|not enabled/i.test(error.message || '')
          ? 'Joining with a code is not switched on for this site yet. Please tell the administrator.'
          : errorMessage(error, 'Could not start a session. Please try again.')
      );
    }
    session = await getSession();
  }

  const { error } = await sb.rpc('claim_staff_access', {
    p_code: String(code).trim(),
    p_name: name
  });
  if (error) throw new Error(errorMessage(error, 'Could not verify that code.'));

  cachedProfile = null;
  return getProfile({ force: true });
}

/* ------------------------------------------------------------------ */
/* Sign in / up / out                                                  */
/* ------------------------------------------------------------------ */

export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({
    email: String(email || '').trim().toLowerCase(),
    password
  });
  if (error) throw new Error(errorMessage(error, 'Could not sign you in.'));

  cachedProfile = null;
  const profile = await getProfile({ force: true });
  if (profile && profile.active === false) {
    await sb.auth.signOut();
    throw new Error('This account has been deactivated. Please contact the administrator.');
  }
  return data.user;
}

export async function signUp(email, password, fullName) {
  const name = String(fullName || '').trim();
  if (name.length < 2) throw new Error('Please enter your full name.');
  if (String(password || '').length < 8) throw new Error('Choose a password of at least 8 characters.');

  const { data, error } = await sb.auth.signUp({
    email: String(email || '').trim().toLowerCase(),
    password,
    options: { data: { full_name: name } }
  });
  if (error) throw new Error(errorMessage(error, 'Could not create the account.'));

  // When e-mail confirmation is switched on there is no session yet.
  return { user: data.user, needsConfirmation: !data.session };
}

export async function signOut() {
  cachedProfile = null;
  cachedUserId = null;
  const { error } = await sb.auth.signOut();
  if (error) throw new Error(errorMessage(error, 'Could not sign out.'));
}

export async function sendPasswordReset(email) {
  const redirectTo = new URL('staff.html', location.href).href;
  const { error } = await sb.auth.resetPasswordForEmail(
    String(email || '').trim().toLowerCase(),
    { redirectTo }
  );
  if (error) throw new Error(errorMessage(error, 'Could not send the reset e-mail.'));
}

export async function updatePassword(newPassword) {
  if (String(newPassword || '').length < 8) throw new Error('Choose a password of at least 8 characters.');
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) throw new Error(errorMessage(error, 'Could not change the password.'));
}

export async function updateMyName(fullName) {
  const name = String(fullName || '').trim();
  if (name.length < 2) throw new Error('Please enter your full name.');
  const profile = await getProfile();
  if (!profile) throw new Error('You are not signed in.');

  const { error } = await sb.from('profiles').update({ full_name: name }).eq('id', profile.id);
  if (error) throw new Error(errorMessage(error, 'Could not save your name.'));

  cachedProfile = { ...profile, full_name: name };
  return cachedProfile;
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

/**
 * Where to come back to after signing in.
 * Staff go to the password page; everybody else to the join page, so an
 * employee is never shown a form they have no credentials for.
 */
export function loginUrl(next = location.pathname + location.search + location.hash, { staff = false } = {}) {
  return `${staff ? 'staff.html' : 'login.html'}?next=${encodeURIComponent(next)}`;
}

/**
 * Blocks a page until a suitable user is present.
 * Returns the profile, or redirects and resolves to null.
 */
export async function requireAuth({ admin = false } = {}) {
  let session;
  try {
    session = await getSession();
  } catch (err) {
    // Deliberately do NOT redirect here. The sign-in page would read the
    // same broken session, bounce straight back, and the two pages would
    // ping-pong for ever. Hand the failure to the caller, which shows an
    // error with a "sign out and start again" way out.
    throw new AuthTimeoutError(
      'Your saved sign-in could not be read. Sign out and sign in again.');
  }

  if (!session) {
    location.replace(loginUrl(undefined, { staff: admin }));  // no loop possible
    return null;
  }

  let profile;
  try {
    profile = await getProfile({ force: true });
  } catch (err) {
    console.warn('requireAuth: profile load failed', err);
    throw new AuthTimeoutError(
      err?.message || 'Your account could not be loaded. Sign out and sign in again.');
  }

  if (!profile) {
    await sb.auth.signOut().catch(() => {});
    location.replace(`${loginUrl(undefined, { staff: admin })}&reason=inactive`);
    return null;
  }

  if (profile.active === false) {
    // An anonymous account that never presented the code is not a
    // problem to report — it just has not finished joining. Keep the
    // session so a retry does not create a second guest account.
    if (!profile.email) {
      location.replace(loginUrl());              // finish joining
      return null;
    }
    await sb.auth.signOut();
    location.replace(`${loginUrl(undefined, { staff: admin })}&reason=inactive`);
    return null;
  }

  if (admin && !isAdmin(profile)) {
    location.replace('index.html?denied=1');
    return null;
  }
  return profile;
}

/* ------------------------------------------------------------------ */
/* Change notifications                                                */
/* ------------------------------------------------------------------ */

export function onAuthChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

if (configured) {
  /**
   * CRITICAL: this callback must stay synchronous and must never await a
   * Supabase call.
   *
   * supabase-js holds its auth lock while it dispatches these events (the
   * dispatch happens inside _recoverAndRefresh during start-up). Calling
   * getSession() from in here asks for the very lock the dispatcher is
   * still holding, so the client deadlocks and every later auth call
   * hangs for ever. That was the cause of the blank admin console.
   *
   * Anything that needs the network is pushed to a later task with
   * setTimeout, by which point the lock has been released.
   */
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      cachedProfile = null;
      cachedUserId = null;
    }
    if (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'TOKEN_REFRESHED') {
      cachedProfile = null;
    }

    setTimeout(async () => {
      let profile = null;
      if (session) {
        try { profile = await getProfile(); } catch { /* surfaced by the caller */ }
      }
      listeners.forEach(fn => { try { fn(event, profile); } catch (e) { console.error(e); } });
    }, 0);
  });
}
