/**
 * Configuration data: buildings, tasks, settings and users.
 *
 * Buildings and tasks are cached in memory for the lifetime of the page
 * because they change rarely; Realtime invalidates the cache whenever an
 * administrator edits them, so nothing here ever goes stale.
 */
import { sb, errorMessage } from './supabase.js';
import { getLang } from './i18n.js';

const cache = { buildings: null, tasks: null, settings: null };

/**
 * The name to show for a building or task in the current language.
 *
 * These are DATA, not interface strings, so they live in the database
 * with an optional Arabic name beside the English one. Where no Arabic
 * name has been entered the English one is used, so a list can never
 * render blank.
 */
export function localName(row) {
  if (!row) return '';
  if (getLang() === 'ar') {
    const ar = (row.name_ar ?? '').trim();
    if (ar) return ar;
  }
  return row.name ?? '';
}

function fail(error, fallback) {
  throw new Error(errorMessage(error, fallback));
}

/* ------------------------------------------------------------------ */
/* Buildings                                                           */
/* ------------------------------------------------------------------ */

export async function getBuildings({ activeOnly = false, force = false } = {}) {
  if (force || !cache.buildings) {
    const { data, error } = await sb
      .from('buildings')
      .select('id, name, name_ar, active, display_order')
      .order('display_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) fail(error, 'Could not load the list of buildings.');
    cache.buildings = data ?? [];
  }
  return activeOnly ? cache.buildings.filter(b => b.active) : cache.buildings;
}

export async function addBuilding(name, nameAr = null) {
  const clean = validateName(name, 'building');
  const cleanAr = optionalName(nameAr, 'building');
  const all = await getBuildings({ force: true });
  const nextOrder = all.length ? Math.max(...all.map(b => b.display_order)) + 1 : 1;

  const { data, error } = await sb
    .from('buildings')
    .insert({ name: clean, name_ar: cleanAr, display_order: nextOrder })
    .select()
    .single();
  if (error) fail(error, 'Could not add the building.');

  cache.buildings = null;
  return data;
}

export async function updateBuilding(id, patch) {
  if (patch.name != null) patch.name = validateName(patch.name, 'building');
  if (patch.name_ar !== undefined) patch.name_ar = optionalName(patch.name_ar, 'building');
  const { data, error } = await sb.from('buildings').update(patch).eq('id', id).select().single();
  if (error) fail(error, 'Could not save the building.');
  cache.buildings = null;
  return data;
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export async function getTasks({ activeOnly = false, force = false } = {}) {
  if (force || !cache.tasks) {
    const { data, error } = await sb
      .from('tasks')
      .select('id, name, name_ar, active, display_order')
      .order('display_order', { ascending: true })
      .order('name', { ascending: true });
    if (error) fail(error, 'Could not load the list of tasks.');
    cache.tasks = data ?? [];
  }
  return activeOnly ? cache.tasks.filter(t => t.active) : cache.tasks;
}

export async function addTask(name, nameAr = null) {
  const clean = validateName(name, 'task');
  const cleanAr = optionalName(nameAr, 'task');
  const all = await getTasks({ force: true });
  const nextOrder = all.length ? Math.max(...all.map(t => t.display_order)) + 1 : 1;

  const { data, error } = await sb
    .from('tasks')
    .insert({ name: clean, name_ar: cleanAr, display_order: nextOrder })
    .select()
    .single();
  if (error) fail(error, 'Could not add the task.');

  cache.tasks = null;
  return data;
}

export async function updateTask(id, patch) {
  if (patch.name != null) patch.name = validateName(patch.name, 'task');
  if (patch.name_ar !== undefined) patch.name_ar = optionalName(patch.name_ar, 'task');
  const { data, error } = await sb.from('tasks').update(patch).eq('id', id).select().single();
  if (error) fail(error, 'Could not save the task.');
  cache.tasks = null;
  return data;
}

/* ------------------------------------------------------------------ */
/* Ordering (shared by both lists)                                     */
/* ------------------------------------------------------------------ */

/**
 * Moves one row up or down and writes the new display_order for the pair.
 * @param {'buildings'|'tasks'} table
 */
export async function moveItem(table, id, direction) {
  const rows = table === 'buildings' ? await getBuildings({ force: true }) : await getTasks({ force: true });
  const index = rows.findIndex(r => r.id === id);
  const swapWith = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || swapWith < 0 || swapWith >= rows.length) return;

  const a = rows[index];
  const b = rows[swapWith];

  // display_order can contain duplicates from manual seeding, so rewrite
  // both rows with their positions rather than swapping the stored values.
  const updates = [
    sb.from(table).update({ display_order: swapWith + 1 }).eq('id', a.id),
    sb.from(table).update({ display_order: index + 1 }).eq('id', b.id)
  ];
  const results = await Promise.all(updates);
  const bad = results.find(r => r.error);
  if (bad) fail(bad.error, 'Could not change the order.');

  cache[table] = null;
}

/** Arabic names are optional; blank means "fall back to English". */
function optionalName(value, what) {
  const clean = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  if (clean.length > 80) throw new Error(`That ${what} name is too long (80 characters maximum).`);
  return clean;
}

function validateName(value, what) {
  const clean = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (clean.length < 1) throw new Error(`Please type a ${what} name.`);
  if (clean.length > 80) throw new Error(`That ${what} name is too long (80 characters maximum).`);
  return clean;
}

/** Called by the realtime layer when buildings/tasks change anywhere. */
export function invalidate(which) {
  if (which) cache[which] = null;
  else { cache.buildings = null; cache.tasks = null; cache.settings = null; }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export async function getSettings({ force = false } = {}) {
  if (force || !cache.settings) {
    const { data, error } = await sb.from('app_settings').select('key, value');
    if (error) {
      // Settings are not critical for rendering — fall back to defaults.
      console.warn('settings', error);
      return { ...DEFAULT_SETTINGS };
    }
    cache.settings = { ...DEFAULT_SETTINGS, ...Object.fromEntries((data ?? []).map(r => [r.key, r.value])) };
  }
  return cache.settings;
}

export const DEFAULT_SETTINGS = Object.freeze({
  org_name: 'Our Organisation',
  tracked_person: 'Haitham',
  quick_durations: [5, 10, 15, 20, 30, 45, 60, 120],
  workday_start_hour: 7,
  workday_end_hour: 16
});

export async function saveSetting(key, value) {
  const { error } = await sb.from('app_settings').upsert({ key, value }, { onConflict: 'key' });
  if (error) fail(error, 'Could not save that setting.');
  cache.settings = null;
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

export async function getUsers() {
  const { data, error } = await sb
    .from('profiles')
    .select('id, full_name, email, role, active, created_at')
    .order('role', { ascending: true })
    .order('full_name', { ascending: true });
  if (error) fail(error, 'Could not load the list of users.');
  return data ?? [];
}

export async function setUserActive(userId, active) {
  const { data, error } = await sb.rpc('admin_set_user_active', { p_user_id: userId, p_active: active });
  if (error) fail(error, 'Could not change that account.');
  return data;
}

export async function setUserRole(userId, role) {
  const { data, error } = await sb.rpc('admin_set_user_role', { p_user_id: userId, p_role: role });
  if (error) fail(error, 'Could not change that role.');
  return data;
}

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

export async function getAuditLog(limit = 60) {
  const { data, error } = await sb
    .from('audit_log')
    .select('id, action, entity, details, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail(error, 'Could not load the activity log.');
  return data ?? [];
}
