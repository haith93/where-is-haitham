/**
 * print-upload — Supabase Edge Function
 *
 * WHY THIS EXISTS
 * ---------------
 * The document a colleague wants printed must never be readable by other
 * colleagues. That means a private bucket, and a private bucket cannot be
 * written to by an anonymous browser: writing needs the service-role key,
 * which can never leave the server. GitHub Pages has no server, so the
 * upload lands here.
 *
 * It also means validation happens here rather than in the page. A browser
 * can be edited; this cannot.
 *
 * WHAT IT DOES
 * ------------
 *   1. Accepts one multipart form POST: `file`, optional `device_id`.
 *   2. Rejects anything too large, of the wrong extension, or whose first
 *      bytes do not match what its extension claims.
 *   3. Writes it to a private bucket under an unguessable path.
 *   4. Records a receipt in `print_uploads` and returns its id.
 *
 * The browser never learns the bucket path. It gets an upload id, which is
 * useless on its own: `create_print_request` consumes it exactly once, and
 * reading the file back goes through `print-download`, which re-checks who
 * is asking.
 *
 * ONE-TIME SETUP
 *   supabase storage create-bucket print-jobs     (PRIVATE — not public)
 *
 * SECRETS
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const BUCKET = 'print-jobs';
const MAX_BYTES = 15 * 1024 * 1024;   // 15 MB: a scanned worksheet, not a video
const MAX_PER_DEVICE_PER_HOUR = 20;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

/**
 * Extension -> what the first bytes must look like.
 *
 * An extension is a claim by the uploader, not a fact. Office formats and
 * images have stable signatures, so they are checked; the legacy .doc/.xls
 * container (OLE2) is checked too. Where a format has no usable signature
 * the list is empty and the extension alone decides, which is the honest
 * limit of what can be verified without parsing the file.
 */
const SIGNATURES: Record<string, { mime: string; magic: number[][] }> = {
  pdf:  { mime: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },                 // %PDF
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',     magic: [[0x50, 0x4b, 0x03, 0x04]] },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  doc:  { mime: 'application/msword',       magic: [[0xd0, 0xcf, 0x11, 0xe0]] },        // OLE2
  xls:  { mime: 'application/vnd.ms-excel', magic: [[0xd0, 0xcf, 0x11, 0xe0]] },
  ppt:  { mime: 'application/vnd.ms-powerpoint', magic: [[0xd0, 0xcf, 0x11, 0xe0]] },
  png:  { mime: 'image/png',  magic: [[0x89, 0x50, 0x4e, 0x47]] },
  jpg:  { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  webp: { mime: 'image/webp', magic: [[0x52, 0x49, 0x46, 0x46]] },                      // RIFF
  gif:  { mime: 'image/gif',  magic: [[0x47, 0x49, 0x46, 0x38]] },
  txt:  { mime: 'text/plain', magic: [] },
  rtf:  { mime: 'application/rtf', magic: [[0x7b, 0x5c, 0x72, 0x74, 0x66]] },           // {\rtf
  odt:  { mime: 'application/vnd.oasis.opendocument.text',        magic: [[0x50, 0x4b, 0x03, 0x04]] },
  ods:  { mime: 'application/vnd.oasis.opendocument.spreadsheet', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  odp:  { mime: 'application/vnd.oasis.opendocument.presentation', magic: [[0x50, 0x4b, 0x03, 0x04]] }
};

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

/**
 * The name is used for display, for the report and for the download
 * header - never as a storage key. Strip path separators and control
 * characters, keep everything else: Arabic, accents and spaces are all
 * ordinary parts of a filename here.
 */
function safeName(raw: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? 'document';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["\\]/g, '')
    .trim();
  return (cleaned || 'document').slice(0, 150);
}

function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function matchesMagic(bytes: Uint8Array, magic: number[][]): boolean {
  if (magic.length === 0) return true;          // nothing reliable to check
  return magic.some(sig => sig.every((b, i) => bytes[i] === b));
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  try {
    const form = await req.formData();
    const file = form.get('file');
    const deviceId = String(form.get('device_id') ?? '').slice(0, 100) || null;

    if (!(file instanceof File)) return json({ error: 'No file was sent.' }, 400);
    if (file.size === 0) return json({ error: 'That file is empty.' }, 400);
    if (file.size > MAX_BYTES) {
      return json({ error: `That file is larger than ${MAX_BYTES / 1024 / 1024} MB.` }, 413);
    }

    const filename = safeName(file.name);
    const ext = extensionOf(filename);
    const spec = SIGNATURES[ext];
    if (!spec) {
      return json({
        error: `${ext ? '.' + ext : 'That kind of file'} cannot be printed. ` +
               `Send a PDF, Word, Excel, PowerPoint or image file.`
      }, 415);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!matchesMagic(bytes.subarray(0, 8), spec.magic)) {
      // The extension says one thing and the content says another. That is
      // either a mistake or an attempt, and neither should be stored.
      return json({ error: 'That file does not look like a .' + ext + ' file.' }, 415);
    }

    // Rate limit per device. Not a security boundary - a device id is
    // self-reported - but it stops one tab filling the bucket by accident.
    if (deviceId) {
      const since = new Date(Date.now() - 3600_000).toISOString();
      const { count } = await supabase
        .from('print_uploads')
        .select('id', { count: 'exact', head: true })
        .eq('device_id', deviceId)
        .gt('created_at', since);
      if ((count ?? 0) >= MAX_PER_DEVICE_PER_HOUR) {
        return json({ error: 'Too many uploads from this device. Try again later.' }, 429);
      }
    }

    // The key is a uuid and an extension - never the uploaded name.
    //
    // Two reasons. A name like "3_أعداد_الأقسام.xlsx" is perfectly valid
    // and perfectly common here, but object keys are not a safe home for
    // arbitrary user text, and putting it there was returning 500 on every
    // Arabic filename. And a key that carries no name leaks nothing if one
    // ever appears in a log.
    //
    // The real name is kept in print_uploads, which is where it is wanted:
    // the report, the admin card and the download header all read it from
    // the database.
    const id = crypto.randomUUID();
    const path = `${new Date().toISOString().slice(0, 7)}/${id}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, bytes, {
        contentType: spec.mime,
        upsert: false,
        cacheControl: 'no-store'
      });

    if (upErr) {
      console.error('[print-upload] storage', upErr.message);
      return json({ error: 'The document could not be stored. Please try again.' }, 500);
    }

    const { data: row, error: dbErr } = await supabase
      .from('print_uploads')
      .insert({
        device_id: deviceId,
        storage_path: path,
        original_filename: filename,
        mime_type: spec.mime,
        file_size: file.size
      })
      .select('id')
      .single();

    if (dbErr) {
      // Do not leave bytes behind that no row points at.
      await supabase.storage.from(BUCKET).remove([path]);
      console.error('[print-upload] receipt', dbErr.message);
      return json({ error: 'The document could not be stored. Please try again.' }, 500);
    }

    return json({
      upload_id: row.id,
      filename,
      size: file.size,
      mime_type: spec.mime
    });
  } catch (err) {
    console.error('[print-upload]', err);
    return json({ error: 'The upload failed. Please try again.' }, 500);
  }
});
