/**
 * Shared helpers: timezone-correct formatting, small DOM utilities.
 *
 * TIME RULES FOR THIS APP
 * -----------------------
 *  * Everything is stored in UTC (timestamptz) and produced by the
 *    database, never by the browser clock.
 *  * Everything is displayed in Asia/Beirut using Intl, so daylight
 *    saving is handled by the platform. We never add or subtract a
 *    fixed number of hours anywhere.
 */
import { CONFIG } from './config.js';

const TZ = CONFIG.timezone;

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const fmtCache = new Map();
function formatter(options) {
  const key = JSON.stringify(options);
  if (!fmtCache.has(key)) {
    fmtCache.set(key, new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...options }));
  }
  return fmtCache.get(key);
}

export function toDate(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "12:30 PM" */
export function fmtTime(value) {
  const d = toDate(value);
  return d ? formatter({ hour: 'numeric', minute: '2-digit', hour12: true }).format(d) : '--:--';
}

/** "12:30:07 PM" — used for the live clock only. */
export function fmtClock(value) {
  const d = toDate(value) || new Date();
  return formatter({ hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(d);
}

/** "September 13, 2026" */
export function fmtDateLong(value) {
  const d = toDate(value);
  return d ? formatter({ year: 'numeric', month: 'long', day: 'numeric' }).format(d) : '';
}

/** "Sun 13 Sep" */
export function fmtDateShort(value) {
  const d = toDate(value);
  return d ? formatter({ weekday: 'short', day: 'numeric', month: 'short' }).format(d) : '';
}

/** "13 Sep, 12:30 PM" */
export function fmtDateTime(value) {
  const d = toDate(value);
  if (!d) return '';
  return `${formatter({ day: 'numeric', month: 'short' }).format(d)}, ${fmtTime(d)}`;
}

/** "12:30 PM → 12:40 PM" (or just the start when there is no end). */
export function fmtRange(start, end) {
  if (!start) return '';
  return end ? `${fmtTime(start)} → ${fmtTime(end)}` : fmtTime(start);
}

/** Weekday name in the organisation timezone, e.g. "Monday". */
export function weekdayName(value) {
  const d = toDate(value);
  return d ? formatter({ weekday: 'long' }).format(d) : '';
}

/* ------------------------------------------------------------------ */
/* Timezone-correct day arithmetic                                     */
/* ------------------------------------------------------------------ */

/** Milliseconds that `tz` is ahead of UTC at the given instant. */
function tzOffsetMs(date, tz = TZ) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
  );
  return asUTC - date.getTime();
}

/**
 * Converts a wall-clock time in Asia/Beirut into a real UTC instant.
 * Two passes so that days containing a DST change still resolve exactly.
 */
export function zonedToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = tzOffsetMs(new Date(naive));
  offset = tzOffsetMs(new Date(naive - offset));
  return new Date(naive - offset);
}

/** "2026-09-13" for the given instant, in the organisation timezone. */
export function dayKey(value = new Date()) {
  const d = toDate(value) || new Date();
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d).map(x => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

/** Parses "2026-09-13" into its parts. */
export function parseDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { year: y, month: m, day: d };
}

/** Midnight (inclusive) at the start of a local day, as a UTC instant. */
export function startOfDay(key) {
  const { year, month, day } = parseDayKey(key);
  return zonedToUtc(year, month, day, 0, 0, 0);
}

/** Midnight (exclusive) at the end of a local day, as a UTC instant. */
export function endOfDay(key) {
  const { year, month, day } = parseDayKey(key);
  return zonedToUtc(year, month, day + 1, 0, 0, 0);
}

/** Local day key shifted by N days. */
export function addDays(key, days) {
  const { year, month, day } = parseDayKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Monday of the week containing `key` (weeks start Monday). */
export function startOfWeek(key) {
  const { year, month, day } = parseDayKey(key);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return addDays(key, dow === 0 ? -6 : 1 - dow);
}

/** First day of the month containing `key`. */
export function startOfMonth(key) {
  const { year, month } = parseDayKey(key);
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/** Last day of the month containing `key`. */
export function endOfMonth(key) {
  const { year, month } = parseDayKey(key);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/** Inclusive list of day keys between two day keys. */
export function daysBetween(fromKey, toKey) {
  const out = [];
  let cur = fromKey;
  let guard = 0;
  while (cur <= toKey && guard++ < 400) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Durations                                                           */
/* ------------------------------------------------------------------ */

/** 85 -> "1h 25m", 45 -> "45m", 0 -> "0m" */
export function durationText(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return '—';
  const total = Math.max(0, Math.round(Number(minutes)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Whole minutes between two instants. */
export function minutesBetween(a, b) {
  const from = toDate(a);
  const to = toDate(b);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / 60000);
}

/** "in 8 min" / "3 min ago" / "just now" */
export function relativeTime(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return '';
  const diffMin = Math.round((d.getTime() - now.getTime()) / 60000);
  const abs = Math.abs(diffMin);
  if (abs < 1) return 'just now';
  const unit = abs < 60 ? `${abs} min` : abs < 1440 ? durationText(abs) : `${Math.round(abs / 1440)} day${abs >= 2880 ? 's' : ''}`;
  return diffMin > 0 ? `in ${unit}` : `${unit} ago`;
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escapes anything that is going to be dropped into innerHTML. */
export function esc(value) {
  if (value == null) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function debounce(fn, wait = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** Local UI preferences only. Never application data. */
export const prefs = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`wih.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`wih.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
  },
  remove(key) {
    try { localStorage.removeItem(`wih.${key}`); } catch { /* ignore */ }
  }
};

/** CSV that survives Excel: quoted fields, BOM, CRLF. */
export function toCSV(rows) {
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
}

export function downloadFile(filename, contents, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
