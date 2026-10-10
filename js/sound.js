/**
 * The sound a new request makes.
 *
 * WHY THIS EXISTS
 * ---------------
 * A notification that arrives while the console is open and on screen is
 * deliberately quiet: it becomes a toast, not an operating-system
 * banner, because banners over a window you are already looking at are
 * noise. The cost of that is a request can land while Haitham is three
 * feet away looking at something else and nothing announces it.
 *
 * So: a sound, chosen by whoever uses the device.
 *
 * WHAT A WEB APP CAN AND CANNOT DO
 * --------------------------------
 * It can play any audio file it likes while a tab of the app is alive,
 * visible or hidden. It cannot change the sound an operating-system
 * notification makes when the app is fully closed - Windows and Android
 * own that one, and no web API offers it. So this sound is "while the
 * app is running", and the file never leaves the device.
 *
 * STORAGE
 * -------
 * IndexedDB, as a Blob. localStorage holds strings and caps out around
 * five megabytes; an audio file is binary and wants neither. The choice
 * is per device on purpose - a phone and a desktop sit in different
 * rooms and want different volumes of attention.
 */

const DB_NAME = 'wih-sound';
const STORE = 'files';
const KEY = 'alert';

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function open() {
  return new Promise((resolve, reject) => {
    // Private windows and blocked site data both throw here rather than
    // returning null, so every caller treats a failure as "no sound".
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(request?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

/** The stored file, or null. Never throws: no sound is a fine answer. */
export async function storedSound() {
  try {
    return (await withStore('readonly', store => store.get(KEY))) ?? null;
  } catch (err) {
    console.warn('[sound] could not read', err);
    return null;
  }
}

export const MAX_SOUND_BYTES = 2 * 1024 * 1024;   // 2 MB is a long chime

/**
 * Stores the chosen file. Returns the record so the caller can show its
 * name without reading it back.
 */
export async function saveSound(file) {
  if (!file) throw new Error('No file chosen.');
  if (!/^audio\//.test(file.type) && !/\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name)) {
    throw new Error('That is not an audio file.');
  }
  if (file.size > MAX_SOUND_BYTES) {
    throw new Error('Please choose a sound under 2 MB.');
  }

  // Blob, not File: a File carries a path-ish name that some browsers
  // decline to structured-clone into IndexedDB.
  const record = {
    name: file.name,
    type: file.type || 'audio/mpeg',
    size: file.size,
    blob: new Blob([await file.arrayBuffer()], { type: file.type || 'audio/mpeg' })
  };
  await withStore('readwrite', store => store.put(record, KEY));
  cached = null;
  return record;
}

export async function clearSound() {
  try {
    await withStore('readwrite', store => store.delete(KEY));
  } catch (err) {
    console.warn('[sound] could not clear', err);
  }
  revoke();
  cached = null;
}

/* ------------------------------------------------------------------ */
/* Playing                                                             */
/* ------------------------------------------------------------------ */

let cached = null;          // { url, audio } for the chosen file
let unlocked = false;       // has the user interacted with the page yet

function revoke() {
  if (cached?.url) URL.revokeObjectURL(cached.url);
  cached = null;
}

/**
 * Browsers refuse to play audio until the person has interacted with the
 * page. The console is behind a sign-in, so that has always happened by
 * the time a request arrives - but a reloaded tab left open overnight
 * has not, so the first gesture after any load re-arms it.
 */
export function armOnFirstGesture() {
  if (unlocked) return;
  const arm = () => {
    unlocked = true;
    document.removeEventListener('pointerdown', arm);
    document.removeEventListener('keydown', arm);
  };
  document.addEventListener('pointerdown', arm, { once: true });
  document.addEventListener('keydown', arm, { once: true });
}

/**
 * The fallback: a short two-tone chime built in the browser, so the
 * feature works before anybody has chosen a file. Deliberately plain -
 * it is a doorbell, not a ringtone.
 */
function chime() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;
  try {
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [[880, 0], [1320, 0.16]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // A hard start and stop clicks; a short ramp does not.
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.24);
    });
    setTimeout(() => ctx.close().catch(() => {}), 900);
    return true;
  } catch (err) {
    console.warn('[sound] chime failed', err);
    return false;
  }
}

/**
 * Plays the alert. Resolves to what actually happened, so a settings
 * screen can tell the difference between "played" and "the browser
 * refused" instead of claiming success either way.
 */
export async function playAlert() {
  const record = await storedSound();

  if (!record?.blob) {
    return chime() ? 'chime' : 'blocked';
  }

  try {
    if (!cached) {
      const url = URL.createObjectURL(record.blob);
      cached = { url, audio: new Audio(url) };
      cached.audio.preload = 'auto';
    }
    cached.audio.currentTime = 0;
    await cached.audio.play();
    return 'file';
  } catch (err) {
    // Autoplay refusal, or a format this browser cannot decode. Either
    // way something should still be audible.
    console.warn('[sound] falling back to the chime', err);
    return chime() ? 'chime' : 'blocked';
  }
}
