/**
 * print-download — Supabase Edge Function
 *
 * WHY THIS EXISTS
 * ---------------
 * The bucket is private, so there is no URL a browser can hold. Every
 * download is minted here, one at a time, after this function has decided
 * the caller is allowed it.
 *
 * WHO IS ALLOWED
 * --------------
 *   An administrator   - proven by their Supabase session. The JWT is
 *                        verified against the project, then the profile is
 *                        read with the service role to confirm the role is
 *                        still 'admin' and the account still active. A
 *                        token alone is not taken as proof of anything.
 *
 *   The person who     - proven by the request's public_token, the same
 *   sent it              unguessable value that already lets them view and
 *                        edit their own request. It is matched against the
 *                        request row; it cannot be pointed at a different
 *                        request, because the row IS the lookup.
 *
 * Nobody else. There is no third branch, and no request body that reaches
 * one. In particular a storage path is never accepted from the caller:
 * the path is read from the database after authorisation, so a caller who
 * guesses a path gains nothing.
 *
 * WHAT IT RETURNS
 * ---------------
 * A signed URL that expires in 60 seconds. Long enough to click, too short
 * to pass around, and it names the original file so the browser saves it
 * under the name the colleague uploaded rather than a uuid.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const BUCKET = 'print-jobs';
const URL_TTL_SECONDS = 60;

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });

/** The caller's session, if it is a real one and still an administrator. */
async function callerIsAdmin(req: Request): Promise<boolean> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  // The anon key is sent as a Bearer token by supabase-js on every call,
  // so its presence proves nothing; getUser() is what separates a session
  // from a public key.
  if (!token) return false;

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return false;

  const { data: profile } = await admin
    .from('profiles')
    .select('role, active')
    .eq('id', data.user.id)
    .single();

  return profile?.role === 'admin' && profile?.active === true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const requestId = typeof body.request_id === 'string' ? body.request_id : '';
    const publicToken = typeof body.public_token === 'string' ? body.public_token : '';

    if (!UUID.test(requestId)) return json({ error: 'Not found.' }, 404);

    // ---- Authorise, before anything is read about the file -----------
    let allowed = await callerIsAdmin(req);

    if (!allowed && UUID.test(publicToken)) {
      const { data: owner } = await admin
        .from('service_requests')
        .select('id')
        .eq('id', requestId)
        .eq('public_token', publicToken)
        .maybeSingle();
      allowed = Boolean(owner);
    }

    // One message for "no such request" and for "not yours", so the
    // endpoint cannot be used to discover which request ids exist.
    if (!allowed) return json({ error: 'Not found.' }, 404);

    // ---- Only now look up where the file lives -----------------------
    const { data: job } = await admin
      .from('print_jobs')
      .select('storage_path, original_filename')
      .eq('request_id', requestId)
      .maybeSingle();

    if (!job) return json({ error: 'Not found.' }, 404);

    // Content-Disposition is a header, and a header is latin-1. Supabase
    // percent-encodes this value, but a name that is entirely non-latin
    // can still arrive mangled, so an ASCII fallback is prepared. The
    // browser gets a usable filename either way, and the true name is
    // always shown in the interface beside the button.
    const asciiName = job.original_filename.replace(/[^\x20-\x7e]/g, '').trim();
    const ext = /\.([A-Za-z0-9]{1,5})$/.exec(job.original_filename)?.[1] ?? 'bin';
    const downloadAs = asciiName.length > 4 ? asciiName : `document.${ext}`;

    const { data: signed, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(job.storage_path, URL_TTL_SECONDS, { download: downloadAs });

    if (error || !signed?.signedUrl) {
      console.error('[print-download] sign', error?.message);
      return json({ error: 'The document could not be opened.' }, 500);
    }

    return json({
      url: signed.signedUrl,
      filename: job.original_filename,
      expires_in: URL_TTL_SECONDS
    });
  } catch (err) {
    console.error('[print-download]', err);
    return json({ error: 'The document could not be opened.' }, 500);
  }
});
