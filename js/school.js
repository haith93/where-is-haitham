/**
 * The school's class structure.
 *
 * WHERE IT COMES FROM
 * -------------------
 * `public.school_grades`, seeded from the school's own spreadsheet. It is
 * data, not code: next year's structure is an edit in the database, not a
 * release of this file. Nothing here knows the name of a single grade.
 *
 * THE SHAPE
 * ---------
 *     Section  ->  Level  ->  Grade
 *
 * Three levels, because that is all the spreadsheet contains. There is no
 * class (A/B/C) in it, so none is invented here. If one is added later it
 * becomes a fourth column on the table and a fourth dropdown; the cascade
 * below is written so that is an addition rather than a rewrite.
 *
 * The rows are read once and cached for the life of the page. They change
 * perhaps once a year.
 */
import { sb } from './supabase.js';
import { getLang } from './i18n.js';

let cache = null;
let inFlight = null;

/** Every active grade, ordered as the spreadsheet orders them. */
export async function getGrades() {
  if (cache) return cache;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const { data, error } = await sb
      .from('school_grades')
      .select('id, section, section_ar, level_name, level_name_ar, grade_name, grade_name_ar, display_order')
      .eq('active', true)
      .order('display_order', { ascending: true });

    inFlight = null;
    if (error) {
      // A pending migration must not take the whole print form down; the
      // destination simply stays empty and the request still goes through.
      console.warn('[school]', error.message);
      cache = [];
      return cache;
    }
    cache = data ?? [];
    return cache;
  })();

  return inFlight;
}

/** Drop the cache, e.g. after an administrator edits the structure. */
export function invalidateGrades() {
  cache = null;
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/*                                                                     */
/* Same rule the rest of the application uses for data that carries two */
/* names: show the one for the language on screen, fall back to the     */
/* other rather than render blank.                                      */
/* ------------------------------------------------------------------ */

const pick = (en, ar) => {
  if (getLang() === 'ar') return (ar ?? '').trim() || en || '';
  return (en ?? '').trim() || ar || '';
};

export const sectionLabel = row => pick(row?.section, row?.section_ar);
export const levelLabel   = row => pick(row?.level_name, row?.level_name_ar);
export const gradeLabel   = row => pick(row?.grade_name, row?.grade_name_ar);

/* ------------------------------------------------------------------ */
/* The cascade                                                         */
/*                                                                     */
/* Each step narrows the rows and then reports the distinct values of   */
/* the next column, in the spreadsheet's own order. Deriving the lists  */
/* from the rows rather than keeping three separate tables is what      */
/* makes an impossible combination unselectable: a level only appears   */
/* if some grade actually has it.                                       */
/* ------------------------------------------------------------------ */

/** Distinct values of `key`, first-seen order, with a label for each. */
function distinct(rows, key, label) {
  const seen = new Map();
  for (const row of rows) {
    const value = row[key];
    if (value && !seen.has(value)) seen.set(value, { value, label: label(row) });
  }
  return [...seen.values()];
}

export const sectionsOf = rows => distinct(rows, 'section', sectionLabel);

export const levelsOf = (rows, section) =>
  distinct(rows.filter(r => r.section === section), 'level_name', levelLabel);

export const gradesOf = (rows, section, level) =>
  rows
    .filter(r => r.section === section && r.level_name === level)
    .map(r => ({ value: r.id, label: gradeLabel(r) }));

/** One row by id, for showing what was chosen. */
export const gradeById = (rows, id) => rows.find(r => r.id === id) ?? null;

/**
 * "LS → Cycle Two → الخامس", for a card or a report line.
 * Takes the snapshot columns from a print job, not a live row, so a grade
 * renamed next year does not rewrite what last term's report says.
 */
export function destinationText(job) {
  if (!job) return '';
  return [job.section, job.level, job.grade].filter(Boolean).join(' → ');
}
