/**
 * How this app calls its stored procedures.
 *
 * Separate from supabase.js on purpose. That module is the client - the
 * connection and the key. This one is the policy we apply on top of it,
 * and keeping them apart means the policy can be tested against a
 * stubbed client instead of being part of the thing being stubbed.
 */
import { sb } from './supabase.js';

/**
 * Calls an RPC, and if the database has not caught up with the deployed
 * frontend, calls it again without the arguments it does not know yet.
 *
 * WHY
 * ---
 * A deploy and a SQL migration are two separate acts by one tired
 * person, and they will not always happen in the right order. When the
 * site ships first, PostgREST answers
 *
 *   Could not find the function public.create_print_request(..., p_collectors, ...)
 *
 * and a colleague who only wanted thirty copies of an exam gets an
 * error naming a function. The feature those arguments carry is not
 * available until the migration runs - but everything else about the
 * request still works, so it should still go through.
 *
 * This is the same bargain js/requests.js already strikes with
 * REQUEST_COLUMNS_BASE: degrade to what the server understands, say so
 * in the console, and keep the app usable.
 *
 * @param {string}   name       the RPC
 * @param {object}   args       everything, newest arguments included
 * @param {string[]} optional   argument names to drop on a retry
 */
export async function rpcWithFallback(name, args, optional = []) {
  const first = await sb.rpc(name, args);
  if (!first.error) return first.data;

  // PGRST202 is "no function with these arguments". The text match
  // covers older PostgREST builds that did not set a code.
  const unknownSignature = first.error?.code === 'PGRST202'
    || /could not find the function/i.test(first.error?.message ?? '');

  const dropped = optional.filter(key => key in args);
  if (!unknownSignature || !dropped.length) return Promise.reject(first.error);

  const reduced = { ...args };
  for (const key of dropped) delete reduced[key];

  console.warn(`[rpc] ${name}: retrying without ${dropped.join(', ')} - `
             + 'a SQL migration is pending in Supabase.');

  const second = await sb.rpc(name, reduced);
  // The original error is the more useful one to report: it names what
  // is actually missing, where the retry just fails again generically.
  if (second.error) return Promise.reject(first.error);
  return second.data;
}
