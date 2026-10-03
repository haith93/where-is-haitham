/**
 * Playful status messages — all of them, in one place.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * These lines are the one part of the interface whose wording is meant
 * to be fiddled with: a joke that lands in March is tired by June, and
 * whoever edits it should not have to go hunting through render
 * functions to find where a sentence was written. Everything playful
 * lives here; nothing playful is written anywhere else.
 *
 * TO EDIT
 * -------
 * Change the `en` and `ar` strings below. Nothing else needs touching.
 *
 * TO ADD A MESSAGE
 * ----------------
 * Add a key with `en` and `ar`, then read it with
 * `statusMessage('yourKey')`. An unknown key returns an empty string, so
 * a half-finished entry degrades to silence rather than to "undefined"
 * on a colleague's screen.
 *
 * HOUSE RULES
 * -----------
 * Short enough to read at a glance. Playful, never sarcastic at the
 * expense of the person reading it — somebody whose classroom projector
 * just died is not in the mood to be teased. The Arabic is written to be
 * funny in Arabic, not translated word for word from the English; the
 * two sides of a row say the same thing, they do not say it the same way.
 *
 * And the joke never replaces the fact. The urgency label and the real
 * status are always shown next to these lines, never instead of them.
 */
import { getLang } from './i18n.js';

export const STATUS_MESSAGES = Object.freeze({
  /* ---- Urgency, as chosen on the request form ---------------------- */
  normal: {
    en: 'Normal?! 😳',
    ar: 'عادي يعني؟ 😳'
  },
  urgent: {
    en: "Okay, we're moving!",
    ar: 'تمام، صرنا نتحرّك!'
  },
  veryUrgent: {
    en: 'Alright, this is getting serious.',
    ar: 'طيب، القصة صارت جدّية.'
  },
  lifeDeath: {
    en: 'DROP EVERYTHING.',
    ar: 'كل شيء يتوقّف الآن.'
  },

  /* ---- Availability, shown on the board ---------------------------- */
  available: {
    en: 'Free right now — go ahead.',
    ar: 'فاضي الآن، تفضّل.'
  },
  office: {
    en: 'In the office. Coffee mode. ☕',
    ar: 'في المكتب ـ وضع القهوة ☕'
  },
  busy: {
    en: 'Hands full at the moment.',
    ar: 'يديه مشغولة حالياً.'
  },
  traveling: {
    en: 'On the move between buildings.',
    ar: 'بين المباني الآن.'
  },
  meeting: {
    en: 'In a meeting. Back soon.',
    ar: 'في اجتماع. يرجع قريباً.'
  },
  offsite: {
    en: 'Out of the complex today.',
    ar: 'خارج المجمّع اليوم.'
  },
  done: {
    en: 'Day finished. See you tomorrow.',
    ar: 'انتهى الدوام. نراكم غداً.'
  }
});

/** The database spells urgency with underscores; this table does not. */
const PRIORITY_KEYS = Object.freeze({
  normal:      'normal',
  urgent:      'urgent',
  very_urgent: 'veryUrgent',
  life_death:  'lifeDeath'
});

/**
 * One message in the language currently on screen.
 * Returns '' for an unknown key, so a missing entry shows nothing at all
 * rather than breaking the line it sits in.
 */
export function statusMessage(key) {
  const row = STATUS_MESSAGES[key];
  if (!row) return '';
  return row[getLang()] ?? row.en ?? '';
}

/** The quip for a database priority value, e.g. 'very_urgent'. */
export function priorityMessage(priority) {
  return statusMessage(PRIORITY_KEYS[priority] ?? '');
}

/** The quip for a status type, e.g. 'available'. 'break' is coffee. */
export function availabilityMessage(statusType) {
  return statusMessage(statusType === 'break' ? 'office' : statusType);
}
