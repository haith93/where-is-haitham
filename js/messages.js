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

  /* ---- Availability, shown on the board ----------------------------
     Several lines per status, so the board does not say the same thing
     every day. The one shown is picked from the moment the status was
     posted, which means it is stable while a status lasts and different
     the next time he sets one - it never flickers while someone reads.
     -------------------------------------------------------------- */
  available: [
    { en: 'Free right now — go ahead.',      ar: 'فاضي الآن، تفضّل.' },
    { en: 'Chillaxing. Say the word.',        ar: 'مرتاح شوي ـ نادِ وبس.' },
    { en: 'Idle. Dangerously idle.',          ar: 'فاضي… فاضي لدرجة خطيرة.' },
    { en: 'Nothing on. Bring it over.',       ar: 'ما في شي عندي، هاته.' }
  ],
  /* Free, but with somebody already waiting. "Available" on its own
     reads as "nobody has asked", which is the opposite of the truth
     when there is a queue. */
  nextUp: [
    { en: "Just finished one — next in line, you’re up.",
      ar: 'خلّص واحدة ـ اللي بعده، دورك.' },
    { en: 'Hands free. Reaching for the next one.',
      ar: 'يديه فاضية. رايح على اللي بعده.' },
    { en: 'One down. Who is next?',
      ar: 'واحدة خلصت. مين التالي؟' },
    { en: 'Between jobs — the queue is moving.',
      ar: 'بين مهمتين ـ الدور ماشي.' }
  ],
  office: [
    { en: 'In the office. Coffee mode. ☕',   ar: 'في المكتب ـ وضع القهوة ☕' },
    { en: 'Taking a breath. One minute.',     ar: 'ياخد نفس. دقيقة وبرجع.' },
    { en: 'Five minutes of peace, then anything.', ar: 'خمس دقائق هدوء، وبعدها أي شي.' }
  ],
  busy: [
    { en: 'Hands full at the moment.',        ar: 'يديه مشغولة حالياً.' },
    { en: 'Deep in something. Queue up.',     ar: 'غارق بالشغل ـ احجز دورك.' }
  ],
  serving: [
    { en: 'One at a time.',                   ar: 'واحد واحد.' },
    { en: 'Mid-job. Nearly there.',           ar: 'بنص المهمة، قرّب يخلص.' }
  ],
  traveling: [
    { en: 'On the move between buildings.',   ar: 'بين المباني الآن.' },
    { en: 'Somewhere in a corridor.',         ar: 'في مكان ما بالممرات.' }
  ],
  meeting: [
    { en: 'In a meeting. Back soon.',         ar: 'في اجتماع. يرجع قريباً.' },
    { en: 'Trapped in a meeting.',            ar: 'محجوز في اجتماع.' }
  ],
  offsite: [
    { en: 'Out of the complex today.',        ar: 'خارج المجمّع اليوم.' }
  ],
  done: [
    { en: 'Day finished. See you tomorrow.',  ar: 'انتهى الدوام. نشوفكم بكرة.' },
    { en: "Shop's closed. Tomorrow, promise.", ar: 'سكّرنا اليوم ـ بكرة، وعد.' }
  ]
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
export function statusMessage(key, seed = 0) {
  const row = STATUS_MESSAGES[key];
  if (!row) return '';
  // A key holds either one line or several. With several, `seed` chooses;
  // callers pass something stable, so the line does not change under a
  // reader's eyes.
  const line = Array.isArray(row) ? row[Math.abs(seed) % row.length] : row;
  return line?.[getLang()] ?? line?.en ?? '';
}

/** The quip for a database priority value, e.g. 'very_urgent'. */
export function priorityMessage(priority) {
  return statusMessage(PRIORITY_KEYS[priority] ?? '');
}

/**
 * The quip for a status type, e.g. 'available'. 'break' is coffee.
 * @param {string} statusType
 * @param {string|number|Date} [since]  when the status was posted. Any two
 *        calls with the same value get the same line, so it is steady for
 *        as long as the status is, and different the next time.
 */
export function availabilityMessage(statusType, since = 0, { waiting = 0 } = {}) {
  // Free with a queue behind it is a different sentence from free with
  // an empty one, and the board should not read as "nobody has asked"
  // while four people are waiting.
  const key = statusType === 'break' ? 'office'
            : statusType === 'available' && waiting > 0 ? 'nextUp'
            : statusType;
  const ms = since ? new Date(since).getTime() : 0;
  // Minutes, not milliseconds: two statuses posted in the same minute
  // should not be forced to differ, and the arithmetic stays small.
  const seed = Number.isFinite(ms) ? Math.floor(ms / 60000) : 0;
  return statusMessage(key, seed);
}
