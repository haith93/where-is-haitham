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
/** Documents in one request. Only a Normal request may use more than one. */
export const MAX_FILES = 10;
export const MAX_NOTE = 100;
export const MAX_PAGES = 2000;
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
/**
 * Create the print request from a list of upload receipts.
 *
 * One request, several documents, each with its own copies, paper, sides
 * and grade. Colour belongs to the request rather than to a document: it
 * is a question about permission, asked once.
 *
 * Everything checked here is checked again in SQL. This version exists so
 * the person filling the form is told what is wrong, not so the rule is
 * enforced - a browser can be edited.
 */
export async function createPrintRequest(input) {
  const name = String(input.requesterName ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new Error(t('print.errName'));
  if (name.length > 120) throw new Error(t('print.errNameLong'));

  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) throw new Error(t('print.errNoFile'));
  if (files.length > MAX_FILES) throw new Error(t('print.errTooManyFiles', { max: MAX_FILES }));

  const priority = input.priority || 'normal';
  // Only a Normal request may carry several documents.
  if (priority !== 'normal' && files.length > 1) throw new Error(t('print.errOneFileOnly'));

  const title = trimOrNull(input.title);
  if (title && title.length > MAX_TITLE) throw new Error(t('print.errTitle'));

  const payload = files.map(file => {
    // A document may never have been a file: handed over on paper, sent
    // on WhatsApp, or simply too large for the site. Then the colleague
    // says what it is instead, and the title names it everywhere else.
    const delivery = DELIVERY_KEYS.includes(file.delivery) ? file.delivery : 'upload';

    if (delivery === 'upload' && !file.uploadId) throw new Error(t('print.errNoFile'));
    if (delivery !== 'upload' && !trimOrNull(file.title) && !title) {
      throw new Error(t('print.errNeedTitle'));
    }

    // Optional: a document handed over on paper may not have been
    // counted yet. Without it the paper cost is simply not reported.
    const pages = file.pages === '' || file.pages == null ? null : Number(file.pages);
    if (pages != null && (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES)) {
      throw new Error(t('print.errPages', { max: MAX_PAGES }));
    }

    const copies = Number(file.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
      throw new Error(t('print.errCopies', { max: MAX_COPIES }));
    }

    // Colour and its permission belong to the document now: a colour
    // poster and two black-and-white worksheets are one errand.
    const colorMode = file.colorMode === 'color' ? 'color' : 'bw';
    if (colorMode === 'color' && file.colorPermission !== true) {
      throw new Error(t('print.errPermission'));
    }

    const note = trimOrNull(file.note);
    if (note && note.length > MAX_NOTE) throw new Error(t('print.errNote', { max: MAX_NOTE }));

    return {
      upload_id:        delivery === 'upload' ? file.uploadId : null,
      delivery,
      title:            trimOrNull(file.title),
      pages,
      copies,
      paper_size:       file.paperSize || 'A4',
      print_sides:      file.printSides === 'double' ? 'double' : 'single',
      grade_id:         file.gradeId || null,
      color_mode:       colorMode,
      color_permission: colorMode === 'color' ? true : null,
      note
    };
  });

  const { data, error } = await sb.rpc('create_print_request', {
    p_requester_name:  name,
    p_files:           payload,
    p_title:           title,
    p_priority:        priority,
    p_building_id:     null,
    p_custom_location: null,
    p_device_id:       deviceId()
  });

  if (error) throw new Error(errorMessage(error, t('print.errSubmit')));
  return data;
}

/* ------------------------------------------------------------------ */
/* Recording a print job that did not come through the site           */
/* ------------------------------------------------------------------ */

/**
 * How a document reached Haitham.
 *
 * 'upload' is the website. The rest are the ways a print job actually
 * arrives while a school is still getting used to a new system: a sheet
 * of paper in the corridor, a WhatsApp message, an e-mail, a file in the
 * shared folder - or anything too large to upload here.
 *
 * A document arrives one way, so this is a choice rather than a set of
 * tick boxes: ticking both "by hand" and "e-mail" would describe two
 * documents, and nothing downstream could act on the pair.
 */
export const DELIVERY_KEYS = Object.freeze(
  ['upload', 'hand', 'whatsapp', 'email', 'shared_folder', 'other']);

export const deliveryLabel = key => t(`delivery.${key}`);

/** True when this document has a file to open. */
export const hasFile = job => (job?.delivery ?? 'upload') === 'upload';

/**
 * Record a print request on somebody's behalf.
 *
 * The administrator's counterpart to createPrintRequest. Same per-document
 * settings; the difference is that a document may have arrived by hand,
 * in which case there is no upload and the title is what names it.
 */
export async function adminCreatePrintRequest(input) {
  const name = String(input.requesterName ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new Error(t('print.errName'));

  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) throw new Error(t('bprint.errNoDocs'));
  if (files.length > MAX_FILES) throw new Error(t('print.errTooManyFiles', { max: MAX_FILES }));

  const priority = input.priority || 'normal';
  const title = trimOrNull(input.title);

  const payload = files.map(file => {
    const delivery = DELIVERY_KEYS.includes(file.delivery) ? file.delivery : 'upload';

    if (delivery === 'upload' && !file.uploadId) throw new Error(t('print.errNoFile'));
    // Something has to name a document nobody can open.
    if (delivery !== 'upload' && !trimOrNull(file.title) && !title) {
      throw new Error(t('print.errNeedTitle'));
    }

    // Optional: a document handed over on paper may not have been
    // counted yet. Without it the paper cost is simply not reported.
    const pages = file.pages === '' || file.pages == null ? null : Number(file.pages);
    if (pages != null && (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES)) {
      throw new Error(t('print.errPages', { max: MAX_PAGES }));
    }

    const copies = Number(file.copies);
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
      throw new Error(t('print.errCopies', { max: MAX_COPIES }));
    }

    const colorMode = file.colorMode === 'color' ? 'color' : 'bw';
    if (colorMode === 'color' && file.colorPermission !== true) {
      throw new Error(t('print.errPermission'));
    }

    const note = trimOrNull(file.note);
    if (note && note.length > MAX_NOTE) throw new Error(t('print.errNote', { max: MAX_NOTE }));

    return {
      upload_id:        delivery === 'upload' ? file.uploadId : null,
      delivery,
      title:            trimOrNull(file.title),
      pages,
      copies,
      paper_size:       file.paperSize || 'A4',
      print_sides:      file.printSides === 'double' ? 'double' : 'single',
      grade_id:         file.gradeId || null,
      color_mode:       colorMode,
      color_permission: colorMode === 'color' ? true : null,
      note
    };
  });

  const { data, error } = await sb.rpc('admin_create_print_request', {
    p_requester_name:   name,
    p_files:            payload,
    p_channel:          input.channel || 'in_person',
    p_title:            title,
    p_priority:         priority,
    p_notes:            trimOrNull(input.notes),
    p_building_id:      null,
    p_custom_location:  null,
    p_start_now:        Boolean(input.startNow),
    p_duration_minutes: input.durationMinutes ?? null
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

/** Every document on a request. Administrators only; the RPC enforces it. */
export async function getPrintJobs(requestId) {
  const { data, error } = await sb.rpc('admin_print_jobs', { p_request_id: requestId });
  if (error) throw new Error(errorMessage(error, t('print.errLoad')));
  return Array.isArray(data) ? data : [];
}

/**
 * Open the document.
 *
 * Nothing here decides anything: it hands the Edge Function a request id
 * and whatever credential this browser has — an admin session, or the
 * request's own token — and the function decides. A link comes back only
 * if it should, and it dies after a minute.
 */
export async function openPrintDocument(requestId, publicToken = null, jobId = null) {
  const { data: session } = await sb.auth.getSession();
  const bearer = session?.session?.access_token || sb?.supabaseKey || '';

  const response = await fetch(`${functionsBase()}/print-download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
      apikey: sb?.supabaseKey ?? ''
    },
    body: JSON.stringify({ request_id: requestId, public_token: publicToken, job_id: jobId })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.url) {
    throw new Error(payload.error || t('print.errLoad'));
  }
  return payload;
}

/**
 * Open the document and save it under the name it was uploaded with.
 *
 * `Content-Disposition` is an HTTP header and headers are latin-1, so a
 * name like "3_أعداد_الأقسام.xlsx" came back as "3__.xlsx" - everything
 * but the digits stripped. Fetching the bytes and handing them to an
 * <a download> avoids the header completely: that attribute is a DOM
 * string and takes any script.
 *
 * If the fetch fails - an expired link, a blocked cross-origin read - the
 * signed URL is opened directly instead. A slightly wrong filename beats
 * no document.
 */
export async function downloadPrintDocument(requestId, publicToken = null, jobId = null) {
  const { url, filename } = await openPrintDocument(requestId, publicToken, jobId);

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('fetch failed');
    const blob = await response.blob();

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename || 'document';
    document.body.append(link);
    link.click();
    link.remove();
    // Revoked on the next turn of the event loop, after the click has
    // been handled; revoking immediately cancels the download in Safari.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    return { filename };
  } catch {
    window.open(url, '_blank', 'noopener');
    return { filename };
  }
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

/** "A4 · Colour · Double-sided · 30 copies" */
/**
 * Sheets of paper a job costs. Mirrors public.print_sheets in SQL - if
 * one of the two changes, change both.
 *
 * Double-sided halves the sheet count per copy, rounding up: a 5-page
 * document is 3 sheets, not 2.5. Unknown page count gives null, because
 * a guessed number on a paper-stock report is worse than a blank.
 */
export function sheetsFor({ pages, printSides, copies } = {}) {
  const n = Number(pages);
  if (!Number.isFinite(n) || n < 1) return null;
  const perCopy = printSides === 'double' ? Math.ceil(n / 2) : n;
  return perCopy * Math.max(1, Number(copies) || 1);
}

/** The same, from a database row. */
export const jobSheets = job => sheetsFor({
  pages: job?.pages, printSides: job?.print_sides, copies: job?.copies
});

/* English needs a singular form; "1 pages" is the kind of detail that
   makes a careful tool look careless. */
const countText = (n, key) => t(n === 1 ? `${key}1` : `${key}N`, { n });
export const pagesText  = n => countText(n, 'print.pages');
export const sheetsText = n => countText(n, 'print.sheets');
export const copiesText = n => countText(n, 'print.copies');

export function settingsLine(job) {
  if (!job) return '';
  const where = hasFile(job) ? [] : [deliveryLabel(job.delivery)];
  return [
    ...where,
    job.paper_size,
    t(job.color_mode === 'color' ? 'print.colour' : 'print.bw'),
    t(job.print_sides === 'double' ? 'print.double' : 'print.single'),
    ...(job.pages ? [pagesText(job.pages)] : []),
    copiesText(job.copies),
    // The number that actually empties the paper tray.
    ...(jobSheets(job) != null ? [sheetsText(jobSheets(job))] : [])
  ].join(' · ');
}

/**
 * What a colleague who did not send the request is allowed to read.
 * A sentence, and never a filename.
 */
export function publicPrintLine(requesterName, title, files = 1) {
  const who = String(requesterName ?? '').trim();
  const what = String(title ?? '').trim();
  const n = Number(files) || 1;
  if (n > 1) return t('print.publicMany', { name: who, n });
  return what
    ? t('print.publicTitled', { name: who, title: what })
    : t('print.publicPlain', { name: who });
}
