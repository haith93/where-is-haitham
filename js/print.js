/**
 * Print requests: upload, submit, and fetch a document back.
 *
 * THE ONE RULE
 * ------------
 * The document never becomes a URL a browser can hold. The bucket is
 * private, so nothing in this file can read it; every download is a
 * 60-second signed link minted by the `print-download` Edge Function
 * after that function has decided the caller is allowed it.
 *
 * Validation here is for the person filling the form, not for safety.
 * Everything below is checked again server-side, because a browser can be
 * edited and this one spends paper and toner.
 */
import { sb, errorMessage } from './supabase.js';
import { prefs } from './utils.js';
import { t } from './i18n.js';

/** Must match the Edge Function. Shown to the user before they wait. */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Extensions the Edge Function will accept. Used for the file picker. */
export const ACCEPTED_EXTENSIONS = Object.freeze([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'rtf', 'txt',
  'png', 'jpg', 'jpeg', 'webp', 'gif'
]);

export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.map(e => '.' + e).join(',');

export const MAX_COPIES = 500;
export const MAX_NOTE = 100;
export const MAX_TITLE = 120;

/** "2.4 MB" — for the chip under the file picker. */
export function fileSizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const fileExtension = name => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name ?? ''));
  return m ? m[1].toLowerCase() : '';
};

/**
 * What is wrong with this file, or null.
 * Deliberately the same two checks the Edge Function starts with, so the
 * common mistakes are caught before a slow upload rather than after.
 */
export function checkFile(file) {
  if (!file) return t('print.errNoFile');
  if (file.size === 0) return t('print.errEmpty');
  if (file.size > MAX_FILE_BYTES) {
    return t('print.errTooBig', { max: fileSizeText(MAX_FILE_BYTES) });
  }
  if (!ACCEPTED_EXTENSIONS.includes(fileExtension(file.name))) {
    return t('print.errType');
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

function functionsBase() {
  // supabase-js keeps the project URL on the client; the Functions host
  // is the same project with a different subdomain path.
  const url = sb?.supabaseUrl ?? '';
  return url.replace(/\/+$/, '') + '/functions/v1';
}

const deviceId = () => {
  let id = prefs.get('deviceId');
  if (!id) {
    id = (crypto.randomUUID?.() ?? String(Math.random()).slice(2));
    prefs.set('deviceId', id);
  }
  return id;
};

/**
 * Send the document to the private bucket.
 *
 * Returns `{ upload_id, filename, size, mime_type }`. The upload id is a
 * receipt: it is worth nothing on its own, and `create_print_request`
 * spends it exactly once.
 *
 * @param {File} file
 * @param {(percent:number)=>void} [onProgress]
 */
export function uploadDocument(file, onProgress) {
  const problem = checkFile(file);
  if (problem) return Promise.reject(new Error(problem));

  const body = new FormData();
  body.append('file', file);
  body.append('device_id', deviceId());

  // XMLHttpRequest rather than fetch, purely because it reports upload
  // progress. On a school connection a 12 MB PDF is a long silence
  // otherwise, and a silent form looks broken.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${functionsBase()}/print-upload`);

    // The anon key is what lets the request past the Functions gateway.
    // It grants nothing by itself: the function authorises separately.
    const anon = sb?.supabaseKey ?? '';
    if (anon) {
      xhr.setRequestHeader('Authorization', `Bearer ${anon}`);
      xhr.setRequestHeader('apikey', anon);
    }

    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable && typeof onProgress === 'function') {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText || '{}'); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload.upload_id) {
        resolve(payload);
      } else {
        reject(new Error(payload.error || t('print.errUpload')));
      }
    });

    xhr.addEventListener('error',   () => reject(new Error(t('print.errUpload'))));
    xhr.addEventListener('timeout', () => reject(new Error(t('print.errUpload'))));
    xhr.addEventListener('abort',   () => reject(new Error(t('print.errUpload'))));

    xhr.timeout = 120000;
    xhr.send(body);
  });
}

/* ------------------------------------------------------------------ */
/* Submit                                                              */
/* ------------------------------------------------------------------ */

const trimOrNull = v => {
  const s = String(v ?? '').trim();
  return s ? s : null;
};

/**
 * Create the print request from an upload receipt.
 * Mirrors createPublicRequest: no account, server-side validation, and a
 * token back so this device can follow its own request.
 */
export async function createPrintRequest(input) {
  const name = String(input.requesterName ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new Error(t('print.errName'));
  if (name.length > 120) throw new Error(t('print.errNameLong'));
  if (!input.uploadId) throw new Error(t('print.errNoFile'));

  const customLocation = trimOrNull(input.customLocation);
  if (!input.buildingId && !customLocation) throw new Error(t('print.errWhere'));

  const copies = Number(input.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
    throw new Error(t('print.errCopies', { max: MAX_COPIES }));
  }

  const colorMode = input.colorMode === 'color' ? 'color' : 'bw';
  // Refused here as well as in SQL, so the person is told why rather than
  // watching a submit fail.
  if (colorMode === 'color' && input.colorPermission !== true) {
    throw new Error(t('print.errPermission'));
  }

  const note = trimOrNull(input.note);
  if (note && note.length > MAX_NOTE) throw new Error(t('print.errNote', { max: MAX_NOTE }));

  const title = trimOrNull(input.title);
  if (title && title.length > MAX_TITLE) throw new Error(t('print.errTitle'));

  const { data, error } = await sb.rpc('create_print_request', {
    p_requester_name:   name,
    p_upload_id:        input.uploadId,
    p_building_id:      customLocation ? null : (input.buildingId || null),
    p_custom_location:  customLocation,
    p_title:            title,
    p_paper_size:       input.paperSize || 'A4',
    p_color_mode:       colorMode,
    p_color_permission: colorMode === 'color' ? true : null,
    p_print_sides:      input.printSides === 'double' ? 'double' : 'single',
    p_copies:           copies,
    p_grade_id:         input.gradeId || null,
    p_note:             note,
    p_priority:         input.priority || 'normal',
    p_device_id:        deviceId()
  });

  if (error) throw new Error(errorMessage(error, t('print.errSubmit')));
  return data;
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/** Paper sizes, from the database so a new one needs no release. */
export async function getPaperSizes() {
  const { data, error } = await sb
    .from('paper_sizes')
    .select('code, label, label_ar')
    .eq('active', true)
    .order('display_order', { ascending: true });

  if (error) {
    console.warn('[print] paper sizes', error.message);
    return [{ code: 'A4', label: 'A4', label_ar: 'A4' }];
  }
  return data ?? [];
}

/** Everything about a print job. Administrators only; the RPC enforces it. */
export async function getPrintJob(requestId) {
  const { data, error } = await sb.rpc('admin_print_job', { p_request_id: requestId });
  if (error) throw new Error(errorMessage(error, t('print.errLoad')));
  return data ?? null;
}

/**
 * Open the document.
 *
 * Nothing here decides anything: it hands the Edge Function a request id
 * and whatever credential this browser has — an admin session, or the
 * request's own token — and the function decides. A link comes back only
 * if it should, and it dies after a minute.
 */
export async function openPrintDocument(requestId, publicToken = null) {
  const { data: session } = await sb.auth.getSession();
  const bearer = session?.session?.access_token || sb?.supabaseKey || '';

  const response = await fetch(`${functionsBase()}/print-download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      apikey: sb?.supabaseKey ?? ''
    },
    body: JSON.stringify({ request_id: requestId, public_token: publicToken })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.url) {
    throw new Error(payload.error || t('print.errLoad'));
  }
  return payload;
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

/** "A4 · Colour · Double-sided · 30 copies" */
export function settingsLine(job) {
  if (!job) return '';
  return [
    job.paper_size,
    t(job.color_mode === 'color' ? 'print.colour' : 'print.bw'),
    t(job.print_sides === 'double' ? 'print.double' : 'print.single'),
    t('print.copiesN', { n: job.copies })
  ].join(' · ');
}

/**
 * What a colleague who did not send the request is allowed to read.
 * A sentence, and never a filename.
 */
export function publicPrintLine(requesterName, title) {
  const who = String(requesterName ?? '').trim();
  const what = String(title ?? '').trim();
  return what
    ? t('print.publicTitled', { name: who, title: what })
    : t('print.publicPlain', { name: who });
}
