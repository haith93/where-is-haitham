/**
 * The single Supabase client used by every page.
 *
 * The library is loaded from a CDN as an ES module so that the whole app
 * stays buildless and can be served straight from GitHub Pages.
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { CONFIG, isConfigured } from './config.js';

export const configured = isConfigured();

export const sb = configured
  ? createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'wih.auth'
      },
      realtime: {
        params: { eventsPerSecond: 5 }   // plenty: we only write on real events
      },
      global: {
        headers: { 'x-application-name': 'where-is-haitham' }
      }
    })
  : null;

/**
 * Turns any Supabase/Postgres error into a sentence a human can act on.
 * Never returns an empty string, so the UI can never "fail silently".
 */
export function errorMessage(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) return fallback;
  if (typeof error === 'string') return error;

  const raw = error.message || error.error_description || error.hint || '';

  if (!navigator.onLine) return 'You appear to be offline. Reconnect and try again.';

  const map = [
    [/Failed to fetch|NetworkError|fetch failed/i, 'Could not reach the server. Check your connection and try again.'],
    [/JWT|token is expired|invalid claim/i,        'Your session expired. Please sign in again.'],
    [/Invalid login credentials/i,                 'That e-mail and password do not match an account.'],
    [/Email not confirmed/i,                       'Please confirm your e-mail address first, then sign in.'],
    [/User already registered/i,                   'An account with that e-mail already exists. Try signing in.'],
    [/duplicate key|already exists/i,              'That name is already in use.'],
    [/violates row-level security|permission denied|42501/i,
                                                   'You do not have permission to do that.'],
    [/violates check constraint/i,                 'Some of that information is not valid. Please review and try again.']
  ];
  for (const [pattern, friendly] of map) {
    if (pattern.test(raw)) return friendly;
  }
  return raw || fallback;
}

/** Small wrapper so callers can `const { data, error } = await call(...)` uniformly. */
export async function rpc(name, args = {}) {
  if (!sb) return { data: null, error: new Error('The app is not configured yet.') };
  return sb.rpc(name, args);
}
