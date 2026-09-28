/**
 * Interface skins.
 *
 * A skin is a stylesheet scoped to `:root[data-skin="<id>"]` plus an entry
 * in the registry below. Nothing else knows any skin by name, so adding a
 * third one is: write `css/<id>.css`, link it from the pages, add an entry
 * here. The settings screen, the validation and the storage all follow.
 *
 * WHERE THE CHOICE COMES FROM
 * ---------------------------
 * 1. A per-device override, if someone set one. Lets a person try a skin,
 *    or stay on the old one, without affecting anybody else.
 * 2. The site-wide setting `ui_skin`, which the administrator controls and
 *    everyone sees.
 * 3. DEFAULT_SKIN, baked in so the very first paint is already correct.
 *
 * The resolved value is cached in localStorage and applied synchronously
 * at start-up, because waiting for the settings query would show one skin
 * and then swap to another.
 */
import { prefs } from './utils.js';

export const DEFAULT_SKIN = 'brutal';

/**
 * `stylesheet` is documentation rather than machinery: the pages link
 * every skin's CSS up front and each file is inert until its attribute is
 * set. Listing it here keeps the registry the single place that describes
 * a skin.
 */
export const SKINS = Object.freeze({
  standard: {
    id: 'standard',
    labelKey: 'admin.skinStandard',
    descriptionKey: 'admin.skinStandardHint',
    stylesheet: null            // the base stylesheets are the standard look
  },
  brutal: {
    id: 'brutal',
    labelKey: 'admin.skinBrutal',
    descriptionKey: 'admin.skinBrutalHint',
    stylesheet: 'css/brutal.css'
  }
});

export const SKIN_IDS = Object.freeze(Object.keys(SKINS));

export const isSkin = id => Object.prototype.hasOwnProperty.call(SKINS, id);

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

const OVERRIDE_KEY = 'skinOverride';   // this device only, or null
const CACHE_KEY = 'skinCache';         // last known site-wide value

/** null means "follow whatever the site is set to". */
export function getDeviceOverride() {
  const value = prefs.get(OVERRIDE_KEY, null);
  return isSkin(value) ? value : null;
}

export function setDeviceOverride(id) {
  if (id == null) prefs.remove(OVERRIDE_KEY);
  else if (isSkin(id)) prefs.set(OVERRIDE_KEY, id);
  applySkin(resolveSkin());
  return getDeviceOverride();
}

export const getCachedSiteSkin = () => {
  const value = prefs.get(CACHE_KEY, null);
  return isSkin(value) ? value : null;
};

export function cacheSiteSkin(id) {
  if (isSkin(id)) prefs.set(CACHE_KEY, id);
}

/* ------------------------------------------------------------------ */
/* Resolution and application                                          */
/* ------------------------------------------------------------------ */

/** The skin that should be showing right now. */
export function resolveSkin(siteSkin = null) {
  return getDeviceOverride()
    ?? (isSkin(siteSkin) ? siteSkin : null)
    ?? getCachedSiteSkin()
    ?? DEFAULT_SKIN;
}

/** Writes the attribute the stylesheets key off. */
export function applySkin(id) {
  const skin = isSkin(id) ? id : DEFAULT_SKIN;
  const root = document.documentElement;

  // 'standard' is the absence of a skin: the base stylesheets already
  // describe it, so no attribute is set.
  if (skin === 'standard') delete root.dataset.skin;
  else root.dataset.skin = skin;

  return skin;
}

/**
 * Call once, before anything renders. Uses the cached value so the first
 * paint is right; the server value is reconciled afterwards.
 */
export function initSkin() {
  return applySkin(resolveSkin());
}

/**
 * Call once the settings have loaded. Re-applies only when the site skin
 * actually changed, so there is no pointless repaint.
 */
export function syncSkinFromSettings(settings) {
  const siteSkin = isSkin(settings?.ui_skin) ? settings.ui_skin : DEFAULT_SKIN;
  const changed = siteSkin !== getCachedSiteSkin();
  cacheSiteSkin(siteSkin);
  if (changed) applySkin(resolveSkin(siteSkin));
  return siteSkin;
}
